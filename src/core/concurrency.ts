import type { ProgressCallback } from "../types/progress.ts";

/**
 * Map over items with bounded concurrency.
 * Runs up to `limit` tasks concurrently, preserving input order in results.
 * Errors are isolated per-item when `onError` is provided; otherwise they propagate.
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

	async function worker(): Promise<void> {
		while (nextIndex < items.length) {
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
	}

	const workerCount = Math.min(concurrency, items.length);
	const workers: Promise<void>[] = [];
	for (let i = 0; i < workerCount; i++) {
		workers.push(worker());
	}
	await Promise.all(workers);

	return results;
}
