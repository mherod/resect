import type { ReadOnlyCommandOptions } from "./commands.ts";

export type FilenameCasing =
	| "camelCase"
	| "PascalCase"
	| "kebab-case"
	| "snake_case";

export type DetectedFilenameCasing = FilenameCasing | "unknown";

export type PrimaryExportKind =
	| "class"
	| "function"
	| "type"
	| "interface"
	| "enum"
	| "variable"
	| "mixed"
	| "unknown";

export interface NamingAnalysisOptions {
	directory?: string;
	minSiblings?: number;
	majorityThreshold?: number;
	case?: FilenameCasing;
	includeTests?: boolean;
}

export interface NamingOptions
	extends ReadOnlyCommandOptions,
		NamingAnalysisOptions {
	directory: string;
	json?: boolean;
	fix?: boolean;
	force?: boolean;
	dryRun?: boolean;
}

export interface NamingViolation {
	file: string;
	currentCasing: DetectedFilenameCasing;
	suggestedName: string;
	primaryExportKind: PrimaryExportKind;
	siblingCasingMajority: FilenameCasing;
	siblingMajorityPercent: number;
	siblingMajorityCount: number;
	siblingCount: number;
	confidence: number;
	reason: string;
}

export interface NamingReport {
	schemaVersion: "1";
	directory: string;
	generatedAt: string;
	warnings: string[];
	excludedGeneratedFiles: string[];
	findings: NamingViolation[];
	summary: {
		totalFindings: number;
		filesTouched: number;
		totalFiles: number;
		excludedGeneratedFileCount: number;
		totalDirectories: number;
		minSiblings: number;
		majorityThreshold: number;
		case?: FilenameCasing;
		includeTests: boolean;
	};
}
