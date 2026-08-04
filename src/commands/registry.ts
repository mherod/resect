import { logger } from "../cli-logger.ts";
import { affectedCommand } from "./affected.ts";
import { aliasCommand } from "./alias.ts";
import { analyzeCommand } from "./analyze.ts";
import { analyzeImpactCommand } from "./analyze-impact.ts";
import { auditCommand } from "./audit.ts";
import { barrelCommand } from "./barrel.ts";
import { CLI_NAME, cliHelp } from "./command-spec.ts";
import { depsCommand } from "./deps.ts";
import { discoverCommand } from "./discover.ts";
import { extractCommonCommand } from "./extract-common.ts";
import { extractComponentCommand } from "./extract-component.ts";
import { findCommand } from "./find.ts";
import { inlineCommand } from "./inline.ts";
import { mockCleanupCommand } from "./mock-cleanup.ts";
import { moveCommand } from "./move.ts";
import { moveBatchCommand } from "./move-batch.ts";
import { namingCommand } from "./naming.ts";
import { FIND_TYPES, isInDomain, PREFER_STRATEGIES } from "./option-domains.ts";
import type { CliValues } from "./option-flags.ts";

export type { CliValues } from "./option-flags.ts";

import { organiseCommand } from "./organise.ts";
import { renameCommand } from "./rename.ts";
import { similarCommand } from "./similar.ts";
import { testRelocationCommand } from "./test-relocation.ts";
import { parseTidyFixCategories, tidyCommand } from "./tidy.ts";
import { workspaceCommand } from "./workspace.ts";

function requireArg(
	cmdName: string,
	argSpec: string,
	value: string | undefined
): asserts value is string {
	if (!value) {
		logger.error(`Error: ${cmdName} requires a ${argSpec} argument`);
		logger.error(`Run '${CLI_NAME} ${cmdName} --help' for usage`);
		process.exit(1);
	}
}

interface CommandDef {
	name: string;
	helpText: string;
	run: (args: string[], values: CliValues) => Promise<void> | void;
}

