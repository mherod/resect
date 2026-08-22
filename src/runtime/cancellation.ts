/**
 * Request-scoped cancellation for child processes (#245).
 *
 * The MCP server receives an AbortSignal per request. Rather than threading
 * a signal parameter through every command, tool adapter, and pipeline
 * layer, tool registrations enter a cancellation scope and both production
 * ProcessRunners consult it: any child process spawned inside the scope is
 * bound to the request signal, so MCP cancellation reaches active child
 * processes and releases them.
 *
 * Rollback and cleanup must never be cancelled by an already-aborted
 * request signal — `withoutCancellation` gives those sections a fresh,
 * unaborted scope.
 */
import { AsyncLocalStorage } from "node:async_hooks";

const cancellationStorage = new AsyncLocalStorage<AbortSignal | undefined>();

/** Run `fn` with `signal` as the ambient cancellation signal. */
export function withCancellationSignal<T>(
	signal: AbortSignal | undefined,
	fn: () => T
): T {
	return cancellationStorage.run(signal, fn);
}

/**
 * Run `fn` with NO ambient cancellation signal, regardless of the current
 * scope. Rollback and cleanup use this so a cancelled request cannot abort
 * its own recovery.
 */
export function withoutCancellation<T>(fn: () => T): T {
	return cancellationStorage.run(undefined, fn);
}

/** The cancellation signal for the current async scope, if any. */
export function currentCancellationSignal(): AbortSignal | undefined {
	return cancellationStorage.getStore();
}

/**
 * Combine an explicit per-call signal with the ambient request signal.
 * Either aborting aborts the result. Returns undefined when neither exists.
 */
export function effectiveCancellationSignal(
	explicit?: AbortSignal
): AbortSignal | undefined {
	const ambient = currentCancellationSignal();
	if (explicit && ambient && explicit !== ambient) {
		return AbortSignal.any([explicit, ambient]);
	}
	return explicit ?? ambient;
}
