import type ts from "typescript";

export interface ProjectConfig {
	rootDir: string;
	tsconfigPath: string;
	compilerOptions: ts.CompilerOptions;
	pathAliases: Map<string, string[]>;
	/** Include glob patterns from tsconfig */
	include: string[];
	/** Exclude glob patterns from tsconfig */
	exclude: string[];
	/** All resolved file paths included in this project */
	files: string[];
	/** Project references (for solution-style tsconfigs) */
	references?: ProjectReference[];
}

export interface ProjectReference {
	/** Path to the referenced tsconfig */
	path: string;
	/** Whether the reference is prepended */
	prepend?: boolean;
	/** Whether the reference is circular */
	circular?: boolean;
}

export type { AnalysisResult, ExportInfo } from "./types/analysis.ts";
export type {
	MutatingCommandOptions,
	ReadOnlyCommandOptions,
} from "./types/commands.ts";
export type {
	ConsumerDependencyContract,
	ConsumerDependencyContractInput,
	DependencyContractChange,
	DependencyContractConflict,
	DependencyContractIssue,
	DependencyContractReport,
	DependencyContractRequirement,
	DependencySection,
	DepsApplyResult,
	TurboDependencyChange,
} from "./types/deps.ts";
export type {
	BarrelExport,
	BarrelExportEntry,
	ImportBinding,
	ModuleReference,
	ReferenceType,
} from "./types/graph.ts";
export type {
	MockCleanupApplyResult,
	MockCleanupOptions,
	MockCleanupReport,
	MockCleanupSkipped,
	MockCleanupSummary,
	MockCleanupTypecheck,
	MockFactoryEntry,
	MockFactorySkip,
	MockFactorySkipReason,
	MockFactoryValueKind,
	MockOrphan,
	MockSourceRange,
} from "./types/mock-cleanup.ts";
export type {
	MoveError,
	MoveOperation,
	MoveResult,
	UpdatedReference,
} from "./types/move.ts";
export type {
	DetectedFilenameCasing,
	FilenameCasing,
	NamingAnalysisOptions,
	NamingOptions,
	NamingReport,
	NamingViolation,
	PrimaryExportKind,
} from "./types/naming.ts";
export type {
	FunctionInfo,
	SimilarityBucket,
	SimilarityGroup,
	SimilarityReport,
} from "./types/similar.ts";
export type {
	TestRelocation,
	TestRelocationApplyResult,
	TestRelocationImport,
	TestRelocationOptions,
	TestRelocationReason,
	TestRelocationReport,
} from "./types/test-relocation.ts";
