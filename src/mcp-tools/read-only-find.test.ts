import { afterAll, beforeAll, expect, test } from "bun:test";
import path from "node:path";
import {
	cleanup,
	makeFixture,
	parseMcpTextPayload,
} from "../commands/__test-helpers.ts";
import { findTool } from "./read-only.ts";

interface FindPayload {
	query: string;
	files: string[];
	exports: Array<{ name: string; file: string }>;
}

/**
 * Two configs with different membership (#257): the build config excludes
 * tests and never sees scripts, while the default config owns all three.
 */
const TWO_CONFIG_FILES = {
	"tsconfig.json": JSON.stringify({ include: ["src/**/*.ts", "scripts/*.ts"] }),
	"tsconfig.build.json": JSON.stringify({
		include: ["src/**/*.ts"],
		exclude: ["src/**/*.test.ts"],
	}),
	"src/widget.ts": "export function widgetTotal() { return 1; }",
	"src/widget.test.ts": "export const widgetCase = 'case';",
	"scripts/widget-tool.ts": "export const widgetTool = true;",
};

let fixture = "";

beforeAll(async () => {
	fixture = await makeFixture("find-config-scope", TWO_CONFIG_FILES);
});

afterAll(async () => {
	await cleanup(fixture);
});

async function find(
	query: string,
	project: string,
	type?: "file" | "export" | "all"
): Promise<FindPayload> {
	const result = await findTool(query, project, type);
	if (result.isError) {
		throw new Error(`find failed for ${project}: ${parseText(result)}`);
	}
	return parseMcpTextPayload<FindPayload>(result);
}

test("find accepts an absolute or relative tsconfig path (#257)", async () => {
	const config = path.join(fixture, "tsconfig.json");
	const relative = path.relative(process.cwd(), config);
	const directory = await find("widget", fixture);
	// Exact basename matches rank first; this is the shipped directory order.
	expect(directory.files).toEqual([
		"src/widget.ts",
		"scripts/widget-tool.ts",
		"src/widget.test.ts",
	]);
	expect(await find("widget", config)).toEqual(directory);
	expect(await find("widget", relative)).toEqual(directory);
});

test("a named config limits files and exports to its own membership", async () => {
	const build = path.join(fixture, "tsconfig.build.json");
	for (const type of ["file", "export", "all"] as const) {
		const payload = await find("widget", build, type);
		if (type !== "export") {
			expect(payload.files).toEqual(["src/widget.ts"]);
		}
		if (type !== "file") {
			expect(payload.exports.map(({ name, file }) => [name, file])).toEqual([
				["widgetTotal", "src/widget.ts"],
			]);
		}
	}
});

test("directory input keeps discovery across every config", async () => {
	const payload = await find("widget", fixture, "export");
	expect(payload.exports.map(({ name }) => name).sort()).toEqual([
		"widgetCase",
		"widgetTool",
		"widgetTotal",
	]);
});

test("missing, invalid and empty config inputs return structured results", async () => {
	const broken = await makeFixture("find-config-broken", {
		"tsconfig.json": "{ not json",
		"source.ts": "export const value = 1;",
	});
	try {
		const missingConfig = path.join(fixture, "tsconfig.missing.json");
		const missing = await findTool("widget", missingConfig);
		expect(missing.isError).toBeTrue();
		expect(parseText(missing)).toBe(`tsconfig not found: ${missingConfig}`);

		const missingDirectory = path.join(fixture, "absent");
		const absent = await findTool("widget", missingDirectory);
		expect(absent.isError).toBeTrue();
		expect(parseText(absent)).toBe(
			`No tsconfig.json files found in ${missingDirectory}`
		);

		const invalidConfig = path.join(broken, "tsconfig.json");
		const invalid = await findTool("value", invalidConfig);
		expect(invalid.isError).toBeTrue();
		expect(parseText(invalid)).toStartWith(
			`Invalid tsconfig: ${invalidConfig}: `
		);

		const empty = await find(
			"nothing-matches",
			path.join(fixture, "tsconfig.build.json")
		);
		expect(empty).toEqual({ query: "nothing-matches", files: [], exports: [] });
	} finally {
		await cleanup(broken);
	}
});

function parseText(result: Awaited<ReturnType<typeof findTool>>): string {
	const [first] = result.content;
	return first?.type === "text" ? first.text : "";
}
