import type { ProgressCallback } from "../types/progress.ts";

/**
 * Map over items with bounded concurrency.
 * Runs up to `limit` tasks concurrently, preserving input order in results.
 * Handled errors are isolated per-item. An unhandled failure stops scheduling
 * and propagates only after every started task settles, so callers can recover
 * without racing a writer that is still running.
 */
export async function mapConcurrent<T, R>(
	items: T[],
	fn: (item: T) => Promise<R>,
	options: {
		concurrency?: number;
		onError?: (item: T, error: unknown) => R;
		onProgress?: ProgressCallback;
	} = {}
): Promise<R[]> {
	const { concurrency = 4, onError, onProgress } = options;
	const results: R[] = new Array(items.length);
	let nextIndex = 0;
	let completed = 0;
	let failure: { error: unknown } | undefined;

	async function worker(): Promise<void> {
		try {
			while (!failure && nextIndex < items.length) {
				const index = nextIndex++;
				const item = items[index];
				if (!item) {
					continue;
				}
				try {
					results[index] = await fn(item);
				} catch (error) {
					if (onError) {
						results[index] = onError(item, error);
					} else {
						throw error;
					}
				}
				completed += 1;
				onProgress?.(completed, items.length);
			}
		} catch (error) {
			failure ??= { error };
		}
	}

	const workerCount = Math.min(concurrency, items.length);
	const workers: Promise<void>[] = [];
	for (let i = 0; i < workerCount; i++) {
		workers.push(worker());
	}
	await Promise.all(workers);
	if (failure) {
		throw failure.error;
	}

	return results;
}
