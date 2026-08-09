import { describe, expect, test } from "bun:test";
import { readRegistrationSource } from "./__test-helpers.ts";
import {
	COMMAND_NAMES,
	COMMAND_SPECS,
	commandSpec,
	formatCommandList,
} from "./command-spec.ts";
import { OPTION_FLAGS } from "./option-flags.ts";
import { COMMANDS } from "./registry.ts";

/**
 * Roster parity guard (#112).
 *
 * The resect command set is consumed by three entry points: the CLI registry
 * (`COMMANDS`), the MCP server (`registerTool` calls), and the `resect --help`
 * global command list (rendered from `COMMAND_SPECS`). These tests fail if any
 * of the three drifts from the others — the exact failure mode that left
 * `extract-component` and `inline` missing from `resect --help`.
 */
describe("command roster parity", () => {
	test("COMMAND_SPECS has no duplicate names", () => {
		expect(COMMAND_NAMES.size).toBe(COMMAND_SPECS.length);
	});

	test("CLI registry and roster declare the same command set", () => {
		const registryNames = new Set(COMMANDS.map((command) => command.name));
		expect(registryNames).toEqual(new Set(COMMAND_NAMES));
	});

	test("MCP tools and roster declare the same command set", async () => {
		// Read the registration modules as text and extract the registerTool
		// names rather than importing them, so this assertion stays independent
		// of the modules' tool-registration side effects. Split per domain in
		// #187 — the server entry no longer registers anything itself.
		const source = await readRegistrationSource();
		const mcpNames = new Set(
			[...source.matchAll(/registerTool\(\s*"([^"]+)"/g)].map(
				(match) => match[1]
			)
		);
		expect(mcpNames).toEqual(new Set(COMMAND_NAMES));
	});

	test("global help list includes every command, including the once-missing ones", () => {
		const list = formatCommandList();
		for (const { name } of COMMAND_SPECS) {
			expect(list).toContain(name);
		}
		// Regression: these two were absent from the hand-typed cli.ts list.
		expect(list).toContain("extract-component");
		expect(list).toContain("inline");
	});

	test("each help row aligns its summary into one padded column", () => {
		const rows = formatCommandList().split("\n");
		const summaryColumns = rows.map((row) => row.indexOf("  ", 3));
		// Every row shares the same summary start column (single aligned gutter).
		expect(new Set(summaryColumns).size).toBeGreaterThan(0);
		for (const row of rows) {
			expect(row.startsWith("  ")).toBe(true);
		}
	});
});

/**
 * Prose-derivation guard (#112).
 *
 * Each command's `cliHelp` (CLI `--help`) and `mcpDescription` (MCP tool
 * description) now live on its `CommandSpec`. `registry.ts` derives every
 * `helpText` from `cliHelp`, and `mcp-server.ts` derives every `registerTool`
 * description from `mcpDescription`. These tests fail if a command stops
 * deriving its prose from the spec (the drift mode this consolidation closes).
 */
describe("command prose derivation", () => {
	test("move help documents the default verification escape hatch (#158)", () => {
		const moveHelp = commandSpec("move").cliHelp;
		expect(moveHelp).toContain(
			"--no-verify       Disable type checking verification (enabled by default)"
		);
	});

	test("move help warns that transform configs execute as JavaScript (#147)", () => {
		const moveHelp = commandSpec("move").cliHelp;
		expect(moveHelp).toContain("The config is executed as");
		expect(moveHelp).toContain("only use trusted files");
	});

	test("every spec carries non-empty cliHelp and mcpDescription", () => {
		for (const spec of COMMAND_SPECS) {
			expect(spec.cliHelp.length).toBeGreaterThan(0);
			expect(spec.mcpDescription.length).toBeGreaterThan(0);
			// Structural sanity: the CLI help is a usage block naming the command.
			expect(spec.cliHelp).toContain("Usage:");
			expect(spec.cliHelp).toContain(spec.name);
		}
	});

	test("CLI registry helpText derives from the spec's cliHelp", () => {
		for (const command of COMMANDS) {
			expect(command.helpText).toBe(commandSpec(command.name).cliHelp);
		}
	});

	test("every MCP tool derives its description from the spec", async () => {
		// Assert against the registration source text, not the imported modules.
		// The registrations were split out of mcp-server.ts per domain in #187,
		// so the server entry no longer contains any tool description.
		const source = await readRegistrationSource();
		// No inline description string literals survive the consolidation.
		expect(source).not.toMatch(/description:\s*\n\s*["'`]/);
		// Every command's tool references mcpDescription("<name>").
		for (const { name } of COMMAND_SPECS) {
			expect(source).toContain(`description: mcpDescription("${name}")`);
		}
	});
});

describe("command option capabilities (#191)", () => {
	test("every parsed command option is supported by at least one command", () => {
		const globalOptions = new Set(["help", "version"]);
		const parsedCommandOptions = new Set(
			Object.keys(OPTION_FLAGS).filter((option) => !globalOptions.has(option))
		);
		const supportedOptions = new Set<string>(
			COMMANDS.flatMap((command) => [...command.options])
		);

		expect(supportedOptions).toEqual(parsedCommandOptions);
	});

	test("each command documents exactly its supported options", () => {
		for (const command of COMMANDS) {
			const documentedOptions = new Set<string>();
			for (const match of command.helpText.matchAll(
				/^\s+(?:-[a-z],\s+)?--([a-z][a-z-]*)/gm
			)) {
				const option = match[1];
				if (option) {
					documentedOptions.add(option);
				}
			}

			expect(new Set<string>(command.options)).toEqual(documentedOptions);
			expect(new Set(command.options).size).toBe(command.options.length);
		}
	});
});
