import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { toCliHelpOptions } from "./option-descriptor-help.ts";

test("help generator renders aliases, defaults and continuation lines", () => {
	const help = toCliHelpOptions([
		{
			name: "project",
			key: "project",
			type: "string",
			short: "p",
			cliHelp: { description: "Project\nSecond line" },
		},
		{
			name: "threshold",
			key: "threshold",
			type: "number",
			default: 3,
			cliHelp: { description: (value) => `Default ${String(value)}` },
		},
	]);
	expect(help).toBe(
		"  -p, --project          Project\n                         Second line\n  --threshold            Default 3"
	);
});

test("help generator handles empty options and reports missing prose", () => {
	expect(toCliHelpOptions([])).toBe("");
	expect(() =>
		toCliHelpOptions([{ name: "json", key: "json", type: "boolean" }])
	).toThrow("Missing CLI help for --json");
});

test("command spec's runtime import graph stays zod-free", async () => {
	const zodImports: string[] = [];
	const result = await Bun.build({
		entrypoints: [resolve(import.meta.dir, "command-spec.ts")],
		target: "bun",
		plugins: [
			{
				name: "record-zod-imports",
				setup(build) {
					build.onResolve({ filter: /^zod(?:\/|$)/ }, ({ path }) => {
						zodImports.push(path);
						return { path, external: true };
					});
				},
			},
		],
	});
	expect(result.success).toBeTrue();
	expect(zodImports).toEqual([]);
});

test("production zod-generator consumers stay in MCP registrations", async () => {
	const sourceRoot = resolve(import.meta.dir, "..");
	const consumers: string[] = [];
	for await (const path of new Bun.Glob("**/*.ts").scan(sourceRoot)) {
		if (path.endsWith(".test.ts") || path.includes("__fixtures__")) {
			continue;
		}
		const source = await Bun.file(resolve(sourceRoot, path)).text();
		if (/from\s+["'][^"']*option-descriptor-zod\.ts["']/.test(source)) {
			consumers.push(path);
		}
	}
	expect(consumers).toContain("mcp-tools/register-analysis.ts");
	expect(
		consumers.every((path) => /^mcp-tools\/register-[^/]+\.ts$/.test(path))
	).toBeTrue();
});
