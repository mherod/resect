import type { BarrelExportEntry } from "./graph.ts";

/**
 * Raw scan of a single barrel file: every re-export entry it declares plus the
 * distinct set of source modules it re-exports. Produced by the command layer
 * (which has project context to resolve specifiers) and fed to the pure
 * `buildBarrelReport`.
 */
export interface BarrelScan {
	/** Normalized absolute path of the barrel file */
	barrel: string;
	/** All re-export entries (`export * from`, `export { x } from`, etc.) */
	entries: BarrelExportEntry[];
	/** Distinct resolved absolute paths of the modules this barrel re-exports */
	reExportedFiles: string[];
}

/** Health summary for one barrel file. */
export interface BarrelInfo {
	/** Normalized absolute path of the barrel file */
	barrel: string;
	/** Total re-export entries */
	totalEntries: number;
	/** Distinct source modules re-exported */
	sourceModules: number;
	/** `export * from` (wildcard) entry count — obscures the public surface */
	wildcardCount: number;
	/** `export { x } from` / `export { default } from` entry count */
	namedCount: number;
	/** `export * as ns from` (namespace) entry count */
	namespaceCount: number;
	/** Number of files that import this barrel */
	consumers: number;
	/** Re-exported source modules that are themselves barrel files (chain) */
	reExportsBarrels: string[];
}

/**
 * A file reachable both through a barrel re-export AND through a dedicated
 * package `exports` sub-path entry (issue #93). Consumers should prefer the
 * sub-path specifier; a `move`/refactor that collapses to the root barrel
 * breaks the sub-path convention.
 */
export interface SubpathShadowing {
	/** Barrel that re-exports the file */
	barrel: string;
	/** The re-exported source file */
	file: string;
	/** Owning package name */
	packageName: string;
	/** Suggested sub-path specifier, e.g. "@scope/utils/cn" */
	specifier: string;
}

/** Full barrel-analysis report. */
export interface BarrelReport {
	/** Total barrel files found */
	totalBarrels: number;
	/** Project files omitted from the report because they could not be parsed. */
	skippedFiles: string[];
	/** Every barrel, sorted by total entries descending */
	barrels: BarrelInfo[];
	/** Barrels containing at least one wildcard (`export *`) re-export */
	wildcardBarrels: BarrelInfo[];
	/** Barrels that re-export other barrels (re-export chains) */
	chainedBarrels: BarrelInfo[];
	/** Barrels that no file imports */
	unusedBarrels: BarrelInfo[];
	/** Sub-path-export shadowing findings (#93) */
	subpathShadowing: SubpathShadowing[];
	/** Non-blocking notices, e.g. non-source files excluded from analysis (#202). */
	warnings: string[];
}
