import { existsSync } from "node:fs";
import path from "node:path";
import { logger } from "../cli-logger.ts";
import { getRuntime } from "../runtime/index.ts";
import type { ProjectConfig } from "../types.ts";
import { mapConcurrent } from "./concurrency.ts";
import { TSC_ERROR_PATTERN, TSC_GLOBAL_ERROR_PATTERN } from "./constants.ts";
import { diffDiagnostics } from "./diagnostics.ts";
import { createProgram } from "./project.ts";
import { normalizePath } from "./resolver.ts";
import {
	scanUnresolvableImports,
	type UnresolvableDiagnostic,
} from "./scanner.ts";

/** Marker prefix for the synthetic "tsc fatalled with no parseable diagnostic" error string. */
export const VERIFY_INCOMPLETE_PREFIX = "VERIFY_INCOMPLETE:";

/**
 * Resolve a tsc diagnostic's (possibly project-relative) file path to an absolute
 * one, using the same cwd `runTypeCheckDetailed` invokes tsc from, so diagnostic
 * comparisons and caller-supplied `translateBeforeFile` callbacks can compare
 * against absolute paths regardless of how tsc reported the file.
 */
export function resolveDiagnosticFile(
	project: ProjectConfig,
	file: string
): string {
	const cwd = path.dirname(project.tsconfigPath);
	return path.normalize(path.resolve(cwd, file)).replace(/\\/g, "/");
}

export interface UnresolvableDiagnosticWithFile extends UnresolvableDiagnostic {
	file: string;
}

/**
 * Collect all unresolvable imports across every project file.
 * Returns structured diagnostics with file path, specifier, line, and message.
 */
export function collectUnresolvableDiagnostics(
	project: ProjectConfig
): UnresolvableDiagnosticWithFile[] {
	const program = createProgram(project);
	const diagnostics: UnresolvableDiagnosticWithFile[] = [];
	for (const file of project.files) {
		const sf = program.getSourceFile(file);
		if (sf) {
			for (const diag of scanUnresolvableImports(sf, project)) {
				diagnostics.push({ file, ...diag });
			}
		}
	}
	return diagnostics;
}

export interface VerificationResult {
	success: boolean;
	errorsBefore: string[];
	errorsAfter: string[];
	newErrors: string[];
	fixedErrors: string[];
	/**
	 * True when either the before- or after-change tsc run could not complete
	 * a full project check (e.g. fatal TS2688 with no per-file diagnostics, or
	 * a non-zero tsc exit with no parseable output). When this is true, the
	 * before/after delta is not trustworthy and `success` will be false.
	 */
	verificationIncomplete: boolean;
	/** Whether a failed mutation was restored to its committed state. */
	rolledBack?: boolean;
	/** Whether rollback was unsafe because --force bypassed a dirty worktree. */
	worktreeDirtyRollbackDisabled?: boolean;
	/** Unresolvable imports detected after changes, with file paths and specifiers */
	unresolvableDiagnostics?: UnresolvableDiagnosticWithFile[];
}

/**
 * Verify type checking before and after changes
 */
export async function verifyTypeChecking(
	project: ProjectConfig,
	beforeSnapshot: () => void,
	applyChanges: () => Promise<void> | void,
	options?: { translateBeforeFile?: (file: string) => string }
): Promise<VerificationResult> {
	// Run type check before changes
	const before = await runTypeCheckDetailed(project);

	// Take snapshot if provided
	beforeSnapshot();

	// Apply the changes
	await applyChanges();

	// Run type check after changes
	const after = await runTypeCheckDetailed(project);

	// Collect unresolvable imports after changes are applied
	const unresolvableDiagnostics = collectUnresolvableDiagnostics(project);

	const errorsBefore = before.errors;
	const errorsAfter = after.errors;

	// Compare errors by normalized identity (file+code+message), not raw string
	// equality, with optional translation of pre-existing errors' file paths so a
	// moved file's inherited errors aren't misreported as new (#128).
	const { newErrors, fixedErrors } = diffDiagnostics(
		errorsBefore,
		errorsAfter,
		{
			resolveFile: (file) => resolveDiagnosticFile(project, file),
			translateBeforeFile: options?.translateBeforeFile,
		}
	);

	const verificationIncomplete = before.incomplete || after.incomplete;
	const success = newErrors.length === 0 && !verificationIncomplete;

	return {
		success,
		errorsBefore,
		errorsAfter,
		newErrors,
		fixedErrors,
		verificationIncomplete,
		unresolvableDiagnostics,
	};
}

/**
 * Run a mutating operation between before/after typechecks and return its delta.
 * `translateBeforeFile` maps a pre-existing error's file path to where it is
 * expected after the change (e.g. a moved file's old path -> new path) so
 * inherited errors on a moved file are matched instead of counted as new (#128).
 */
