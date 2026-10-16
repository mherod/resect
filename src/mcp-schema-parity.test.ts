import { describe, expect, test } from "bun:test";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { makeFixture, parseMcpTextPayload } from "./commands/__test-helpers.ts";
import { COMMAND_SPECS, cliHelp } from "./commands/command-spec.ts";
import { MCP_DESCRIPTIONS } from "./commands/mcp-descriptions.ts";
import { COMMANDS } from "./commands/registry.ts";
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
	registerTool(
		name: string,
		config: { inputSchema?: z.ZodRawShape },
		handler: RecordedHandler
	): void;
}

type RecordedHandler = (
	args: Record<string, unknown>
) => Promise<CallToolResult>;
const REGISTERED_HANDLERS = new Map<string, RecordedHandler>();

function recordInputSchemas(): Map<string, z.ZodRawShape> {
	const schemas = new Map<string, z.ZodRawShape>();
	const recorder: SchemaRecorder = {
		registerTool(name, config, handler) {
			if (!config.inputSchema || schemas.has(name)) {
				throw new Error(`Missing or duplicate schema for tool "${name}"`);
			}
			schemas.set(name, config.inputSchema);
			REGISTERED_HANDLERS.set(name, handler);
		},
	};
	// Recording does not execute handlers or start transports.
	const server = recorder as unknown as McpServer;
	registerAnalysisTools(server);
	registerHygieneTools(server);
	registerMutationTools(server);
	return schemas;
}

const REGISTERED_SCHEMAS = recordInputSchemas();

// Frozen from the pre-migration registrations at 3e4bf3d. These compatibility
// receipts cover full schema descriptions/types/optionality and exact help bytes,
// independently of descriptor derivation. Phase E still owns the EXPECTED table.
const REPORT_BASELINE = {
	// Move receipt captured at 2b60d77 before its scalar descriptor migration.
	move: {
		help: "1a5c660e11a325b6b41942650084dc3fe0f86fd186fac7032ee50e5b9878bdeb",
		schema: "3772fc6a5cb53a7ac56743e5e355330eaa4ceffb53f650a3818cccf186248b74",
		prose: "d44c3a7a90ba752524910f8d88dd8fec30b3539338133cdca64526bfd09e549a",
		flags: [
			"batch",
			"dry-run",
			"force",
			"journal",
			"json",
			"verbose",
			"verify",
			"no-verify",
			"project",
			"workspace",
			"transform",
			"prefer",
			"extensions",
		],
	},
	audit: {
		help: "423c239de021c7aa375bc8767c337f9eeaba2119d6964396809424d50fad7e8f",
		schema: "cf6b850f63c8a362b4840bdadfaf4d9fa4f43a5001a8de2518a7e5954c9ac374",
		flags: [
			"project",
			"json",
			"workspace",
			"fan-out-threshold",
			"fan-in-threshold",
			"export-threshold",
			"include-ignored",
		],
		prose: "f55d3ff8373a38c59f071bc9dc6c36d583134a1ecdd9b11857a9b69e769d7565",
	},
	barrel: {
		help: "fa077b7881330611658d39acaed4471412656e81936e7e5ee8392a6e525793fe",
		schema: "366afa9284b0bcf424c339b4272b9c3c0afffed2f0f45a0968866488282b13b8",
		flags: ["project", "json", "workspace", "verbose", "include-ignored"],
		prose: "0b125756c0cea2e60c36cbeff58cc85cd16c1e92df9edb3c87527754be4908d3",
	},
	unused: {
		help: "62bc72d0d0ced54fac48841fc07a96febd6975191a8e50587a296f854a271be8",
		schema: "9fcddd946cf323a38d284b44071e8f70a26f6599db0de80424fa5d3a72434fc2",
		flags: [
			"project",
			"json",
			"verbose",
			"ignore",
			"workspace",
			"entrypoint-globs",
			"include-ignored",
		],
		prose: "38d84b4e515ca50b3c88c0398eabbf31484c7240c4ef2d5229a2b741ea8221e1",
	},
	similar: {
		help: "adfcc15f5e26b25882f3484cdd1cb6741b40f658675ae5b3348cf5846a4d46d9",
		schema: "b93d0e41649a4ae44e83be95f5379fb6fc60b44cf1726468ca7779b300f2314c",
		flags: [
			"project",
			"json",
			"threshold",
			"max-groups",
			"strict",
			"workspace",
			"name-threshold",
			"same-name-only",
			"skip-same-file",
			"only-related-to",
			"min-lines",
			"skip-directives",
			"skip-wrappers",
			"kinds",
			"bucket",
			"format",
			"include-ignored",
		],
		prose: "3917d35d5128cdd6d145391e28305d93459238993116373b028d1c60838e0ee0",
	},
} as const;

function stableContract(value: unknown): unknown {
	if (Array.isArray(value)) {
		return value.map(stableContract);
	}
	if (value && typeof value === "object") {
		return Object.fromEntries(
			Object.entries(value)
				.sort(([left], [right]) => left.localeCompare(right))
				.map(([key, item]) => [key, stableContract(item)])
		);
	}
	return value;
}

function contractHash(value: unknown): string {
	return new Bun.CryptoHasher("sha256")
		.update(
			typeof value === "string" ? value : JSON.stringify(stableContract(value))
		)
		.digest("hex");
}

for (const [name, baseline] of Object.entries(REPORT_BASELINE)) {
	test(`${name} preserves its registered schema and exact CLI presentation`, () => {
		const command = COMMANDS.find((candidate) => candidate.name === name);
		const spec = COMMAND_SPECS.find((candidate) => candidate.name === name);
		expect(command).toBeDefined();
		expect(spec).toBeDefined();
		expect(command?.options).toEqual(baseline.flags);
		expect(contractHash(command?.helpText)).toBe(baseline.help);
		expect(
			contractHash([spec?.usage, spec?.summary, spec?.mcpDescription])
		).toBe(baseline.prose);
		expect(contractHash(z.toJSONSchema(z.object(registeredSchema(name))))).toBe(
			baseline.schema
		);
	});
}

