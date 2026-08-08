import path from "node:path";
import { logger } from "../cli-logger.ts";
import type { TidyOptions } from "../types/tidy.ts";
import { applyTidyFixes } from "./tidy-apply.ts";
import { previewTidyFixes, type TidyApplyResult } from "./tidy-plans.ts";
import { buildTidyReport, formatTidyReport } from "./tidy-report.ts";

export { applyTidyFixes } from "./tidy-apply.ts";
export {
	ALL_TIDY_FIX_CATEGORIES,
	parseTidyFixCategories,
	previewTidyFixes,
} from "./tidy-plans.ts";
export { buildTidyReport, formatTidyReport } from "./tidy-report.ts";

function assertExperimental(enabled: boolean | undefined): void {
	if (enabled) {
		return;
	}
	throw new Error(
		"`tidy` is experimental in resect 1.x. Re-run with --experimental to opt in."
	);
}

export async function tidyCommand(options: TidyOptions): Promise<void> {
	assertExperimental(options.experimental);
	const report = await buildTidyReport(options);
	let result: TidyApplyResult;
	if (options.fix) {
		result = options.dryRun
			? await previewTidyFixes(report, options)
			: await applyTidyFixes(report, options);
	} else {
		result = {
			report,
			success: true,
			errors: [],
			worktreeDirtyRollbackDisabled: false,
		};
	}
	const output = options.json
		? `${JSON.stringify(result.report, null, 2)}\n`
		: formatTidyReport(result.report);
	if (!options.json && result.report.journalEntryId) {
		logger.info(`Journaled operation ${result.report.journalEntryId}`);
	}

	if (options.out) {
		await Bun.write(path.resolve(options.out), output);
		if (options.verbose) {
			logger.info(`Wrote tidy report to ${path.resolve(options.out)}`);
		}
		if (!result.success) {
			for (const error of result.errors) {
				logger.error(error);
			}
			process.exit(1);
		}
		return;
	}

	process.stdout.write(output);
	if (!result.success) {
		for (const error of result.errors) {
			logger.error(error);
		}
		process.exit(1);
	}
}