export const COMMANDS: CommandDef[] = [
	{
		name: "move",
		helpText: cliHelp("move"),
		run: async ([source, target], values) => {
			if (values.batch && (source || target)) {
				logger.error(
					"Error: move accepts either <source> <target> or --batch <moves.json>, not both"
				);
				process.exit(1);
			}
			if (!(values.batch || (source && target))) {
				logger.error("Error: move requires <source> and <target> arguments");
				logger.error("       or provide --batch <moves.json>");
				logger.error(`Run '${CLI_NAME} move --help' for usage`);
				process.exit(1);
			}
			const prefer = values.prefer;
			if (prefer !== undefined && !isInDomain(PREFER_STRATEGIES, prefer)) {
				logger.error(
					"Error: --prefer must be 'alias', 'relative', or 'shortest'"
				);
				process.exit(1);
			}
			if (values.batch) {
				await moveBatchCommand({
					batch: values.batch,
					dryRun: values["dry-run"],
					force: values.force,
					json: values.json,
					verbose: values.verbose,
					verify: !values["no-verify"],
					project: values.project,
					workspace: values.workspace,
					transform: values.transform,
					prefer,
				});
				return;
			}
			requireArg("move", "<source>", source);
			requireArg("move", "<target>", target);
			await moveCommand({
				source,
				target,
				dryRun: values["dry-run"],
				force: values.force,
				json: values.json,
				verbose: values.verbose,
				verify: !values["no-verify"],
				project: values.project,
				workspace: values.workspace,
				transform: values.transform,
				prefer,
			});
		},
	},

	{
		name: "rename",
		helpText: cliHelp("rename"),
		run: async ([file, oldName, newName], values) => {
			if (!(file && oldName && newName)) {
				logger.error(
					"Error: rename requires <file>, <oldName>, and <newName> arguments"
				);
				logger.error(`Run '${CLI_NAME} rename --help' for usage`);
				process.exit(1);
			}
			await renameCommand({
				file,
				oldName,
				newName,
				dryRun: values["dry-run"],
				force: values.force,
				json: values.json,
				verbose: values.verbose,
				project: values.project,
				workspace: values.workspace,
				verify: !values["no-verify"],
			});
		},
	},

	{
		name: "analyze",
		helpText: cliHelp("analyze"),
		run: async ([file], values) => {
			requireArg("analyze", "<file>", file);
			await analyzeCommand({
				file,
				verbose: values.verbose,
				project: values.project,
				workspace: values.workspace,
				onlyRelatedTo: values["only-related-to"],
			});
		},
	},

	{
		name: "analyze-impact",
		helpText: cliHelp("analyze-impact"),
		run: async ([source, target], values) => {
			requireArg("analyze-impact", "<source>", source);
			requireArg("analyze-impact", "<target>", target);
			await analyzeImpactCommand({
				source,
				target,
				verbose: values.verbose,
				project: values.project,
				workspace: values.workspace,
			});
		},
	},

	{
		name: "affected",
		helpText: cliHelp("affected"),
		run: async (files, values) => {
			if (files.length === 0) {
				logger.error("Error: affected requires at least one <file> argument");
				logger.error(`Run '${CLI_NAME} affected --help' for usage`);
				process.exit(1);
			}
			await affectedCommand({
				files,
				verbose: values.verbose,
				project: values.project,
				workspace: values.workspace,
				json: values.json,
			});
		},
	},

	{
		name: "discover",
		helpText: cliHelp("discover"),
		run: async ([directory], values) => {
			requireArg("discover", "<directory>", directory);
			await discoverCommand({
				directory,
				verbose: values.verbose,
				workspace: values.workspace,
				onlyRelatedTo: values["only-related-to"],
			});
		},
	},

	{
		name: "workspace",
		helpText: cliHelp("workspace"),
		run: async ([directory], values) => {
			requireArg("workspace", "<directory>", directory);
			await workspaceCommand({
				directory,
				verbose: values.verbose,
				json: values.json,
			});
		},
	},

	{
		name: "deps",
		helpText: cliHelp("deps"),
		run: async ([directory], values) => {
			requireArg("deps", "<directory>", directory);
			await depsCommand({
				directory,
				fix: values.fix,
				dryRun: values["dry-run"],
				force: values.force,
				strict: values.strict,
				json: values.json,
			});
		},
	},

	{
		name: "find",
		helpText: cliHelp("find"),
		run: async ([query], values) => {
			requireArg("find", "<query>", query);
			if (!values.project) {
				logger.error("Error: find requires -p <project> option");
				logger.error(`Run '${CLI_NAME} find --help' for usage`);
				process.exit(1);
			}
			const findType = values.type;
			if (findType !== undefined && !isInDomain(FIND_TYPES, findType)) {
				logger.error("Error: --type must be 'file', 'export', or 'all'");
				process.exit(1);
			}
			await findCommand({
				query,
				project: values.project,
				type: findType,
				verbose: values.verbose,
				workspace: values.workspace,
				onlyRelatedTo: values["only-related-to"],
			});
		},
	},

	{
		name: "alias",
		helpText: cliHelp("alias"),
		run: async ([target], values) => {
			requireArg("alias", "<target>", target);
			const renameSpecifiers = values["rename-specifier"] ?? [];
			if (!(values.prefer || renameSpecifiers.length > 0)) {
				logger.error("Error: alias requires --prefer option");
				logger.error(`Run '${CLI_NAME} alias --help' for usage`);
				process.exit(1);
			}
			const prefer = values.prefer;
			if (prefer !== undefined && !isInDomain(PREFER_STRATEGIES, prefer)) {
				logger.error(
					"Error: --prefer must be 'alias', 'relative', or 'shortest'"
				);
				process.exit(1);
			}
			await aliasCommand({
				target,
				prefer,
				dryRun: values["dry-run"],
				force: values.force,
				json: values.json,
				verbose: values.verbose,
				verify: !values["no-verify"],
				project: values.project,
				renameSpecifiers,
				workspace: values.workspace,
			});
		},
	},

	{
		name: "similar",
		helpText: cliHelp("similar"),
		run: async ([directory], values) => {
			requireArg("similar", "<directory>", directory);
			const rawThreshold = values.threshold;
			const threshold = rawThreshold === undefined ? 0.8 : Number(rawThreshold);
			if (Number.isNaN(threshold) || threshold < 0 || threshold > 1) {
				logger.error("Error: --threshold must be a number between 0.0 and 1.0");
				process.exit(1);
			}
			const rawMaxGroups = values["max-groups"];
			const maxGroups = rawMaxGroups === undefined ? 10 : Number(rawMaxGroups);
			if (Number.isNaN(maxGroups) || maxGroups < 0) {
				logger.error("Error: --max-groups must be a non-negative integer");
				process.exit(1);
			}
			const rawNameThreshold = values["name-threshold"];
			const nameThreshold =
				rawNameThreshold === undefined ? undefined : Number(rawNameThreshold);
			if (
				nameThreshold !== undefined &&
				(Number.isNaN(nameThreshold) || nameThreshold < 0 || nameThreshold > 1)
			) {
				logger.error(
					"Error: --name-threshold must be a number between 0.0 and 1.0"
				);
				process.exit(1);
			}
			const validKinds = ["function", "type", "interface"] as const;
			type ValidKind = (typeof validKinds)[number];
			const kindsArg = values.kinds
				? values.kinds
						.split(",")
						.map((k) => k.trim())
						.filter((k): k is ValidKind =>
							(validKinds as readonly string[]).includes(k)
						)
				: undefined;
			const validBuckets = ["exact", "high", "medium"] as const;
			type ValidBucket = (typeof validBuckets)[number];
			const bucketArg = values.bucket as ValidBucket | undefined;
			if (
				bucketArg &&
				!(validBuckets as readonly string[]).includes(bucketArg)
			) {
				logger.error("Error: --bucket must be 'exact', 'high', or 'medium'");
				process.exit(1);
			}
			const formatArg = values.format;
			if (formatArg !== undefined && formatArg !== "compact") {
				logger.error("Error: --format must be 'compact'");
				process.exit(1);
			}
			await similarCommand({
				directory,
				project: values.project,
				json: values.json,
				threshold,
				maxGroups,
				strict: values.strict,
				workspace: values.workspace,
				nameThreshold,
				sameNameOnly: values["same-name-only"],
				skipSameFile: values["skip-same-file"],
				onlyRelatedTo: values["only-related-to"],
				minLines: values["min-lines"] ? Number(values["min-lines"]) : undefined,
				skipDirectives: values["skip-directives"],
				skipWrappers: values["skip-wrappers"],
				kinds: kindsArg,
				bucket: bucketArg,
				format: formatArg,
			});
		},
	},

	{
		name: "extract-common",
		helpText: cliHelp("extract-common"),
		run: async ([directory], values) => {
			requireArg("extract-common", "<directory>", directory);
			const rawThreshold = values.threshold;
			const threshold =
				rawThreshold === undefined ? 0.95 : Number(rawThreshold);
			if (Number.isNaN(threshold) || threshold < 0 || threshold > 1) {
				logger.error("Error: --threshold must be a number between 0.0 and 1.0");
				process.exit(1);
			}
			const rawGroup = values.group;
			const group = rawGroup === undefined ? undefined : Number(rawGroup);
			await extractCommonCommand({
				directory,
				project: values.project,
				threshold,
				dryRun: values["dry-run"],
				force: values.force,
				json: values.json,
				strict: values.strict,
				group,
				workspace: values.workspace,
				output: values.output,
				skipSameFile: values["skip-same-file"],
				onlyRelatedTo: values["only-related-to"],
				minLines: values["min-lines"] ? Number(values["min-lines"]) : undefined,
				skipDirectives: values["skip-directives"],
				nameThreshold: values["name-threshold"]
					? Number(values["name-threshold"])
					: undefined,
				sameNameOnly: values["same-name-only"],
				skipWrappers: values["skip-wrappers"],
			});
		},
	},

	{
		name: "extract-component",
		helpText: cliHelp("extract-component"),
		run: async ([file, selector, newFile], values) => {
			if (!(file && selector && newFile)) {
				logger.error(
					"Error: extract-component requires <file>, <selector>, and <new-file> arguments"
				);
				logger.error(`Run '${CLI_NAME} extract-component --help' for usage`);
				process.exit(1);
			}
			await extractComponentCommand({
				file,
				selector,
				newFile,
				json: values.json,
				dryRun: values["dry-run"],
				force: values.force,
				verbose: values.verbose,
				project: values.project,
			});
		},
	},

	{
		name: "test-relocation",
		helpText: cliHelp("test-relocation"),
		run: async ([directory], values) => {
			requireArg("test-relocation", "<directory>", directory);
			const rawConventionThreshold = values["convention-threshold"];
			const conventionThreshold =
				rawConventionThreshold === undefined
					? undefined
					: Number(rawConventionThreshold);
			if (
				conventionThreshold !== undefined &&
				(Number.isNaN(conventionThreshold) ||
					conventionThreshold < 0 ||
					conventionThreshold > 100)
			) {
				logger.error(
					"Error: --convention-threshold must be between 0.0 and 1.0 or 0 and 100"
				);
				process.exit(1);
			}
			let normalizedThreshold: number | undefined;
			if (conventionThreshold !== undefined) {
				normalizedThreshold =
					conventionThreshold > 1
						? conventionThreshold / 100
						: conventionThreshold;
			}
			try {
				await testRelocationCommand({
					directory,
					project: values.project,
					workspace: values.workspace,
					verbose: values.verbose,
					json: values.json,
					fix: values.fix,
					dryRun: values["dry-run"],
					force: values.force,
					conventionThreshold: normalizedThreshold,
				});
			} catch (error) {
				logger.error(error instanceof Error ? error.message : String(error));
				process.exit(1);
			}
		},
	},

	{
		name: "mock-cleanup",
		helpText: cliHelp("mock-cleanup"),
		run: async ([directory], values) => {
			requireArg("mock-cleanup", "<directory>", directory);
			try {
				await mockCleanupCommand({
					directory,
					project: values.project,
					json: values.json,
					fix: values.fix,
					dryRun: values["dry-run"],
					force: values.force,
					verify: !values["no-verify"],
				});
			} catch (error) {
				logger.error(error instanceof Error ? error.message : String(error));
				process.exit(1);
			}
		},
	},

	{
		name: "naming",
		helpText: cliHelp("naming"),
		run: async ([directory], values) => {
			requireArg("naming", "<directory>", directory);
			const rawMinSiblings = values["min-siblings"];
			const minSiblings =
				rawMinSiblings === undefined ? undefined : Number(rawMinSiblings);
			if (
				minSiblings !== undefined &&
				(!Number.isInteger(minSiblings) || minSiblings < 1)
			) {
				logger.error("Error: --min-siblings must be a positive integer");
				process.exit(1);
			}
			const rawMajorityThreshold = values["majority-threshold"];
			const majorityThreshold =
				rawMajorityThreshold === undefined
					? undefined
					: Number(rawMajorityThreshold);
			if (
				majorityThreshold !== undefined &&
				(Number.isNaN(majorityThreshold) ||
					majorityThreshold < 0 ||
					majorityThreshold > 1)
			) {
				logger.error(
					"Error: --majority-threshold must be a number between 0.0 and 1.0"
				);
				process.exit(1);
			}
			try {
				await namingCommand({
					directory,
					project: values.project,
					workspace: values.workspace,
					verbose: values.verbose,
					json: values.json,
					fix: values.fix,
					force: values.force,
					dryRun: values["dry-run"],
					minSiblings,
					majorityThreshold,
					includeTests: values["include-tests"],
				});
			} catch (error) {
				logger.error(error instanceof Error ? error.message : String(error));
				process.exit(1);
			}
		},
	},

	{
		name: "organise",
		helpText: cliHelp("organise"),
		run: async ([directory], values) => {
			requireArg("organise", "<directory>", directory);
			try {
				await organiseCommand({
					directory,
					project: values.project,
					json: values.json,
					verbose: values.verbose,
					ignore: values.ignore,
				});
			} catch (error) {
				logger.error(error instanceof Error ? error.message : String(error));
				process.exit(1);
			}
		},
	},

	{
		name: "tidy",
		helpText: cliHelp("tidy"),
		run: async ([directory], values) => {
			requireArg("tidy", "<directory>", directory);
			try {
				const fixCategories =
					values.fix || values["fix-category"]
						? parseTidyFixCategories(values["fix-category"])
						: undefined;
				const maxChanges = values["max-changes"]
					? Number(values["max-changes"])
					: undefined;
				if (
					maxChanges !== undefined &&
					(!Number.isInteger(maxChanges) || maxChanges < 1)
				) {
					logger.error("Error: --max-changes must be a positive integer");
					process.exit(1);
				}
				const aliasPrefer = values["alias-prefer"];
				if (
					aliasPrefer !== undefined &&
					!isInDomain(PREFER_STRATEGIES, aliasPrefer)
				) {
					logger.error(
						"Error: --alias-prefer must be 'alias', 'relative', or 'shortest'"
					);
					process.exit(1);
				}
				await tidyCommand({
					directory,
					project: values.project,
					json: values.json,
					workspace: values.workspace,
					verbose: values.verbose,
					experimental: values.experimental,
					scope: values.scope,
					out: values.out,
					fix: values.fix,
					dryRun: values["dry-run"],
					fixCategories,
					aliasPrefer,
					force: values.force,
					maxChanges,
					fanOutThreshold: values["fan-out-threshold"]
						? Number(values["fan-out-threshold"])
						: undefined,
					fanInThreshold: values["fan-in-threshold"]
						? Number(values["fan-in-threshold"])
						: undefined,
					exportThreshold: values["export-threshold"]
						? Number(values["export-threshold"])
						: undefined,
				});
			} catch (error) {
				logger.error(error instanceof Error ? error.message : String(error));
				process.exit(1);
			}
		},
	},

	{
		name: "audit",
		helpText: cliHelp("audit"),
		run: async ([directory], values) => {
			requireArg("audit", "<directory>", directory);
			await auditCommand({
				directory,
				project: values.project,
				json: values.json,
				workspace: values.workspace,
				fanOutThreshold: values["fan-out-threshold"]
					? Number(values["fan-out-threshold"])
					: undefined,
				fanInThreshold: values["fan-in-threshold"]
					? Number(values["fan-in-threshold"])
					: undefined,
				exportThreshold: values["export-threshold"]
					? Number(values["export-threshold"])
					: undefined,
			});
		},
	},

	{
		name: "unused",
		helpText: cliHelp("unused"),
		run: async ([directory], values) => {
			requireArg("unused", "<directory>", directory);
			const { unusedCommand: cmd } = await import("./unused.ts");
			await cmd({
				directory,
				project: values.project,
				json: values.json,
				verbose: values.verbose,
				ignore: values.ignore,
				entrypointGlobs: values["entrypoint-globs"],
			});
		},
	},

	{
		name: "barrel",
		helpText: cliHelp("barrel"),
		run: async ([directory], values) => {
			requireArg("barrel", "<directory>", directory);
			try {
				await barrelCommand({
					directory,
					project: values.project,
					json: values.json,
					workspace: values.workspace,
					verbose: values.verbose,
				});
			} catch (error) {
				logger.error(error instanceof Error ? error.message : String(error));
				process.exit(1);
			}
		},
	},

	{
		name: "inline",
		helpText: cliHelp("inline"),
		run: async ([barrelFile], values) => {
			requireArg("inline", "<barrel-file>", barrelFile);
			await inlineCommand({
				barrelFile,
				dryRun: values["dry-run"],
				force: values.force,
				verbose: values.verbose,
				verify: !values["no-verify"],
				project: values.project,
				json: values.json,
			});
		},
	},
];
