import { describe, expect, test } from "bun:test";
import path from "node:path";

/**
 * MCP inputSchema ↔ CLI options parity guard (#129).
 *
 * mcp-server.ts calls `server.connect()` at module load, so it cannot be
 * imported directly in a test — instead this parses the registered
 * `inputSchema` keys straight out of the source text for each tool and
 * compares them against the option keys its CLI counterpart supports.
 * `json`/`format` are excluded per-tool where they only toggle CLI text
 * rendering — MCP tools already return structured JSON unconditionally, so
 * those flags would be no-ops over MCP (documented in #129's resolution).
 */

const MCP_SERVER_SOURCE = await Bun.file(
	path.join(import.meta.dir, "mcp-server.ts")
).text();

function extractInputSchemaKeys(toolName: string): string[] {
	const toolStart = MCP_SERVER_SOURCE.indexOf(`"${toolName}",`);
	if (toolStart === -1) {
		throw new Error(`Tool "${toolName}" not found in mcp-server.ts`);
	}
	const schemaStart = MCP_SERVER_SOURCE.indexOf("inputSchema: {", toolStart);
	const schemaEnd = MCP_SERVER_SOURCE.indexOf("\n\t\t},\n\t},", schemaStart);
	const block = MCP_SERVER_SOURCE.slice(schemaStart, schemaEnd);
	const keys: string[] = [];
	for (const match of block.matchAll(/\n\t\t\t(\w+):/g)) {
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
	move: [
		"source",
		"target",
		"batch",
		"project",
		"dryRun",
		"force",
		"verify",
		"verbose",
		"transform",
		"prefer",
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
});
