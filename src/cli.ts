#!/usr/bin/env bun

import { parseArgs } from "node:util";
import { version } from "../package.json";
import { logger } from "./cli-logger.ts";
import { CLI_NAME, formatCommandList } from "./commands/command-spec.ts";
import { applyResectConfigToCliValues } from "./commands/config-defaults.ts";
import { PARSE_ARGS_OPTIONS, preprocessArgs } from "./commands/option-flags.ts";
import type { CliValues } from "./commands/registry.ts";
import { COMMANDS } from "./commands/registry.ts";
import {
	loadResectConfig,
	resolveResectConfig,
} from "./core/project-config.ts";

const cliArgs = Bun.argv.slice(2);
const rawArgs = preprocessArgs(cliArgs);

const { values, positionals } = parseArgs({
	args: rawArgs,
	options: PARSE_ARGS_OPTIONS,
	allowPositionals: true,
});

function showHelp() {
	logger.info(`
${CLI_NAME} v${version}

Precise TypeScript/JavaScript module refactoring tool.

Usage:
  ${CLI_NAME} <command> [options] [args]

Commands:
${formatCommandList()}

Options:
  -h, --help        Show this help message
  -v, --version     Show version
  -n, --dry-run     Preview changes without modifying files
  --force           Allow mutating commands when the git worktree has uncommitted changes
  -p, --project     Path to project directory or tsconfig.json
  -t, --type        Filter type for find command (file, export, all)
  --prefer          Strategy for alias command (alias, relative, shortest)
  --rename-specifier  Rewrite exact import specifier pairs: <from>=<to> (repeatable)
  --batch           Move pairs from a JSON manifest using one shared project context
  --verify          Enable type checking verification, overriding project config
  --no-verify       Disable type checking verification (enabled by default)
  --verbose         Enable verbose output
  --json            Output results as JSON
  --threshold       Similarity threshold for similar command (0.0–1.0, default 0.8)
  --max-groups      Maximum number of groups to display (default: 10)
  --strict          Exit with an error when supported commands find drift/candidates
  --name-threshold  Name similarity threshold for similar command (0.0–1.0)
  --same-name-only  Only group functions with identical names (similar command)
  --skip-same-file  Skip groups where all functions are in the same file
  --only-related-to Only show groups related to a file or folder path/glob
  --min-lines       Exclude functions with fewer body lines (filters thin wrappers)
  --skip-directives Skip functions with compile-time directives (use server, etc.)
  --skip-wrappers   Skip thin wrapper functions (single return + call expression)
  --kinds           Comma-separated kinds for similar command: function,type,interface
  --bucket          Filter by similarity bucket: exact, high, medium (similar command)
  --format          Output format: compact (similar command)
  --workspace       Scan across all workspace packages (discover, similar, and other commands)
  --experimental    Opt into experimental commands and schemas
  --scope           Limit report findings to a source subtree
  --out             Write command output to a file
  --fan-out-threshold  Flag files with more than N imports (default: 10, audit command)
  --fan-in-threshold   Flag files with more than N consumers (default: 10, audit command)
  --export-threshold   Flag files with more than N exports (default: 8, audit command)
  --min-siblings       Minimum files in a directory before naming audit (default: 3)
  --majority-threshold Required filename casing majority for naming audit (default: 0.6)
  --case=STYLE        Require naming files to use kebab-case, camelCase, PascalCase, or snake_case
  --include-tests      Include *.test.* and *.spec.* files in naming audit
  --convention-threshold Required __tests__ majority for test relocation (default: 0.7)
  --fix                Attempt command fix mode where supported
  --fix=<categories>  Comma-separated tidy fix categories
  --max-changes       Abort tidy --fix above this planned change count
  --ignore          Glob pattern to exclude files (unused command, e.g. "*.test.ts")

Examples:
  ${CLI_NAME} find Entity -p /path/to/project
  ${CLI_NAME} analyze src/utils/helpers.ts
  ${CLI_NAME} deps . --strict
  ${CLI_NAME} alias src --prefer=alias --dry-run
  ${CLI_NAME} alias src --rename-specifier="@utils/Foo=@utils/foo"
  ${CLI_NAME} move src/old/file.ts src/new/file.ts --dry-run
  ${CLI_NAME} rename src/components/Button.tsx Button PrimaryButton
  ${CLI_NAME} similar src --json
  ${CLI_NAME} mock-cleanup src --fix
`);
}

function showVersion() {
	logger.info(`${CLI_NAME} v${version}`);
}

async function main() {
	if (values.help && positionals.length === 0) {
		showHelp();
		process.exit(0);
	}

	if (values.version) {
		showVersion();
		process.exit(0);
	}

	const [command, ...args] = positionals;

	if (values.help && command) {
		const cmd = COMMANDS.find((c) => c.name === command);
		if (cmd) {
			logger.info(cmd.helpText);
		} else {
			showHelp();
		}
		process.exit(0);
	}

	if (!command) {
		showHelp();
		return;
	}

	const cmd = COMMANDS.find((c) => c.name === command);
	if (!cmd) {
		logger.error(`Unknown command: ${command}`);
		showHelp();
		process.exit(1);
	}

	const loadedConfig = await loadResectConfig();
	const configuredValues = applyResectConfigToCliValues(
		values as CliValues,
		resolveResectConfig(loadedConfig, command)
	);
	await cmd.run(args, configuredValues);
}

main().catch((error) => {
	logger.error(String(error));
	process.exit(1);
});
