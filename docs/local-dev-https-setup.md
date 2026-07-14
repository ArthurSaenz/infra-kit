# Local dev over HTTPS (portless)

`infra-kit dev` serves every app at a stable, **port-free HTTPS** URL:

```
https://<release>.<packageName>.localhost
```

`<release>` is your slugified git branch, so N worktrees run side by side without colliding and without
anyone memorising a port. There is **no** `http://localhost:<port>` mode and no port fallback — a port in
the URL is the thing this design removes.

## One-time machine setup

Two commands. Only the first needs root. **Get them from `infra-kit doctor`** — it prints them ready to
paste, with the paths already filled in for your machine:

```bash
infra-kit doctor
```

On an un-provisioned machine it prints the two fixes, which look like this (your paths will differ):

```bash
sudo /opt/homebrew/bin/node /repo/node_modules/portless/dist/cli.js service install   # launchd daemon on :443
/opt/homebrew/bin/node /repo/node_modules/portless/dist/cli.js trust                  # local CA → login keychain, NO sudo
```

Doctor verifies both, tells you exactly which one is missing, and never runs the privileged one for you.

### Why not just `portless service install`?

Because there is no `portless` on your `PATH` to run. portless is an ordinary npm **dependency of
infra-kit**, living in `node_modules` — `node_modules/.bin` is only on `PATH` inside a pnpm/npm script, not
in your shell. So a bare `portless …` gives you `command not found`.

`sudo` makes it strictly worse: it discards your `PATH` and substitutes `secure_path`
(`/usr/bin:/bin:/usr/sbin:/sbin` on macOS). **This is also why `npm i -g portless` does not fix it** — a
global install lands in `/opt/homebrew/bin`, which is not on `secure_path`, so `sudo portless …` still fails.
It would also give you a _second_, differently-versioned portless, while infra-kit's driver keeps using the
one it pins.

The commands above sidestep all of that by naming the interpreter and portless's own `cli.js` by absolute
path — which is exactly how `infra-kit dev` invokes portless internally.

This is also why the _exact_ command matters rather than any command that happens to work: `service install`
copies the interpreter and script path it was invoked with **verbatim into the launchd plist**. Whatever you
paste is what runs as a root daemon. (A consequence worth knowing: the plist ends up pinned to a
version-specific node path such as `/opt/homebrew/Cellar/node/26.0.0/bin/node` and to one repo's
`node_modules`. A `brew cleanup` after a node upgrade, or deleting that checkout, leaves the daemon flapping
— `infra-kit doctor` detects it, because it probes the daemon on the wire rather than trusting a state file,
and reprints the install command with fresh paths.)

### Why `:443` needs root

A port-free `https://` URL can only be served from the implicit HTTPS port, and binding a port below 1024
requires root. `infra-kit dev` **probes** `:443` and never elevates: portless binds it by re-execing itself
through `sudo` with an inherited TTY, which a detached child process can never answer — it would hang and
then report a daemon that never came up. So the install is one-time and out-of-band.

### Why `portless trust` is separate

The daemon serves a certificate signed by a **private CA** that portless generates on your machine. Your
browser will reject it until that CA is in your trust store. `portless trust` is a per-user operation
(login keychain) and needs no sudo — unlike the install, which does.

`infra-kit doctor` **reports only**; it never runs either command for you. Both are one-liners you paste
yourself, and it prints the exact one you need.

Re-run the `trust` command if portless ever regenerates its CA (a version upgrade can). Doctor detects this
by comparing `sha256(~/.portless/ca.pem)` against the fingerprint in `~/.portless/ca.trusted`, and prints the
command to paste.

## Non-browser clients need the CA

Node does **not** read the macOS keychain, so `portless trust` alone does not help a Node process. Anything
that calls a hero URL outside the browser — a backend calling a sibling service, a `fetch` in a script, an
e2e runner — must be told about the CA:

```bash
export NODE_EXTRA_CA_CERTS="$HOME/.portless/ca.pem"
```

`infra-kit dev` already injects this into the dev children it spawns. You need it for processes it does not
own. In Postman, import `~/.portless/ca.pem` under Settings → Certificates.

Vite's own proxy is handled separately: `infraKitDev()` sets `secure: false` **only** for `.localhost` and
loopback targets, so cert validation is relaxed exactly where the target is provably local, and nowhere else.

## Troubleshooting

| Symptom                                                      | Cause                                                                                              | Fix                                                                                                      |
| ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `sudo: portless: command not found`                          | You typed a bare `portless`; it is not on `PATH`, and sudo uses `secure_path`                      | Run `infra-kit doctor` and paste the absolute-path command it prints (see above)                         |
| `dev` refuses: _no portless daemon is serving HTTPS on :443_ | The daemon was never installed                                                                     | The `service install` line printed by `infra-kit doctor` (needs root)                                    |
| Browser warns the certificate is not trusted                 | CA not in your keychain, or it was regenerated                                                     | The `trust` line printed by `infra-kit doctor` (no sudo)                                                 |
| A node/e2e client fails with `SELF_SIGNED_CERT_IN_CHAIN`     | Node doesn't read the keychain                                                                     | `NODE_EXTRA_CA_CERTS=~/.portless/ca.pem`                                                                 |
| A hero URL returns **502**                                   | The proxy is up but the app behind it is gone (a stale alias from a killed run)                    | `infra-kit doctor` lists the stale routes and prints the `alias --remove <name>` command to run per name |
| `dev` refuses: _this repo pins `<pkg>` `<old>`_              | The consumer's pinned `infraKitDev` helper predates HTTPS and would proxy plain HTTP at a TLS listener | Bump the package the error names — `pnpm add -D @slip-stream-kit/config@^<floor>` (or, before migrating, `infra-kit@^<floor>`) |

A **502 is not a connection refusal** — it means the proxy answered but the upstream did not. It usually
means a stale alias outlived the process that registered it, not that the proxy is broken.

## A portless quirk worth knowing

portless's `proxy.port` / `proxy.pid` / `proxy.tls` files are **process-global singletons** — its
`resolveStateDir(_port)` ignores the port argument. Starting _any_ portless daemon rewrites them, and
stopping _any_ daemon deletes them. So those files can describe a daemon that is not the one you are
talking to.

`infra-kit` therefore never trusts them for liveness: it asks the daemon directly (`HEAD /`, asserting the
`X-Portless` response header), which is per-port ground truth. If you write tooling against portless, do the
same — a state-file check will confidently tell you a perfectly healthy daemon is dead.
