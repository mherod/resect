import path from "node:path";
import { logger } from "../cli-logger.ts";
import {
	analyzeExtractComponentFreeVariables,
	type FreeVariableReport,
} from "./extract-component-analyze.ts";
import {
	buildExtractComponentModule,
	type ComponentCodegenResult,
	type ExtractComponentApplyResult,
	executeExtractComponent,
} from "./extract-component-apply.ts";
import {
	describeCandidate,
	type ExtractComponentOptions,
	type ExtractComponentReport,
	locateExtractComponentTarget,
} from "./extract-component-locate.ts";

export type {
	FreeVariableReport,
	PropCandidate,
	UnliftableHook,
} from "./extract-component-analyze.ts";
export {
	analyzeExtractComponentFreeVariables,
	classifyFreeVariables,
} from "./extract-component-analyze.ts";
export type {
	ComponentCodegenResult,
	ComponentNames,
	ExtractComponentApplyResult,
	ExtractComponentTypecheck,
	ExtractComponentWrite,
} from "./extract-component-apply.ts";
export {
	buildExtractComponentModule,
	collectJsxImports,
	componentNamesFromNewFile,
	executeExtractComponent,
	generateComponentModule,
	planExtractComponentWrites,
	reindentJsx,
	renderPropsInterface,
	toPascalCase,
} from "./extract-component-apply.ts";
export type {
	ExtractComponentOptions,
	ExtractComponentReport,
	JsxNodeKind,
	LocatedJsxNode,
} from "./extract-component-locate.ts";
export {
	locateExtractComponentTarget,
	locateJsxNode,
	parseSelector,
	resolveJsxTsNode,
} from "./extract-component-locate.ts";

/**
 * CLI entry point. Mutates by default (writes the new module + rewrites the
 * call site, gated by the dirty-worktree guard and a closing tsc check that
 * rolls back on regression). `--dry-run` previews the locate + classify +
 * codegen report without writing. Exits non-zero on failure, conflict, or block.
 */
export async function extractComponentCommand(
	options: ExtractComponentOptions
): Promise<void> {
	if (options.dryRun) {
		printExtractComponentDryRun(options);
		return;
	}

	let result: ExtractComponentApplyResult;
	try {
		result = await executeExtractComponent(options);
	} catch (error) {
		logger.error(error instanceof Error ? error.message : String(error));
		process.exit(1);
	}

	if (options.json) {
		logger.info(JSON.stringify(result, null, 2));
	} else {
		printExtractComponentResult(result);
	}
	if (!result.success) {
		process.exit(1);
	}
}

function printExtractComponentResult(
	result: ExtractComponentApplyResult
): void {
	logger.info("\n🧩 extract-component");
	logger.info(`   Component: ${result.componentName}`);
	logger.info(`   New file:  ${result.newFile}`);
	if (result.blocked || result.conflict) {
		logger.error(`⛔ ${result.errors.join(" ")}`);
		return;
	}
	if (result.rolledBack) {
		logger.error(
			`❌ Extraction introduced ${result.errors.length} new type error(s) — all writes rolled back:`
		);
		for (const error of result.errors.slice(0, 10)) {
			logger.error(`   ${error}`);
		}
		return;
	}
	logger.info(`   Import:    ${result.importSpecifier}`);
	logger.info(`   Call site: ${result.callSite}`);
	logger.info(`✅ Wrote ${result.modifiedFiles.length} file(s):`);
	for (const file of result.modifiedFiles) {
		logger.info(`   ${file}`);
	}
}

function printExtractComponentDryRun(options: ExtractComponentOptions): void {
	const { file, selector, newFile, json } = options;
	const absolutePath = path.resolve(file);

	let report: ExtractComponentReport;
	try {
		report = locateExtractComponentTarget(absolutePath, selector, newFile);
	} catch (error) {
		logger.error(error instanceof Error ? error.message : String(error));
		process.exit(1);
	}

	// Free-variable classification (#108) and codegen (#109) require the
	// type-checker, so they only run when the file resolves to a tsconfig
	// project. Degrade gracefully when it doesn't — the locate report is still
	// useful on its own. Codegen is suppressed when extraction is blocked by
	// unliftable hooks.
	let classification: FreeVariableReport | null = null;
	let classificationError: string | null = null;
	let codegen: ComponentCodegenResult | null = null;
	try {
		codegen = buildExtractComponentModule(options);
		classification = analyzeExtractComponentFreeVariables(options);
	} catch (error) {
		classificationError =
			error instanceof Error ? error.message : String(error);
	}
	const generatedModule =
		classification && !classification.blocked
			? (codegen?.moduleText ?? null)
			: null;

	if (json) {
		logger.info(
			JSON.stringify({ ...report, classification, generatedModule }, null, 2)
		);
		return;
	}

	const { located } = report;
	logger.info(
		"\n🧩 extract-component (dry-run — slices 1-3: locate + classify + codegen)"
	);
	logger.info(`   File:     ${report.file}`);
	logger.info(`   Selector: ${report.selector}`);
	logger.info(`   New file: ${report.newFile}`);
	logger.empty();
	logger.info("📍 Target JSX node:");
	logger.info(`   ${describeCandidate(located)}`);
	logger.info(`   kind: ${located.kind}`);
	logger.info(`   span: chars ${located.start}-${located.end}`);
	logger.empty();
	printClassification(classification, classificationError);
	if (generatedModule) {
		logger.info(`🛠️  Generated module (${report.newFile}):`);
		logger.info(generatedModule);
		logger.empty();
	}
	logger.info(
		"Read-only: no files written. The call-site rewrite + tsc verify/rollback (#110) follows."
	);
}

function printClassification(
	classification: FreeVariableReport | null,
	error: string | null
): void {
	if (!classification) {
		logger.info(`🔍 Free-variable analysis skipped: ${error ?? "unavailable"}`);
		logger.empty();
		return;
	}

	const { propCandidates, unliftableHooks, blocked } = classification;
	logger.info("🔍 Free-variable classification:");
	if (propCandidates.length === 0) {
		logger.info("   Prop candidates: none");
	} else {
		logger.info("   Prop candidates:");
		for (const prop of propCandidates) {
			logger.info(`     - ${prop.name}: ${prop.type}`);
		}
	}
	if (unliftableHooks.length > 0) {
		logger.info("   Unliftable hooks (block extraction):");
		for (const hook of unliftableHooks) {
			logger.info(`     - ${hook.name} (from ${hook.derivedFrom})`);
		}
	}
	logger.info(
		blocked
			? "   ⛔ Extraction blocked: subtree references hook-derived values."
			: "   ✅ Extraction safe: no unliftable hooks referenced."
	);
	logger.empty();
}
