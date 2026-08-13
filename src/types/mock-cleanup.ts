export type MockFactoryValueKind = "vi.fn" | "jest.fn" | "literal" | "other";

export type MockFactorySkipReason =
	| "async-factory"
	| "computed-property"
	| "non-object-literal-return"
	| "spread"
	| "unsupported-factory";

export interface MockSourceRange {
	start: number;
	end: number;
	line: number;
	column: number;
}

export interface MockFactoryEntry {
	key: string;
	valueNodeKind: MockFactoryValueKind;
	keyNode: MockSourceRange;
	propertyNode: MockSourceRange;
	factoryNode: MockSourceRange;
}

export interface MockFactorySkip {
	reason: MockFactorySkipReason;
	message: string;
	factoryNode?: MockSourceRange;
}

export interface MockCleanupSkipped {
	type: "mock-cleanup-skipped";
	mockFile: string;
	specifier: string;
	targetFile: string;
	reason: MockFactorySkipReason;
	message: string;
	factoryNode?: MockSourceRange;
}

export interface MockOrphan {
	mockFile: string;
	specifier: string;
	targetFile: string;
	orphanKey: string;
	valueNodeKind: MockFactoryValueKind;
	keyNode: MockSourceRange;
	propertyNode: MockSourceRange;
	factoryNode: MockSourceRange;
	factoryEntries: MockFactoryEntry[];
}

export interface MockCleanupSummary {
	totalMocks: number;
	totalOrphans: number;
	totalSkipped: number;
	filesWithOrphans: number;
	filesTouched: number;
}

export interface MockCleanupTypecheck {
	errorsBefore: string[];
	errorsAfter: string[];
	newErrors: string[];
	verificationIncomplete: boolean;
}

export interface MockCleanupReport {
	schemaVersion: "1";
	directory: string;
	generatedAt: string;
	orphans: MockOrphan[];
	skipped: MockCleanupSkipped[];
	summary: MockCleanupSummary;
}

export interface MockCleanupApplyResult {
	dryRun: boolean;
	success: boolean;
	report: MockCleanupReport;
	modifiedFiles: string[];
	rolledBack: boolean;
	worktreeDirtyRollbackDisabled: boolean;
	errors: string[];
	typecheck?: MockCleanupTypecheck;
}

export interface MockCleanupOptions {
	directory: string;
	project?: string;
	json?: boolean;
	fix?: boolean;
	dryRun?: boolean;
	force?: boolean;
	verify?: boolean;
}
