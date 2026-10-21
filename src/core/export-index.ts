/**
 * Bounded, lazy per-file export index (#248).
 *
 * `find` export/all queries used to reread and reparse every eligible file
 * on every query. This index caches each file's scanned exports keyed by
 * absolute path and validated by mtime, so a warm query in a long-lived MCP
 * or library process parses each source file at most once until it changes.
 *
 * Properties:
 * - Lazy: nothing is parsed (and no state is built) until an export lookup
 *   asks for a file, so file-only searches never initialize the index.
 * - Incremental: an edited file is reparsed on its next lookup (mtime
 *   mismatch); an added file is simply a cold entry; a deleted file drops
 *   its entry and returns no exports.
 * - Bounded: entries are LRU-evicted past MAX_EXPORT_INDEX_ENTRIES through
 *   the shared bounded-cache helpers.
 * - Synchronous lookups coalesce cold reads. Async large scans use bounded
 *   workers; overlapping cold queries may scan the same file independently.
 *
 * The mtime is snapshotted BEFORE the read so an edit racing the parse
 * invalidates the next lookup instead of being masked by a post-read
 * timestamp (same discipline as the graph cache, #87).
 */
import { statSync } from "node:fs";
import { isMainThread } from "node:worker_threads";
import type { ExportInfo } from "../types/analysis.ts";
import type { ExportScanJob } from "./analysis-worker.ts";
import { runAnalysisJobs } from "./analysis-workers.ts";
import { enforceCacheLimit, setCacheEntry } from "./bounded-cache.ts";
import type { ExportIndexEntry } from "./export-scan.ts";
import { fileMtimeMs } from "./path-utils.ts";
import { scanExports } from "./scanner.ts";
import { withSourceFile } from "./source-file.ts";

/**
 * Entry-count bound. 10k files at a few KB of export metadata each keeps the
 * index far below the parsed-source weight it replaces. Searches may exceed
 * this bound; query-local lookups protect their hits from mid-scan eviction.
 */
export const MAX_EXPORT_INDEX_ENTRIES = 10_000;

const exportIndexCache = new Map<string, ExportIndexEntry>();
let maxEntries = MAX_EXPORT_INDEX_ENTRIES;
let parseCount = 0;
const MIN_EXPORT_WORKER_FILES = 128;

/** Keep large cold scans' parser heaps in a short-lived, bounded worker VM. */
export async function prepareExportIndexLookup(
	filePaths: readonly string[]
): Promise<(filePath: string) => ExportInfo[]> {
	const retained = new Map<string, ExportIndexEntry>();
	const missing: string[] = [];
	for (const file of filePaths) {
		const cached = exportIndexCache.get(file);
		if (cached?.mtimeMs === fileMtimeMs(file)) {
			retained.set(file, cached);
		} else {
			missing.push(file);
		}
	}
	if (!isMainThread || missing.length < MIN_EXPORT_WORKER_FILES) {
		return createExportIndexLookup(filePaths);
	}
	const [entries] = await runAnalysisJobs<ExportScanJob, ExportIndexEntry[]>([
		{ kind: "exports", files: missing },
	]);
	if (entries?.length !== missing.length) {
		throw new Error("Export worker returned an incomplete index");
	}
	for (const [index, file] of missing.entries()) {
		const entry = entries[index];
		if (entry) {
			retained.set(file, entry);
		}
	}
	parseCount += missing.length;
	// Admission happens in query order, keeping LRU behavior and equal-name ties.
	return (file) => readIndexedFileExports(file, retained.get(file));
}

/**
 * Exports of `filePath`, parsed at most once per file content. Returns an
 * empty list for missing or unparsable files, matching the previous
 * uncached behavior.
 */
export function getIndexedFileExports(filePath: string): ExportInfo[] {
	return readIndexedFileExports(filePath, exportIndexCache.get(filePath));
}

/**
 * Retain only this query's existing metadata until its ordered scan finishes.
 * Otherwise a scan larger than the LRU can evict every upcoming hit and reparse
 * the entire project on every query. No ASTs or extra persistent entries are
 * retained, and each lookup still checks mtime immediately before reuse.
 */
export function createExportIndexLookup(
	filePaths: readonly string[]
): (filePath: string) => ExportInfo[] {
	const retained = new Map<string, ExportIndexEntry>();
	for (const filePath of filePaths) {
		const cached = exportIndexCache.get(filePath);
		if (cached) {
			retained.set(filePath, cached);
		}
	}
	return (filePath) =>
		readIndexedFileExports(
			filePath,
			exportIndexCache.get(filePath) ?? retained.get(filePath)
		);
}

function readIndexedFileExports(
	filePath: string,
	cached: ExportIndexEntry | undefined
): ExportInfo[] {
	let mtimeMs: number;
	try {
		mtimeMs = statSync(filePath).mtimeMs;
	} catch {
		exportIndexCache.delete(filePath);
		return [];
	}
	if (cached?.mtimeMs === mtimeMs) {
		// A query may reuse an entry evicted since it began. Re-admit it at the
		// current LRU position without exceeding the persistent cache bound.
		setCacheEntry(exportIndexCache, filePath, cached);
		enforceCacheLimit(exportIndexCache, [exportIndexCache], maxEntries);
		return cached.exports;
	}
	parseCount += 1;
	const exports = withSourceFile(filePath, scanExports, []);
	setCacheEntry(exportIndexCache, filePath, { exports, mtimeMs });
	enforceCacheLimit(exportIndexCache, [exportIndexCache], maxEntries);
	return exports;
}

/** Test-only: number of cold parses performed since process start. */
export function exportIndexParseCount(): number {
	return parseCount;
}

/** Test-only: current number of indexed files. */
export function exportIndexSize(): number {
	return exportIndexCache.size;
}

/**
 * Test-only: reset entries and restore the default entry bound (the parse
 * counter is monotonic by design).
 */
export function clearExportIndex(): void {
	exportIndexCache.clear();
	maxEntries = MAX_EXPORT_INDEX_ENTRIES;
}

/** Test-only: shrink the entry bound to observe LRU eviction. */
export function setExportIndexLimitForTests(limit: number): void {
	maxEntries = limit;
}
