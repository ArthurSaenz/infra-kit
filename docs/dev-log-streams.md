# `infra-kit dev` output streams

An audit of every stream an `infra-kit dev` run produces, and where each one lands. It is the companion of
`apps/infra-kit/cli/src/dev/__tests__/log-streams.test.ts`, which drives each filed stream through its real
seam and asserts the line shape; `log-streams-doc.test.ts` checks that every service it covers is named
here.

## The line shape

Every dev log file under `<cacheRoot>/<session>/dev/<pid>/` is written by the runner's `DevLogSink`, built
by `createDevLogSink()` (`src/dev/log-sink.ts`), which formats through `src/dev/log-format.ts`:

```text
time LEVEL service message [extras-json]
2026-11-12T10:00:00.000Z INFO  shop/api order placed {"service":"orders","orderId":7}
```

- `time` is UTC `toISOString()`; a backend JSON record's own `time`/`timestamp` wins when it parses.
- `LEVEL` is `DEBUG`, `INFO `, `WARN ` or `ERROR`, padded to 5; `CRITICAL` reads as `ERROR`.
- Level precedence: the JSON record's own level, then the level the caller declared, then
  `turboLineLevel` for a `<pkg>:dev:` line on the `turbo` stream, else `INFO`.
- A record spanning several physical lines writes each line with the same full prefix, so a stack trace
  stays readable and still greps by service and level. A JSON record's `error.stack` is written the same
  way, as continuation lines.
- Text is sanitised before writing: `\r\n` becomes `\n`, a line redrawn with bare `\r` keeps its last
  segment (a turbo `<pkg>:dev:` line keeps its prefix in front of it), then every CSI, OSC and C0 control
  except TAB is stripped.
- The panel's error/warn counters read only the DECLARED level, never the formatted line. The runner's own
  tee is filed with `count: false`.
- The byte cap (256 MiB per service), `latest` and GC are unchanged; the `[capped]` notice is one `WARN`
  line of the same shape.

## Streams

| Stream                            | File (`service`)                           | Producer                                                                                                                  | Seam into the sink                                                                                    |
| --------------------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Renderer tee                      | `runner.log` (`runner`)                    | `DevRenderer.teeOnly` / `log`, also used by the Ink UI                                                                    | `appendRunnerLog(text, level)` in `dev-server.ts`, `count: false`                                     |
| Intercept fallback                | `runner.log` (`runner`)                    | any `console.*` or raw stdout/stderr write outside an app's async context, including the plain renderer's terminal frames | `installOutputIntercept` with `fallbackService: runner` (`dev-server.ts`, the constructor)            |
| Faults                            | the faulting app's file, else `runner.log` | `reportFault` / `fileFault`                                                                                               | direct `sink.write(..., { level: 'error' })`                                                          |
| Backend console                   | `<app>-api.log` (`<app>/api`)              | a handler's `console.*`, dev-logger / Powertools JSON, raw stdout/stderr                                                  | the same intercept, attributed by `AsyncLocalStorage` (`log-attribution.ts`)                          |
| Request log                       | `<app>-api.log` (`<app>/api`)              | `ServerlessLocalRun`'s `onRequestLog`                                                                                     | `sink.write(tag, 'METHOD path status Nms', { level })`, `error` for 5xx                               |
| Framework lines                   | `<app>-ui.log` (`<app>/ui`)                | vite/vike/astro via `turbo run dev`, parsed by `parseTurboDevLine`                                                        | `onLine` in `dev-server.ts`, level from `turboLineLevel`                                              |
| Turbo raw tee                     | `turbo.log` (`turbo`)                      | every raw line of the `turbo run dev` child, chrome included                                                              | `pumpLines`' `appendLog`, line-buffered on the one `pending` buffer                                   |
| Watch engine                      | `watch.log` (`watch`)                      | `turbo watch build` stdout and stderr                                                                                     | `defaultTurboWatchFactory`'s line-buffered `appendLog`                                                |
| Boot builds                       | `runner.log` (`runner`)                    | `launchScript` (`turbo run build`)                                                                                        | stderr only, as `debug` narration through the renderer tee; a failed build's stdout/stderr as `error` |
| `--json` / non-TTY runs           | not filed                                  | backend console and raw writes                                                                                            | no intercept is installed, so api lines go to the process's stdout/stderr                             |
| Node fatal stacks                 | not filed                                  | an uncaught throw that kills the process                                                                                  | Node writes straight to fd 2, past every patch                                                        |
| portless and dry-run subprocesses | not filed                                  | `portless` CLI calls (`proxy/portless-driver.ts`), `turbo --dry=json` (`dep-closure.ts`)                                  | `execFile`, output buffered and parsed or dropped                                                     |

## Gap decisions

| Gap                                                                                                                               | Decision                                                                                                                                         |
| --------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `turbo-watch.ts` could hand the child the log fd directly, outside the byte cap                                                   | **Fixed**: the fd branch and the `logFile`/`openLog` options are deleted; `appendLog` is required.                                               |
| The raw turbo tee forwarded pipe chunks, so a line split across reads got a second prefix, a split ANSI escape, and unparsed JSON | **Fixed**: `pumpLines` tees whole lines from its existing split loop; a partial line is flushed on `end` or past the 64 KiB `MAX_PENDING_CHARS`. |
| `--json` / non-TTY runs file no api lines                                                                                         | **Listed**. Interception there would file the machine-readable stream and break `json-output-purity.test.ts`.                                    |
| Node fatal stacks on fd 2 are not filed                                                                                           | **Listed**, for the same reason: capturing fd 2 means owning it on every run.                                                                    |
| A successful boot build's stdout is dropped                                                                                       | **Listed**.                                                                                                                                      |
