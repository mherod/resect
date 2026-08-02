import path from "node:path";
import { formatUnifiedDiff, type StructuredEdit } from "./core/text-changes.ts";

/**
 * CLI Logger - Structured logging for user interface output
 * Uses process.stdout/stderr for direct stream output.
 */

export class CLILogger {
	/**
	 * Log informational messages to the user
	 */
	info(message: string): void {
		process.stdout.write(`${message}\n`);
	}

	/**
	 * Log success messages
	 */
	success(message: string): void {
		process.stdout.write(`${message}\n`);
	}

	/**
	 * Log warning messages (non-fatal diagnostics)
	 */
	warn(message: string): void {
		process.stderr.write(`${message}\n`);
	}

	/**
	 * Log error messages
	 */
	error(message: string): void {
		process.stderr.write(`${message}\n`);
	}

	/**
	 * Log empty line
	 */
	empty(): void {
		process.stdout.write("\n");
	}

	/**
	 * Log structured output with icons and formatting
	 */
	structured(options: {
		operation: string;
		target?: string;
		strategy?: string;
		verification?: boolean;
		dryRun?: boolean;
		symbol?: string;
	}): void {
		const prefix = options.dryRun ? "🔍 Dry run:" : (options.symbol ?? "⚡");
		this.info(`${prefix} ${options.operation}...`);
		if (options.target) {
			this.info(`   Target: ${options.target}`);
		}
		if (options.strategy) {
			this.info(`   Strategy: ${options.strategy}`);
		}
		if (options.verification) {
			this.info("   Verification: enabled");
		}
		this.empty();
	}

	/**
	 * Log completion status
	 */
	complete(options: {
		operation: string;
		success: boolean;
		dryRun: boolean;
		count?: number;
		type?: string;
	}): void {
		const verb = options.dryRun ? "Would" : "";
		if (options.success) {
			this.success(`✅ ${verb} ${options.operation} successfully!`);
			if (options.count && options.type) {
				this.info(`📝 ${verb} update ${options.count} ${options.type}(s)`);
			}
		} else {
			this.error(`❌ ${verb} ${options.operation} failed`);
		}
		this.empty();
	}

	/**
	 * Log file changes
	 */
	fileChanges(
		relativePath: string,
		changes: Array<{ line: number; oldSpecifier: string; newSpecifier: string }>
	): void {
		this.info(`📄 ${relativePath}`);
		for (const change of changes) {
			this.info(`   Line ${change.line}:`);
			this.info(`      - ${change.oldSpecifier}`);
			this.info(`      + ${change.newSpecifier}`);
		}
		this.empty();
	}
}

// Global logger instance
export const logger = new CLILogger();

interface CommandResultInput {
	success: boolean;
	edits?: StructuredEdit[];
	updatedReferences: {
		file: string;
		line: number;
		oldSpecifier: string;
		newSpecifier: string;
	}[];
	errors: Array<{ file: string; message: string; recoverable?: boolean }>;
}

export function printCommandResult(
	result: CommandResultInput,
	verb: string,
	pastVerb: string,
	dryRun: boolean,
	verbose: boolean,
	projectRoot?: string
): void {
	const pathBase = projectRoot ?? process.cwd();
	if (result.success) {
		logger.info(`✅ ${dryRun ? `Would ${verb}` : pastVerb} successfully!\n`);
	} else {
		logger.info(`❌ ${dryRun ? "Would fail" : "Failed"}\n`);
	}

	if (result.updatedReferences.length > 0) {
		logger.info(
			`📝 ${dryRun ? "Would update" : "Updated"} ${result.updatedReferences.length} reference(s):`
		);

		const byFile = new Map<string, typeof result.updatedReferences>();
		for (const ref of result.updatedReferences) {
			const existing = byFile.get(ref.file) ?? [];
			existing.push(ref);
			byFile.set(ref.file, existing);
		}

		for (const [file, refs] of byFile) {
			const relativePath = path.relative(pathBase, file);
			logger.info(`   • ${relativePath}`);
			if (verbose) {
				for (const ref of refs) {
					logger.info(
						`     L${ref.line}: "${ref.oldSpecifier}" → "${ref.newSpecifier}"`
					);
				}
			}
		}
		logger.empty();
	}

	if (dryRun && result.edits && result.edits.length > 0) {
		logger.info(
			formatUnifiedDiff(result.edits, (file) => path.relative(pathBase, file))
		);
		logger.empty();
	}

	if (result.errors.length > 0) {
		logger.info(`⚠️  Errors (${result.errors.length}):`);
		for (const error of result.errors) {
			const relativePath = path.relative(pathBase, error.file);
			if (error.recoverable === undefined) {
				logger.info(`   ${relativePath}: ${error.message}`);
			} else {
				const severity = error.recoverable ? "warning" : "error";
				logger.info(`   [${severity}] ${relativePath}: ${error.message}`);
			}
		}
		logger.empty();
	}
}
