import { describe, expect, test } from "bun:test";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { cliHelp } from "./commands/command-spec.ts";
import { MCP_DESCRIPTIONS } from "./commands/mcp-descriptions.ts";
import { renameSpecifierInputSchema } from "./mcp-server.ts";
import { registerAnalysisTools } from "./mcp-tools/register-analysis.ts";
import { registerHygieneTools } from "./mcp-tools/register-hygiene.ts";
import { registerMutationTools } from "./mcp-tools/register-mutation.ts";

/**
 * MCP inputSchema ↔ CLI options parity guard (#129).
 * Record the actual schemas passed to the real registrations, including generated
 * schemas. The one-way EXPECTED table is deliberately retained until phase E.
 * json/format remain CLI-only where MCP already returns structured JSON.
 */
interface SchemaRecorder {
	registerTool(name: string, config: { inputSchema?: z.ZodRawShape }): void;
}

function recordInputSchemas(): Map<string, z.ZodRawShape> {
	const schemas = new Map<string, z.ZodRawShape>();
	const recorder: SchemaRecorder = {
		registerTool(name, config) {
			if (!config.inputSchema || schemas.has(name)) {
				throw new Error(`Missing or duplicate schema for tool "${name}"`);
			}
			schemas.set(name, config.inputSchema);
		},
	};
	// Only registerTool is exercised; handlers and transports are never started.
	const server = recorder as unknown as McpServer;
	registerAnalysisTools(server);
	registerHygieneTools(server);
	registerMutationTools(server);
	return schemas;
}

const REGISTERED_SCHEMAS = recordInputSchemas();

function registeredSchema(toolName: string): z.ZodRawShape {
	const schema = REGISTERED_SCHEMAS.get(toolName);
	if (!schema) {
		throw new Error(`Tool "${toolName}" was not registered`);
	}
	return schema;
}

function registeredInputKeys(toolName: string): string[] {
	return Object.keys(registeredSchema(toolName));
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
			const actualKeys = registeredInputKeys(toolName);
			for (const key of expectedKeys) {
				expect(actualKeys).toContain(key);
			}
		});
	}

	test('"similar" schema intentionally omits format (CLI-only text rendering)', () => {
		expect(registeredInputKeys("similar")).not.toContain("format");
	});

	test('"extract-common" schema intentionally omits json (CLI-only text rendering)', () => {
		expect(registeredInputKeys("extract-common")).not.toContain("json");
	});

	test('"extract-component" schema intentionally omits json (CLI-only text rendering)', () => {
		expect(registeredInputKeys("extract-component")).not.toContain("json");
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

const AUDIT_BASELINE = {
	help: "\nUsage: resect audit <directory> [options]\n\nAnalyze module health metrics: fan-out, fan-in, instability ratios,\nand circular dependency detection.\n\nArguments:\n  directory    Path to the project directory to scan\n\nOptions:\n  -p, --project          Path to project directory or tsconfig.json\n  --json                 Output results as JSON\n  --workspace            Scan across all workspace packages\n  --fan-out-threshold    Flag files with more than N imports (default: 10)\n  --fan-in-threshold     Flag files with more than N consumers (default: 10)\n  --export-threshold     Flag files with more than N exports (default: 8)\n  --include-ignored      Analyse git-ignored files too. Off by default: a file\n                         excluded from version control is not source, so build\n                         output cannot distort coupling metrics\n\nMetrics:\n  Fan-out       Number of distinct modules a file imports\n  Fan-in        Number of distinct files that import a module\n  Instability   fan-out / (fan-in + fan-out) — 0 = maximally stable, 1 = maximally unstable\n\nExamples:\n  resect audit src\n  resect audit . --json\n  resect audit . --workspace\n  resect audit src --fan-out-threshold=8 --export-threshold=5\n",
	schema: {
		$schema: "https://json-schema.org/draft/2020-12/schema",
		type: "object",
		properties: {
			directory: {
				type: "string",
				description:
					"Absolute or cwd-relative path to the project directory to scan",
			},
			project: {
				description:
					"Optional path to the project root or tsconfig.json. Omit to auto-resolve the tsconfig for `directory`",
				type: "string",
			},
			workspace: {
				description: "Scan across all workspace packages (default false)",
				type: "boolean",
			},
			fanOutThreshold: {
				description:
					"Flag files that import more than N distinct modules (default 10). Lower to surface more candidates",
				type: "number",
			},
			fanInThreshold: {
				description:
					"Flag files imported by more than N distinct files (default 10). High fan-in marks hub modules",
				type: "number",
			},
			exportThreshold: {
				description:
					"Flag files exporting more than N symbols (default 8). High counts suggest a module doing too much",
				type: "number",
			},
			includeIgnored: {
				description:
					"Analyse git-ignored files too (#202). Off by default: a file excluded from version control is not source, so build output cannot distort the result. Set true only to deliberately analyse generated output",
				type: "boolean",
			},
		},
		required: ["directory"],
		additionalProperties: false,
	},
};

test("audit generated presentation preserves shipped help and schema bytes", () => {
	expect(cliHelp("audit")).toBe(AUDIT_BASELINE.help);
	expect(
		JSON.stringify(z.toJSONSchema(z.object(registeredSchema("audit"))))
	).toBe(JSON.stringify(AUDIT_BASELINE.schema));
});

test("audit schema keeps directory required and thresholds optional plain numbers", () => {
	const schema = z.object(registeredSchema("audit"));
	expect(schema.safeParse({}).success).toBeFalse();
	expect(schema.parse({ directory: "." })).toEqual({ directory: "." });
	for (const key of ["fanOutThreshold", "fanInThreshold", "exportThreshold"]) {
		expect(
			schema.safeParse({ directory: ".", [key]: -0.5 }).success
		).toBeTrue();
		expect(
			schema.safeParse({ directory: ".", [key]: "10" }).success
		).toBeFalse();
	}
});

test("unregistered tools fail explicitly instead of borrowing neighboring keys", () => {
	expect(() => registeredInputKeys("missing-tool")).toThrow(
		'Tool "missing-tool" was not registered'
	);
});

test("shared describe catalogue retains every shipped variant", () => {
	const descriptions = [...REGISTERED_SCHEMAS.values()].flatMap((schema) =>
		Object.values(schema).map((leaf) => z.globalRegistry.get(leaf)?.description)
	);
	for (const family of Object.values(MCP_DESCRIPTIONS)) {
		for (const text of Object.values(family)) {
			expect(descriptions).toContain(text);
		}
	}
	expect(String(MCP_DESCRIPTIONS.includeIgnored.naming)).not.toBe(
		MCP_DESCRIPTIONS.includeIgnored.analysis
	);
});