test("move MCP inputs retain optional scalars and non-empty structured batches", () => {
	const schema = z.object(registeredSchema("move"));
	expect(schema.parse({})).toEqual({});
	for (const key of ["dryRun", "force", "journal", "verify", "verbose"]) {
		expect(schema.parse({ [key]: false })).toEqual({ [key]: false });
		expect(schema.safeParse({ [key]: "false" }).success).toBeFalse();
	}
	for (const prefer of ["alias", "relative", "shortest"]) {
		expect(schema.parse({ prefer })).toEqual({ prefer });
	}
	for (const extensions of ["preserve", "explicit"]) {
		expect(schema.parse({ extensions })).toEqual({ extensions });
	}
	for (const key of ["prefer", "extensions"]) {
		for (const invalid of ["", "invalid", [], 1]) {
			expect(schema.safeParse({ [key]: invalid }).success).toBeFalse();
		}
	}
	for (const batch of [
		[],
		"moves.json",
		[{}],
		[{ source: "", target: "b.ts" }],
		[{ source: "a.ts", target: "" }],
	]) {
		expect(schema.safeParse({ batch }).success).toBeFalse();
	}
	const batch = [
		{ source: "a.ts", target: "b.ts" },
		{ source: "c.ts", target: "d.ts" },
	];
	expect(schema.parse({ batch })).toEqual({ batch });
	// Cross-field mode checks remain in the handler, not the scalar schema.
	expect(schema.parse({ source: "", target: "", batch })).toEqual({
		source: "",
		target: "",
		batch,
	});
	for (const key of ["json", "workspace", "noVerify"]) {
		expect(registeredSchema("move")).not.toHaveProperty(key);
	}
});

test("move registration keeps default previews and rejects mixed or missing modes", async () => {
	const handler = REGISTERED_HANDLERS.get("move");
	if (!handler) {
		throw new Error("Move handler was not registered");
	}
	const sourceText = "export const value = 1;\n";
	const dir = await makeFixture(
		"move-mcp-descriptor-preview",
		{
			"tsconfig.json": JSON.stringify({
				compilerOptions: { module: "ESNext", moduleResolution: "Bundler" },
				include: ["*.ts"],
			}),
			"source.ts": sourceText,
		},
		{ outsideRepo: true }
	);
	const source = `${dir}/source.ts`;
	const target = `${dir}/moved.ts`;
	const batch = [{ source, target }];
	for (const mode of [{ source, target }, { batch }]) {
		const response = await handler({ ...mode, project: dir });
		expect(response.isError).not.toBeTrue();
		expect(parseMcpTextPayload<{ success: boolean }>(response)).toMatchObject({
			success: true,
		});
		expect(await Bun.file(source).text()).toBe(sourceText);
		expect(await Bun.file(target).exists()).toBeFalse();
	}
	for (const mode of [
		{},
		{ source },
		{ target },
		{ source, batch },
		{ target, batch },
	]) {
		const response = await handler(mode);
		expect(response.isError).toBeTrue();
		const expected =
			"batch" in mode
				? "Provide either batch or source+target for move, not both."
				: "Move requires source+target or a non-empty batch.";
		expect(response.content).toEqual([{ type: "text", text: expected }]);
	}
});

test("report MCP input cardinality and optionality remain independent of CLI parsing", () => {
	const unused = z.object(registeredSchema("unused"));
	for (const entrypointGlobs of ["hooks/**", ["hooks/**", "scripts/*"], []]) {
		expect(
			unused.parse({ directory: "", entrypointGlobs }).entrypointGlobs
		).toEqual(entrypointGlobs);
	}
	expect(
		unused.safeParse({ directory: ".", entrypointGlobs: 1 }).success
	).toBeFalse();
	expect(unused.parse({ directory: "." }).entrypointGlobs).toBeUndefined();
	expect(unused.safeParse({}).success).toBeFalse();
	const similar = z.object(registeredSchema("similar"));
	expect(Object.keys(registeredSchema("similar"))).toHaveLength(11);
	expect(Object.keys(registeredSchema("unused"))).toHaveLength(6);
	expect(Object.keys(registeredSchema("barrel"))).toHaveLength(4);
	expect(
		similar.parse({
			directory: ".",
			threshold: -1,
			maxGroups: 1.5,
			minLines: -2,
		})
	).toMatchObject({ threshold: -1, maxGroups: 1.5, minLines: -2 });
	expect(similar.parse({ directory: "." }).threshold).toBeUndefined();
	for (const kinds of [[], ["function", "interface", "type"]]) {
		expect(similar.parse({ directory: ".", kinds }).kinds).toEqual(kinds);
	}
	for (const kinds of ["function", ["invalid"], [1]]) {
		expect(similar.safeParse({ directory: ".", kinds }).success).toBeFalse();
	}
	for (const bucket of ["exact", "high", "medium"]) {
		expect(similar.parse({ directory: ".", bucket }).bucket).toBe(bucket);
	}
	for (const bucket of ["", "unknown", 1]) {
		expect(similar.safeParse({ directory: ".", bucket }).success).toBeFalse();
	}
	for (const key of [
		"json",
		"strict",
		"workspace",
		"onlyRelatedTo",
		"skipDirectives",
		"skipWrappers",
		"format",
	]) {
		expect(registeredSchema("similar")).not.toHaveProperty(key);
	}
});

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
