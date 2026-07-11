import path from "node:path";
import { TSC_GLOBAL_ERROR_PATTERN } from "./constants.ts";

const TSC_DIAGNOSTIC_LINE_PATTERN =
	/^(.*?)\((\d+),(\d+)\): error (TS\d+): (.*)$/;

export interface ParsedDiagnostic {
	/** Absolute or project-relative file path, or null for global (file-less) diagnostics. */
	file: string | null;
	code: string;
	message: string;
}

/**
 * Parse one line of `tsc --noEmit` output into its structured parts.
 * Returns null for lines that are not per-file or global tsc diagnostics
 * (e.g. the synthetic VERIFY_INCOMPLETE marker).
 */
export function parseDiagnosticLine(line: string): ParsedDiagnostic | null {
	const perFile = TSC_DIAGNOSTIC_LINE_PATTERN.exec(line);
	if (perFile) {
		const [, file, , , code, message] = perFile;
		if (file === undefined || code === undefined || message === undefined) {
			return null;
		}
		return { file: normalizeDiagnosticPath(file), code, message };
	}
	if (TSC_GLOBAL_ERROR_PATTERN.test(line)) {
		const [code, ...rest] = line.slice("error ".length).split(": ");
		if (code === undefined) {
			return null;
		}
		return { file: null, code, message: rest.join(": ") };
	}
	return null;
}

function normalizeDiagnosticPath(file: string): string {
	return path.normalize(file).split(path.sep).join("/");
}

/**
 * A diagnostic identity that ignores line/column so shifted-but-unchanged errors
 * still match. `resolveFile` is applied first (e.g. to resolve a tsc-relative path
 * to an absolute one) so before/after sides compare on the same path shape;
 * `translateFile` (before-side only) then maps a pre-existing file to where it is
 * expected after the change.
 */
function diagnosticKey(
	diag: ParsedDiagnostic,
	resolveFile?: (file: string) => string,
	translateFile?: (file: string) => string
): string {
	let file = diag.file ?? "";
	if (file) {
		file = resolveFile?.(file) ?? file;
		file = translateFile?.(file) ?? file;
	}
	return `${file} ${diag.code} ${diag.message}`;
}

export interface DiagnosticDelta {
	newErrors: string[];
	fixedErrors: string[];
}

/**
 * Compare two tsc diagnostic line lists by normalized identity (file + TS code +
 * message), not raw string equality, so a diagnostic that only shifted line/column
 * is not misreported as new. `resolveFile` normalizes a diagnostic's (possibly
 * tsc-relative) file path before comparison — supply it whenever `translateBeforeFile`
 * compares against absolute paths. `translateBeforeFile` maps a "before" error's
 * (resolved) file path to where it is expected after the change (e.g. a moved
 * file's old path -> new path) so pre-existing errors on a moved file are matched
 * instead of duplicated as new.
 */
export function diffDiagnostics(
	before: readonly string[],
	after: readonly string[],
	options?: {
		resolveFile?: (file: string) => string;
		translateBeforeFile?: (file: string) => string;
	}
): DiagnosticDelta {
	const beforeKeys = new Set<string>();
	for (const line of before) {
		const parsed = parseDiagnosticLine(line);
		beforeKeys.add(
			parsed
				? diagnosticKey(
						parsed,
						options?.resolveFile,
						options?.translateBeforeFile
					)
				: line
		);
	}

	const afterKeys = new Set<string>();
	for (const line of after) {
		const parsed = parseDiagnosticLine(line);
		afterKeys.add(parsed ? diagnosticKey(parsed, options?.resolveFile) : line);
	}

	const newErrors = after.filter((line) => {
		const parsed = parseDiagnosticLine(line);
		const key = parsed ? diagnosticKey(parsed, options?.resolveFile) : line;
		return !beforeKeys.has(key);
	});

	const fixedErrors = before.filter((line) => {
		const parsed = parseDiagnosticLine(line);
		const key = parsed
			? diagnosticKey(
					parsed,
					options?.resolveFile,
					options?.translateBeforeFile
				)
			: line;
		return !afterKeys.has(key);
	});

	return { newErrors, fixedErrors };
}
