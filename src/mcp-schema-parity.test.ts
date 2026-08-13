import { describe, expect, test } from "bun:test";
import { renameSpecifierInputSchema } from "./mcp-server.ts";
import {
	REGISTRATION_MODULES,
	readRegistrationSource,
} from "./mcp-tools/registration-test-helpers.ts";

/**
 * MCP inputSchema ↔ CLI options parity guard (#129).
 *
 * This parses the registered `inputSchema` keys straight out of the source
 * text for each tool and compares them against the option keys its CLI
 * counterpart supports. Behavioural schemas are imported directly where a
 * source-key comparison would not exercise their validation.
 * `json`/`format` are excluded per-tool where they only toggle CLI text
 * rendering — MCP tools already return structured JSON unconditionally, so
 * those flags would be no-ops over MCP (documented in #129's resolution).
 */

// Split out of `mcp-server.ts` per domain in #187; the server entry now holds
// only construction and the register calls, so scraping it would find no tools.
const REGISTRATION_SOURCE = await readRegistrationSource();

function extractInputSchemaKeys(toolName: string): string[] {
	// Registrations sit inside `register<Domain>Tools(server)`, so every line
	// carries one more tab than it did at module top level. The depth is load
	// bearing: it selects top-level schema keys and skips nested ones (e.g. the
	// `source`/`target` pair inside `move`'s `batch` array element).
	const toolStart = REGISTRATION_SOURCE.indexOf(
		`\tserver.registerTool(\n\t\t"${toolName}",`
	);
	if (toolStart === -1) {
		throw new Error(
			`Tool "${toolName}" not found in ${REGISTRATION_MODULES.join(", ")}`
		);
	}
	const schemaStart = REGISTRATION_SOURCE.indexOf("inputSchema: {", toolStart);
	const schemaEnd = REGISTRATION_SOURCE.indexOf(
		"\n\t\t\t},\n\t\t},",
		schemaStart
	);
	const block = REGISTRATION_SOURCE.slice(schemaStart, schemaEnd);
	const keys: string[] = [];
	for (const match of block.matchAll(/\n\t\t\t\t(\w+):/g)) {
		const key = match[1];
		if (key) {
			keys.push(key);
		}
	}
	return keys;
}

/**
 * Expected MCP schema keys per tool, derived from the CLI's options
 * interface, minus keys intentionally excluded (see module docstring) and
 * plus MCP-only fields (`directory`/`project` path resolution, `verify`
 * defaults) that don't come from the CLI options interface directly.
 */
const EXPECTED: Record<string, string[]> = {
	deps: ["directory", "fix", "dryRun", "force", "strict"],
	move: [
		"source",
		"target",
		"batch",
		"project",
		"dryRun",
		"force",
		"journal",
		"verify",
		"verbose",
		"transform",
		"prefer",
		"extensions",
	],
	rename: [
		"file",
		"oldName",
		"newName",
		"project",
		"workspace",
		"dryRun",
		"force",
		"journal",
		"verify",
		"verbose",
	],
	audit: [
		"directory",
		"project",
		"workspace",
		"fanOutThreshold",
		"fanInThreshold",
		"exportThreshold",
		"includeIgnored",
	],
	alias: [
		"target",
		"prefer",
		"extensions",
		"renameSpecifiers",
		"project",
		"dryRun",
		"force",
		"journal",
		"verify",
	],
	undo: ["id", "project", "dryRun", "force", "verify"],
	tidy: [
		"directory",
		"experimental",
		"project",
		"scope",
		"workspace",
		"dryRun",
		"force",
		"journal",
		"fixCategories",
		"aliasPrefer",
		"maxChanges",
		"fanOutThreshold",
		"fanInThreshold",
		"exportThreshold",
	],
	similar: [
		"directory",
		"project",
		"threshold",
		"maxGroups",
		"nameThreshold",
		"sameNameOnly",
		"skipSameFile",
		"minLines",
		"kinds",
		"bucket", // #129
		"includeIgnored", // #202
	],
	"extract-common": [
		"directory",
		"project",
		"threshold",
		"group",
		"output",
		"workspace",
		"dryRun",
		"force",
		"verify",
		"nameThreshold",
		"sameNameOnly",
		"skipSameFile",
		"minLines",
		"skipDirectives",
		"skipWrappers",
		"strict", // #129
	],
	unused: [
		"directory",
		"project",
		"ignore",
		"entrypointGlobs", // #129
		"includeIgnored", // #202
	],
	analyze: ["file", "project", "entrypointGlobs"],
	naming: [
		"directory",
		"project",
		"workspace",
		"minSiblings",
		"majorityThreshold",
		"case",
		"includeTests",
		"includeIgnored", // #202
		"fix",
		"dryRun",
		"force",
	],
};

describe("MCP inputSchema ↔ CLI options parity (#129)", () => {
	for (const [toolName, expectedKeys] of Object.entries(EXPECTED)) {
		test(`"${toolName}" MCP schema includes every expected CLI-parity key`, () => {
			const actualKeys = extractInputSchemaKeys(toolName);
			for (const key of expectedKeys) {
				expect(actualKeys).toContain(key);
			}
		});
	}

	test('"similar" schema intentionally omits format (CLI-only text rendering)', () => {
		expect(extractInputSchemaKeys("similar")).not.toContain("format");
	});

	test('"extract-common" schema intentionally omits json (CLI-only text rendering)', () => {
		expect(extractInputSchemaKeys("extract-common")).not.toContain("json");
	});

	test('"extract-component" schema intentionally omits json (CLI-only text rendering)', () => {
		expect(extractInputSchemaKeys("extract-component")).not.toContain("json");
	});

	test('"alias" rejects malformed rename specifiers at the MCP schema boundary', () => {
		const result = renameSpecifierInputSchema.safeParse("@scope/old");

		expect(result.success).toBe(false);
		if (!result.success) {
			expect(result.error.issues[0]?.message).toBe("Must be '<from>=<to>'");
		}
		expect(
			renameSpecifierInputSchema.safeParse("@scope/old=@scope/new").success
		).toBe(true);
	});
});
