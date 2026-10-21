/**
 * Source files at which analysis and mutation planning move into a disposable
 * process. Below this, parser state retained by a long-lived caller stays well
 * under the 2 GB acceptance ceiling, and a cold process would discard warm
 * caches for no memory benefit: repeated MCP calls on small and medium
 * projects keep their in-process caches. Matches the large-scan cutoff used by
 * the parallel declaration collector (two 1,024-file workers).
 */
export const LARGE_PROJECT_SOURCE_FILES = 2048;

let largeProjectSourceFiles = LARGE_PROJECT_SOURCE_FILES;

/** Internal test seam; `undefined` restores the default threshold. */
export function setLargeProjectSourceFiles(value: number | undefined): void {
	largeProjectSourceFiles = value ?? LARGE_PROJECT_SOURCE_FILES;
}

export function isLargeProject(sourceFileCount: number): boolean {
	return sourceFileCount >= largeProjectSourceFiles;
}
