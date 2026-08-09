import path from "node:path";
import { logger } from "../cli-logger.ts";
import type { SimilarityDiscoveryOptions } from "../core/similarity.ts";
import { analyzeSimilarity } from "../core/similarity.ts";
import type { SimilarityGroup, SimilarityReport } from "../types/similar.ts";

export interface SimilarOptions extends SimilarityDiscoveryOptions {
	json?: boolean;
	maxGroups?: number;
	strict?: boolean;
	bucket?: "exact" | "high" | "medium";
	format?: "compact";
}

export async function similarCommand(options: SimilarOptions): Promise<void> {
	const {
		directory,
		project,
		json,
		threshold = 0.8,
		maxGroups = 10,
		strict = false,
		workspace = false,
		nameThreshold,
		sameNameOnly = false,
		skipSameFile = false,
		onlyRelatedTo,
		minLines,
		skipDirectives,
		skipWrappers,
		kinds,
		bucket,
		format,
		includeIgnored,
	} = options;
	const absoluteDir = path.resolve(directory);

	if (!json) {
		const mode = workspace ? "across workspace packages" : "in";
		logger.info(
			`\n🔍 Scanning for similar declarations ${mode} ${absoluteDir}\n`
		);
	}

	const rawReport = await analyzeSimilarity({
		directory: absoluteDir,
		threshold,
		project,
		workspace,
		nameThreshold,
		sameNameOnly,
		skipSameFile,
		onlyRelatedTo,
		minLines,
		skipDirectives,
		skipWrappers,
		kinds,
		includeIgnored,
	});

	// Apply bucket filter if specified
	const report = bucket
		? {
				...rawReport,
				groups: rawReport.groups.filter((g) => g.bucket === bucket),
			}
		: rawReport;

	if (json) {
		const output =
			maxGroups > 0
				? {
						...report,
						groups: report.groups.slice(0, maxGroups),
						totalGroups: report.groups.length,
						truncated: report.groups.length > maxGroups,
					}
				: { ...report, totalGroups: report.groups.length, truncated: false };
		process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
		if (strict && report.groups.length > 0) {
			process.stderr.write(
				`error: ${report.groups.length} similar declaration group(s) found (threshold: ${threshold})\n`
			);
			process.exit(1);
		}
		return;
	}

	if (format === "compact") {
		printCompact(report, absoluteDir, maxGroups);
	} else {
		printReport(
			report,
			absoluteDir,
			maxGroups,
			project ? path.resolve(project) : undefined
		);
	}

	if (strict && report.groups.length > 0) {
		logger.error(
			`\nerror: ${report.groups.length} similar declaration group(s) found (threshold: ${threshold})`
		);
		process.exit(1);
	}
}

const BUCKET_META: Record<
	SimilarityGroup["bucket"],
	{ icon: string; label: (pct: string) => string }
> = {
	exact: {
		icon: "🔴",
		label: (_pct) => "exact duplicate (after normalization)",
	},
	high: { icon: "🟠", label: (pct) => `high similarity (${pct})` },
	medium: { icon: "🟡", label: (pct) => `medium similarity (${pct})` },
};

function bucketInfo(group: SimilarityGroup): { icon: string; label: string } {
	const pct = `${(group.score * 100).toFixed(0)}%`;
	const { icon, label } = BUCKET_META[group.bucket];
	return { icon, label: label(pct) };
}

const KIND_LABEL: Record<string, string> = {
	type: " (type)",
	interface: " (iface)",
};

function printCompact(
	report: SimilarityReport,
	baseDir: string,
	maxGroups: number
): void {
	if (report.groups.length === 0) {
		return;
	}

	const groups =
		maxGroups > 0 ? report.groups.slice(0, maxGroups) : report.groups;

	for (const group of groups) {
		const pct = `${(group.score * 100).toFixed(0)}%`;
		const label = group.bucket === "exact" ? "exact" : pct;
		process.stdout.write(`--- ${group.bucket} ${label}\n`);
		for (const fn of group.functions) {
			const rel = path.relative(baseDir, fn.file);
			const kindSuffix = KIND_LABEL[fn.kind] ?? "";
			process.stdout.write(`  ${fn.name}${kindSuffix} ${rel}:${fn.line}\n`);
		}
	}
}

function printReport(
	report: SimilarityReport,
	baseDir: string,
	maxGroups: number,
	projectRoot?: string
): void {
	logger.info(
		`📊 Scanned ${report.totalFunctions} declaration(s) across ${report.totalFiles} file(s)\n`
	);

	for (const warning of report.warnings ?? []) {
		logger.warn(`⚠️  ${warning}`);
		logger.empty();
	}

	if (report.groups.length === 0) {
		logger.info("✅ No similar declarations found.");
		logger.empty();
		return;
	}

	const totalGroups = report.groups.length;
	const groups =
		maxGroups > 0 ? report.groups.slice(0, maxGroups) : report.groups;

	logger.info(`Found ${totalGroups} candidate group(s) for consolidation:\n`);

	for (let i = 0; i < groups.length; i++) {
		const group = groups[i];
		if (!group) {
			continue;
		}
		const { icon, label } = bucketInfo(group);

		logger.info(`${icon} Group ${i + 1}: ${label}`);

		for (const fn of group.functions) {
			const rel = path.relative(baseDir, fn.file);
			const kindSuffix = KIND_LABEL[fn.kind] ?? "";
			logger.info(`   • ${fn.name}${kindSuffix}  ${rel}:${fn.line}`);
		}

		logger.empty();
	}

	if (maxGroups > 0 && totalGroups > maxGroups) {
		logger.info(
			`… ${totalGroups - maxGroups} more group(s) not shown. Use --max-groups=0 to show all.\n`
		);
	}

	// Suggest extract-common commands
	const pathBase = projectRoot ?? process.cwd();
	const dir = path.relative(pathBase, baseDir) || ".";
	logger.info("💡 To extract duplicates, run:");
	logger.info(`   resect extract-common ${dir} --dry-run`);
	if (totalGroups > 1) {
		logger.info(
			`   resect extract-common ${dir} --group=1 --dry-run  # target a specific group`
		);
	}
	logger.empty();
}