export async function runWithTypecheckGuard<T>(
	project: ProjectConfig,
	applyChanges: () => Promise<T>,
	options?: { translateBeforeFile?: (file: string) => string }
): Promise<{ result: T; delta: VerificationResult }> {
	const errorsBefore = await runTypeCheck(project);
	const result = await applyChanges();
	const errorsAfter = await runTypeCheck(project);
	const { newErrors, fixedErrors } = diffDiagnostics(
		errorsBefore,
		errorsAfter,
		{
			resolveFile: (file) => resolveDiagnosticFile(project, file),
			translateBeforeFile: options?.translateBeforeFile,
		}
	);
	const verificationIncomplete =
		isIncompleteTypeCheck(errorsBefore) || isIncompleteTypeCheck(errorsAfter);

	return {
		result,
		delta: {
			success: !verificationIncomplete && newErrors.length === 0,
			errorsBefore,
			errorsAfter,
			newErrors,
			fixedErrors,
			verificationIncomplete,
		},
	};
}

/**
 * Multi-project sibling of `runWithTypecheckGuard`, for a mutation whose
 * writes can span several tsconfigs at once (alias `--workspace`, #226).
 * Runs before/after `tsc --noEmit` on every unique project concurrently,
 * diffs each project's diagnostics independently (so `translateBeforeFile`
 * still resolves relative to the right tsconfig), then flattens the deltas
 * into one merged result.
 */
export async function runWithWorkspaceTypecheckGuard<T>(
	projects: readonly ProjectConfig[],
	applyChanges: () => Promise<T>,
	options?: { translateBeforeFile?: (file: string) => string }
): Promise<{ result: T; delta: VerificationResult }> {
	const uniqueProjects = [
		...new Map(
			projects.map((project) => [normalizePath(project.tsconfigPath), project])
		).values(),
	];
	const before = await mapConcurrent(uniqueProjects, runTypeCheckDetailed);
	const result = await applyChanges();
	const after = await mapConcurrent(uniqueProjects, runTypeCheckDetailed);

	const deltas = before.map((beforeResult, index) => {
		const project = uniqueProjects[index];
		const afterResult = after[index];
		if (!(project && afterResult)) {
			throw new Error(
				"Workspace verification result count changed after apply"
			);
		}
		const { newErrors, fixedErrors } = diffDiagnostics(
			beforeResult.errors,
			afterResult.errors,
			{
				resolveFile: (file) => resolveDiagnosticFile(project, file),
				translateBeforeFile: options?.translateBeforeFile,
			}
		);
		return {
			errorsAfter: afterResult.errors,
			errorsBefore: beforeResult.errors,
			fixedErrors,
			newErrors,
			verificationIncomplete: beforeResult.incomplete || afterResult.incomplete,
		};
	});

	const errorsBefore = deltas.flatMap((delta) => delta.errorsBefore);
	const errorsAfter = deltas.flatMap((delta) => delta.errorsAfter);
	const newErrors = deltas.flatMap((delta) => delta.newErrors);
	const fixedErrors = deltas.flatMap((delta) => delta.fixedErrors);
	const verificationIncomplete = deltas.some(
		(delta) => delta.verificationIncomplete
	);

	return {
		result,
		delta: {
			success: !verificationIncomplete && newErrors.length === 0,
			errorsAfter,
			errorsBefore,
			fixedErrors,
			newErrors,
			verificationIncomplete,
		},
	};
}

/** Structured result from a tsc invocation, including incompleteness signal. */
export interface TypeCheckOutcome {
	errors: string[];
	/**
	 * True when tsc exited non-zero but produced no per-file diagnostics, or
	 * when it emitted a fatal global diagnostic (e.g. TS2688) that prevents
	 * per-file checking. Callers MUST NOT trust an empty errors delta when
	 * `incomplete` is true — the verification did not run to completion.
	 */
	incomplete: boolean;
}

function findLocalTypeScriptBinary(project: ProjectConfig): string {
	const executable = process.platform === "win32" ? "tsc.cmd" : "tsc";
	const roots = [
		path.dirname(project.tsconfigPath),
		project.rootDir,
		process.cwd(),
	];
	const visited = new Set<string>();
	for (const root of roots) {
		let current = path.resolve(root);
		while (!visited.has(current)) {
			visited.add(current);
			const candidate = path.join(current, "node_modules", ".bin", executable);
			if (existsSync(candidate)) {
				return candidate;
			}
			const parent = path.dirname(current);
			if (parent === current) {
				break;
			}
			current = parent;
		}
	}
	return executable;
}

/**
 * Parse tsc --noEmit output into structured errors. Pure function — no I/O.
 * Distinguishes:
 *   - per-file diagnostics: `path/file.ts(line,col): error TS####: message`
 *   - global diagnostics:   `error TS####: message` (no source location;
 *     emitted before per-file checks run when tsc cannot load its inputs).
 * When tsc exits non-zero with neither form, returns a synthetic
 * `VERIFY_INCOMPLETE: ...` error so callers cannot mistake it for success.
 */
