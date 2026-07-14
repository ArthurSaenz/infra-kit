/**
 * Which service is "speaking" right now, for output that arrives through a channel carrying no tag of
 * its own — a handler's `console.log`, a Powertools line, a dependency's import-time banner.
 *
 * The backend is IN-PROCESS and multi-app: `DevServerRunner` holds an `appServers` array, so several
 * apps share one node process and one global `console`. Nothing in a raw stdout write says which app
 * wrote it. An `AsyncLocalStorage` carries the tag down the async call chain from the fastify hook that
 * opened the request, so a line emitted anywhere under that request attributes correctly.
 *
 * This is INFERENCE, not declaration — the honest limit is worth stating: a module imported by two apps
 * is ONE module instance, so a timer it registers at import time keeps whichever app imported it first.
 * Anything with no context at all falls back to a NAMED bucket (`runner.log`), never to a guess.
 */
import { AsyncLocalStorage } from 'node:async_hooks'

const storage = new AsyncLocalStorage<string>()

/** Run `fn` with every line it emits attributed to `service`, however deep the async chain goes. */
export const runAttributed = <T>(service: string, fn: () => T): T => {
  return storage.run(service, fn)
}

/**
 * Enter `service`'s context for the REST of the current async chain, without wrapping a callback.
 *
 * This is the fastify shape: an `onRequest` hook must not wrap the handler (fastify owns that call),
 * but `enterWith` makes the whole remaining hook chain — handler, `onResponse`, `setErrorHandler` — a
 * continuation of this context.
 */
export const enterAttribution = (service: string): void => {
  storage.enterWith(service)
}

/** The service owning the current async context, or `undefined` outside any request / import. */
export const currentService = (): string | undefined => {
  return storage.getStore()
}
