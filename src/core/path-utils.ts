import { statSync } from "node:fs";
import path from "node:path";

interface TsconfigPathResult {
	tsconfigPath: string;
}

/**
 * Whether `filePath` is `baseDir` itself or sits underneath it.
 *
 * The single path-containment predicate for the codebase (#204). `path.relative`
 * resolves both arguments against the cwd, so mixed relative/absolute inputs are
 * handled without explicit resolution here.
 *
 * The escape check is separator-aware on purpose: a bare `startsWith("..")`
 * rejects a genuine descendant whose first segment merely begins with two dots
 * (`<base>/..cache/x.ts` relativises to `..cache/x.ts`). Only `..` exactly, or
 * `..` followed by a separator, means the path climbed out.
 */
export function isWithinPath(baseDir: string, filePath: string): boolean {
	const relative = path.relative(baseDir, filePath);
	if (relative === "") {
		return true;
	}
	return !(
		relative === ".." ||
		relative.startsWith(`..${path.sep}`) ||
		path.isAbsolute(relative)
	);
}

export function toRelativePath(baseDir: string, filePath: string): string {
	return path.relative(baseDir, filePath) || ".";
}

export function dedupeTsconfigResults<T extends TsconfigPathResult>(
	items: T[]
): T[] {
	const seen = new Set<string>();
	const deduped: T[] = [];
	for (const item of items) {
		const key = path.resolve(item.tsconfigPath);
		if (seen.has(key)) {
			continue;
		}
		seen.add(key);
		deduped.push(item);
	}
	return deduped;
}

/** Cheap sync mtime probe. NaN on an unreadable file forces a cache miss. */
export function fileMtimeMs(file: string): number {
	try {
		return statSync(file).mtimeMs;
	} catch {
		return Number.NaN;
	}
}

/** Snapshot the mtime of every path (one sync stat per path). */
export function snapshotMtimes(paths: readonly string[]): Map<string, number> {
	const mtimes = new Map<string, number>();
	for (const p of paths) {
		mtimes.set(p, fileMtimeMs(p));
	}
	return mtimes;
}

/**
 * True when every path in a prior mtime snapshot still has the same mtime.
 * Re-stats with a cheap sync probe; a changed or now-unreadable path returns
 * false (NaN !== NaN), so in-place edits and deletions invalidate but
 * additions (paths not in the snapshot) do not.
 */
export function mtimesUnchanged(snapshot: Map<string, number>): boolean {
	for (const [file, mtime] of snapshot) {
		if (fileMtimeMs(file) !== mtime) {
			return false;
		}
	}
	return true;
}
