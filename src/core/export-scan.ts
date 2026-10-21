import type { ExportInfo } from "../types/analysis.ts";
import { fileMtimeMs } from "./path-utils.ts";
import { scanExports } from "./scanner.ts";
import { withSourceFile } from "./source-file.ts";

export interface ExportIndexEntry {
	mtimeMs: number;
	exports: ExportInfo[];
}

export function scanFileExports(file: string): ExportIndexEntry {
	// Snapshot before parsing so a concurrent edit invalidates this record.
	const mtimeMs = fileMtimeMs(file);
	return { mtimeMs, exports: withSourceFile(file, scanExports, []) };
}
