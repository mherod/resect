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
 * - Coalesced cold builds: lookups are synchronous, so within one process
 *   two concurrent queries cannot interleave mid-file — each cold file is
 *   parsed exactly once and the second query reads the cached entry.
 *
 * The mtime is snapshotted BEFORE the read so an edit racing the parse
 * invalidates the next lookup instead of being masked by a post-read
 * timestamp (same discipline as the graph cache, #87).
 */
import { statSync } from "node:fs";
import type { ExportInfo } from "../types/analysis.ts";
import {
	enforceCacheLimit,
	setCacheEntry,
	touchCacheEntry,
} from "./bounded-cache.ts";
import { scanExports } from "./scanner.ts";
import { withSourceFile } from "./source-file.ts";

/**
 * Entry-count bound. 10k files at a few KB of export metadata each keeps the
 * index far below the parsed-source weight it replaces while covering any
 * project this tool realistically scans in one process.
 */
export const MAX_EXPORT_INDEX_ENTRIES = 10_000;

interface ExportIndexEntry {
	mtimeMs: number;
	exports: ExportInfo[];
}

const exportIndexCache = new Map<string, ExportIndexEntry>();
let maxEntries = MAX_EXPORT_INDEX_ENTRIES;
let parseCount = 0;

/**
 * Exports of `filePath`, parsed at most once per file content. Returns an
 * empty list for missing or unparsable files, matching the previous
 * uncached behavior.
 */
export function getIndexedFileExports(filePath: string): ExportInfo[] {
	let mtimeMs: number;
	try {
		mtimeMs = statSync(filePath).mtimeMs;
	} catch {
		exportIndexCache.delete(filePath);
		return [];
	}
	const cached = touchCacheEntry(exportIndexCache, filePath);
	if (cached?.mtimeMs === mtimeMs) {
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