export function parseTsCompilerOutput(
	output: string,
	exitCode: number
): TypeCheckOutcome {
	if (exitCode === 0) {
		return { errors: [], incomplete: false };
	}

	const trimmed = output.trim();
	const lines = trimmed
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0);

	const errors: string[] = [];
	let sawGlobal = false;
	for (const line of lines) {
		if (line.includes(TSC_ERROR_PATTERN)) {
			errors.push(line);
			continue;
		}
		if (TSC_GLOBAL_ERROR_PATTERN.test(line)) {
			errors.push(line);
			sawGlobal = true;
		}
	}

	if (errors.length === 0) {
		const detail = trimmed ? `: ${trimmed.slice(0, 200)}` : "";
		return {
			errors: [
				`${VERIFY_INCOMPLETE_PREFIX} tsc exited with code ${exitCode} but emitted no parseable diagnostics — verification did not run${detail}`,
			],
			incomplete: true,
		};
	}

	return { errors, incomplete: sawGlobal };
}

/**
 * Run TypeScript compiler in noEmit mode and capture structured outcome.
 * Distinguishes a clean project from an incomplete verification (fatal
 * global errors or non-zero exit with no diagnostics).
 */
export async function runTypeCheckDetailed(
	project: ProjectConfig
): Promise<TypeCheckOutcome> {
	const tsconfigPath = project.tsconfigPath;
	const cwd = path.dirname(tsconfigPath);
	const tsc = findLocalTypeScriptBinary(project);

	const { stdout, stderr, exitCode } = await getRuntime().process.exec(
		[tsc, "--noEmit", "-p", tsconfigPath, "--pretty", "false"],
		{ cwd }
	);

	return parseTsCompilerOutput(stdout + stderr, exitCode ?? 0);
}

/**
 * Run TypeScript compiler in noEmit mode and capture errors.
 * Includes both per-file diagnostics AND fatal global errors (e.g. TS2688).
 * When tsc exits non-zero with no parseable diagnostics, returns a synthetic
 * `VERIFY_INCOMPLETE: ...` error string so callers cannot silently treat
 * fatal failures as a clean project. Prefer `runTypeCheckDetailed` when you
 * need the incompleteness flag separately.
 */
export async function runTypeCheck(project: ProjectConfig): Promise<string[]> {
	const { errors } = await runTypeCheckDetailed(project);
	return errors;
}

/**
 * Simple verification that just checks if tsc passes a complete project run.
 * Returns false for both genuine errors and incomplete verifications.
 */
export async function canTypeCheck(project: ProjectConfig): Promise<boolean> {
	const { errors, incomplete } = await runTypeCheckDetailed(project);
	return errors.length === 0 && !incomplete;
}

/** True when this errors list includes any incomplete-verification marker or global tsc error. */
export function isIncompleteTypeCheck(errors: readonly string[]): boolean {
	return errors.some(
		(err) =>
			err.startsWith(VERIFY_INCOMPLETE_PREFIX) ||
			TSC_GLOBAL_ERROR_PATTERN.test(err)
	);
}

/**
 * Print verification results
 */
export function printVerificationResults(result: VerificationResult): void {
	if (result.verificationIncomplete) {
		logger.error(
			"\n❌ Type checking did not complete — tsc fatalled before per-file checks could run. The before/after delta is not trustworthy."
		);
		for (const error of result.errorsAfter.slice(0, 5)) {
			logger.error(`   ${error}`);
		}
	} else if (result.success) {
		logger.info("✅ Type checking passed - no new errors introduced");

		if (result.fixedErrors.length > 0) {
			logger.info(`\n🎉 Fixed ${result.fixedErrors.length} existing error(s):`);
			for (const error of result.fixedErrors.slice(0, 5)) {
				logger.info(`   ${error}`);
			}
			if (result.fixedErrors.length > 5) {
				logger.info(`   ... and ${result.fixedErrors.length - 5} more`);
			}
		}
	} else {
		logger.error(
			`\n❌ Type checking failed - ${result.newErrors.length} new error(s) introduced:`
		);
		for (const error of result.newErrors.slice(0, 10)) {
			logger.error(`   ${error}`);
		}
		if (result.newErrors.length > 10) {
			logger.error(`   ... and ${result.newErrors.length - 10} more`);
		}
	}

	logger.info(
		`\nType errors: ${result.errorsAfter.length} total (${result.errorsBefore.length} before, ${result.newErrors.length} new, ${result.fixedErrors.length} fixed)`
	);

	if (
		result.unresolvableDiagnostics &&
		result.unresolvableDiagnostics.length > 0
	) {
		logger.warn(
			`⚠️  ${result.unresolvableDiagnostics.length} unresolvable import(s) detected after changes:`
		);
		for (const diag of result.unresolvableDiagnostics.slice(0, 10)) {
			logger.warn(`   ${diag.file}:${diag.line}: "${diag.specifier}"`);
		}
		if (result.unresolvableDiagnostics.length > 10) {
			logger.warn(
				`   ... and ${result.unresolvableDiagnostics.length - 10} more`
			);
		}
	}
}
