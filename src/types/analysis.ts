import type { BarrelExport, ModuleReference } from "./graph.ts";

export interface AnalysisResult {
	file: string;
	imports: ModuleReference[];
	exports: ExportInfo[];
	referencedBy: ModuleReference[];
	barrelExports: BarrelExport[];
	unresolvable: Array<{
		specifier: string;
		line: number;
		diagnostic: string;
	}>;
	unusedExports: UnusedExportInfo[];
	/** Exports reachable from package `main`, `module`, or `exports` entrypoints. */
	publicApiExports: ExportInfo[];
	/** True when package entrypoint files could not be resolved or scanned completely. */
	publicApiTraceIncomplete: boolean;
	noExternalUsage: boolean;
	/** True when framework/configuration dispatch makes static imports incomplete. */
	externalUsageAssumed: boolean;
	/**
	 * True when the file is reached from a `package.json#bin` target (#207). A
	 * binary is executed, not imported, so having no referencing file is expected
	 * rather than evidence that the module is dead. This does not imply the
	 * file's exports are externally consumable — a bin tree publishes no API.
	 */
	packageBinEntrypoint: boolean;
	/** Project files omitted from graph-backed verdicts because they could not be parsed. */
	skippedFiles: string[];
}

export interface ExportInfo {
	name: string;
	type: "named" | "default" | "namespace";
	isType: boolean;
	line: number;
}

/**
 * An export with no cross-file importers, annotated with same-file usage so
 * callers can tell a de-export candidate (keep symbol, drop `export`) from a
 * delete candidate (remove the whole symbol).
 */
interface UnusedExportInfo extends ExportInfo {
	/** True when the symbol is still referenced within its own file. */
	internalUsage: boolean;
	/** Number of same-file references (excluding the declaration). */
	internalRefCount: number;
}
