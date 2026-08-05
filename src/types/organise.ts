import type { ReadOnlyCommandOptions } from "./commands.ts";

export interface MisplacedFile {
	file: string;
	absolutePath: string;
	currentDir: string;
	importerDirs: string[];
	suggestedDir: string;
	suggestedPath: string;
	importerCount: number;
	/** Why this move was suggested and which boundary policy allowed it. */
	evidence: string;
}

export interface SignatureInfo {
	file: string;
	signature: string;
}

export interface ExportConflict {
	name: string;
	signatures: SignatureInfo[];
}

export interface BasenameCollision {
	basename: string;
	files: string[];
	conflictingExports: ExportConflict[];
}

export interface OrganiseReport {
	schemaVersion: "1";
	directory: string;
	generatedAt: string;
	misplacedFiles: MisplacedFile[];
	basenameCollisions: BasenameCollision[];
	summary: {
		totalMisplaced: number;
		totalCollisions: number;
		scannedFiles: number;
	};
}

export interface OrganiseOptions extends ReadOnlyCommandOptions {
	directory: string;
	json?: boolean;
	ignore?: string;
	verbose?: boolean;
}
