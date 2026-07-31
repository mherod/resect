/**
 * Public API for resect — runtime-agnostic TypeScript/JavaScript refactoring.
 *
 * Use `setRuntime(bunRuntime)` (default) or `setRuntime(nodeRuntime)` before
 * calling any command that touches the filesystem.
 */

// ── Commands: affected ──────────────────────────────────────────────
export type { AffectedOptions } from "./commands/affected.ts";
export { affected, affectedCommand } from "./commands/affected.ts";
// ── Commands: alias ─────────────────────────────────────────────────
export type {
	AliasChange,
	AliasOptions,
	AliasResult,
	MissedEquivalent,
} from "./commands/alias.ts";
export { aliasCommand, planAliasEdits } from "./commands/alias.ts";
// ── Commands: analyze ───────────────────────────────────────────────
export type { AnalyzeOptions } from "./commands/analyze.ts";
export { analyze, analyzeCommand } from "./commands/analyze.ts";
// ── Commands: analyze-impact ────────────────────────────────────────
export type { AnalyzeImpactOptions } from "./commands/analyze-impact.ts";
export {
	analyzeImpact,
	analyzeImpactCommand,
} from "./commands/analyze-impact.ts";
// ── Commands: audit ─────────────────────────────────────────────────
export type {
	AuditOptions,
	AuditReport,
	Cycle,
	FileMetrics,
} from "./commands/audit.ts";
export {
	auditCommand,
	buildAuditReport,
	computeMetrics,
	detectCycles,
} from "./commands/audit.ts";
// ── Commands: barrel ────────────────────────────────────────────────
export type {
	BarrelOptions,
	BarrelReportContext,
} from "./commands/barrel.ts";
export {
	analyzeBarrels,
	barrelCommand,
	barrelReportToJson,
	buildBarrelReport,
} from "./commands/barrel.ts";
// ── Commands: discover ──────────────────────────────────────────────
export type { DiscoverOptions } from "./commands/discover.ts";
export { discoverCommand } from "./commands/discover.ts";
// ── Commands: extract-common ────────────────────────────────────────
export type { ExtractCommonOptions } from "./commands/extract-common.ts";
export { extractCommonCommand } from "./commands/extract-common.ts";
// ── Commands: extract-component ─────────────────────────────────────
export type {
	ComponentCodegenResult,
	ComponentNames,
	ExtractComponentApplyResult,
	ExtractComponentOptions,
	ExtractComponentReport,
	ExtractComponentTypecheck,
	ExtractComponentWrite,
	FreeVariableReport,
	JsxNodeKind,
	LocatedJsxNode,
	PropCandidate,
	UnliftableHook,
} from "./commands/extract-component.ts";
export {
	analyzeExtractComponentFreeVariables,
	buildExtractComponentModule,
	classifyFreeVariables,
	collectJsxImports,
	componentNamesFromNewFile,
	executeExtractComponent,
	extractComponentCommand,
	generateComponentModule,
	locateExtractComponentTarget,
	locateJsxNode,
	parseSelector,
	planExtractComponentWrites,
	reindentJsx,
	renderPropsInterface,
	resolveJsxTsNode,
	toPascalCase,
} from "./commands/extract-component.ts";
// ── Commands: find ──────────────────────────────────────────────────
export type {
	ExportMatch,
	FileMatch,
	FindOptions,
	FindResult,
} from "./commands/find.ts";
export { findCommand, search } from "./commands/find.ts";
// ── Commands: inline ────────────────────────────────────────────────
export type {
	InlineConflict,
	InlineOptions,
	InlineResult,
	InlineRewrite,
} from "./commands/inline.ts";
export { inlineBarrel, inlineCommand } from "./commands/inline.ts";
// ── Commands: mock-cleanup ─────────────────────────────────────────
export {
	applyMockCleanup,
	buildMockCleanupReport,
	findMockOrphans,
	formatMockCleanupReport,
	mockCleanupCommand,
} from "./commands/mock-cleanup.ts";
// ── Commands: move ──────────────────────────────────────────────────
export type { MoveOptions } from "./commands/move.ts";
export {
	moveCommand,
	moveModule,
	rollbackTransformMove,
} from "./commands/move.ts";
// ── Commands: naming ───────────────────────────────────────────────
export {
	buildNamingReport,
	findNamingViolations,
	formatNamingReport,
	namingCommand,
} from "./commands/naming.ts";
// ── Commands: organise ─────────────────────────────────────────────
export {
	buildOrganiseReport,
	organiseCommand,
} from "./commands/organise.ts";
// ── Commands: rename ────────────────────────────────────────────────
export type { RenameOptions, RenameResult } from "./commands/rename.ts";
export {
	renameCommand,
	renameInSourceFile,
	renameSymbol,
} from "./commands/rename.ts";
// ── Commands: similar ───────────────────────────────────────────────
export type { SimilarOptions } from "./commands/similar.ts";
export { similarCommand } from "./commands/similar.ts";
// ── Commands: test-relocation ──────────────────────────────────────
export {
	applyRelocations,
	buildTestRelocationReport,
	findTestRelocations,
	formatTestRelocationReport,
	testRelocationCommand,
} from "./commands/test-relocation.ts";
// ── Commands: tidy ─────────────────────────────────────────────────
export {
	buildTidyReport,
	formatTidyReport,
	previewTidyFixes,
	tidyCommand,
} from "./commands/tidy.ts";
// ── Commands: unused ────────────────────────────────────────────────
export type {
	UnusedExport,
	UnusedOptions,
	UnusedReport,
} from "./commands/unused.ts";
export {
	buildImportedBindingsMap,
	computeOrphanFiles,
	countInternalReferences,
	findUnusedExports,
	findUnusedExportsFromGraphs,
	hasNoExternalUsage,
	isExportUsed,
	unusedCommand,
} from "./commands/unused.ts";
// ── Commands: workspace ─────────────────────────────────────────────
export type { WorkspaceOptions } from "./commands/workspace.ts";
export { workspaceCommand } from "./commands/workspace.ts";
export type { DependencyGraph } from "./core/graph.ts";
export {
	buildDependencyGraph,
	findAllReferences,
	findBarrelReExports,
	getImports,
	isBarrelFile,
} from "./core/graph.ts";
// ── Core: project & graph ───────────────────────────────────────────
export {
	createProgram,
	getProjectFiles,
	loadProject,
	resolveTsConfig,
} from "./core/project.ts";
// ── Core: resolver ──────────────────────────────────────────────────
export {
	calculateNewSpecifier,
	calculateRelativeSpecifier,
	findAliasForPath,
	findCrossPackageImport,
	findPackageForPath,
	isBareImport,
	isCrossPackageMove,
	isRelativeImport,
	normalizePath,
	resolveModuleSpecifier,
} from "./core/resolver.ts";
// ── Core: scanner ───────────────────────────────────────────────────
export type { ExternalImport } from "./core/scanner.ts";
export {
	scanBarrelExports,
	scanExports,
	scanExternalImports,
	scanModuleReferences,
} from "./core/scanner.ts";
// ── Core: similarity ────────────────────────────────────────────────
export type {
	AnalyzeSimilarityOptions,
	SimilarityDiscoveryOptions,
	SimilarityFilterOptions,
} from "./core/similarity.ts";
export { analyzeSimilarity } from "./core/similarity.ts";
// ── Core: transform config (epic #103) ─────────────────────────────
export {
	DEFAULT_TRANSFORM_CONFIG_PATH,
	loadTransformConfig,
	validateTransformConfig,
} from "./core/transform-config.ts";
export {
	applyTransformRules,
	planTransformRewrites,
} from "./core/transform-visitor.ts";
// ── Core: tsconfig discovery ────────────────────────────────────────
export type {
	ProjectDiscovery,
	TsConfigInfo,
} from "./core/tsconfig-discovery.ts";
export {
	discoverProject,
	findOwningConfig,
} from "./core/tsconfig-discovery.ts";
// ── Core: verification ──────────────────────────────────────────────
export {
	canTypeCheck,
	runTypeCheck,
	verifyTypeChecking,
} from "./core/verify.ts";
// ── Core: workspace ─────────────────────────────────────────────────
export type { WorkspaceInfo, WorkspacePackage } from "./core/workspace.ts";
export { discoverWorkspace } from "./core/workspace.ts";
// ── Runtime abstraction ─────────────────────────────────────────────
export type { FileSystem, GlobRunner, Runtime } from "./runtime/index.ts";
export {
	bunRuntime,
	getRuntime,
	nodeRuntime,
	setRuntime,
} from "./runtime/index.ts";
export type { AnalysisResult, ExportInfo } from "./types/analysis.ts";
// ── Types: barrel ──────────────────────────────────────────────────
export type {
	BarrelInfo,
	BarrelReport,
	BarrelScan,
	SubpathShadowing,
} from "./types/barrel.ts";
export type { MutatingCommandOptions } from "./types/commands.ts";
export type {
	BarrelExport,
	BarrelExportEntry,
	ImportBinding,
	ModuleReference,
	ReferenceType,
} from "./types/graph.ts";
export type { BreakingRisk, ImpactReport } from "./types/impact.ts";
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
	DependencyChange,
	DependencyField,
	MoveError,
	MoveOperation,
	MoveResult,
	UpdatedReference,
} from "./types/move.ts";
// ── Types: naming ──────────────────────────────────────────────────
export type {
	DetectedFilenameCasing,
	FilenameCasing,
	NamingAnalysisOptions,
	NamingOptions,
	NamingReport,
	NamingViolation,
	PrimaryExportKind,
} from "./types/naming.ts";
// ── Types: organise ────────────────────────────────────────────────
export type {
	BasenameCollision,
	ExportConflict,
	MisplacedFile,
	OrganiseOptions,
	OrganiseReport,
	SignatureInfo,
} from "./types/organise.ts";
export type {
	DeclarationKind,
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
export type {
	TidyAuditFinding,
	TidyFinding,
	TidyOptions,
	TidyReport,
	TidySimilarFinding,
	TidySimilarMember,
	TidyUnusedFinding,
} from "./types/tidy.ts";
export type {
	TransformConfig,
	TransformRewrite,
	TransformRule,
} from "./types/transform.ts";
// ── Core types ──────────────────────────────────────────────────────
export type {
	SerializedEdit,
	StructuredEdit,
	TextChange,
} from "./core/text-changes.ts";
export {
	applyStructuredEdits,
	createStructuredEdit,
	formatUnifiedDiff,
	serializeStructuredEdits,
} from "./core/text-changes.ts";
export type { ProjectConfig, ProjectReference } from "./types.ts";
