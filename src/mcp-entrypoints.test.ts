import { describe, expect, test } from "bun:test";
import path from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { cleanup, makeFixture } from "./commands/__test-helpers.ts";
import { analyzeTool, unusedTool } from "./mcp-server.ts";

interface AnalyzeEntrypointPayload {
	externalUsageAssumed: boolean;
	noExternalUsage: boolean;
	unusedExports: Array<{ name: string }>;
}

interface UnusedEntrypointPayload {
	excludedEntrypointFileCount: number;
	excludedEntrypointFiles: string[];
	unused: Array<{ file: string; name: string }>;
	orphanFiles: Array<{ file: string }>;
}

function parsePayload<T>(result: CallToolResult): T {
	const content = result.content[0];
	if (content?.type !== "text") {
		throw new Error("Expected an MCP text result");
	}
	return JSON.parse(content.text) as T;
}

describe("MCP framework and configured entrypoints", () => {
	test("agrees with library and CLI verdicts for assumed external usage", async () => {
		const dir = await makeFixture("mcp-entrypoints", {
			"tsconfig.json": JSON.stringify({
				compilerOptions: { strict: true },
				include: ["src/**/*.ts"],
			}),
			"src/app/api/example/route.ts": "export async function GET() {}\n",
			"src/hooks/dispatch.ts": "export function runHook() {}\n",
			"src/lib/route.ts": "export function GET() { return 'ordinary'; }\n",
		});
		try {
			const project = path.join(dir, "tsconfig.json");
			const routeFile = path.join(dir, "src/app/api/example/route.ts");
			const hookFile = path.join(dir, "src/hooks/dispatch.ts");
			const ordinaryFile = path.join(dir, "src/lib/route.ts");

			const route = parsePayload<AnalyzeEntrypointPayload>(
				await analyzeTool(routeFile, { project })
			);
			expect(route.externalUsageAssumed).toBeTrue();
			expect(route.noExternalUsage).toBeFalse();
			expect(route.unusedExports).toHaveLength(0);

			const configured = parsePayload<AnalyzeEntrypointPayload>(
				await analyzeTool(hookFile, {
					project,
					entrypointGlobs: "src/hooks/**",
				})
			);
			expect(configured.externalUsageAssumed).toBeTrue();
			expect(configured.unusedExports).toHaveLength(0);

			const ordinary = parsePayload<AnalyzeEntrypointPayload>(
				await analyzeTool(ordinaryFile, { project })
			);
			expect(ordinary.externalUsageAssumed).toBeFalse();
			expect(ordinary.noExternalUsage).toBeTrue();
			expect(ordinary.unusedExports.map((item) => item.name)).toEqual(["GET"]);

			const unused = parsePayload<UnusedEntrypointPayload>(
				await unusedTool(dir, { project })
			);
			expect(unused.excludedEntrypointFileCount).toBe(1);
			expect(unused.excludedEntrypointFiles).toEqual([
				path.join("src", "app", "api", "example", "route.ts"),
			]);
			expect(unused.unused).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						file: path.join("src", "hooks", "dispatch.ts"),
						name: "runHook",
					}),
					expect.objectContaining({
						file: path.join("src", "lib", "route.ts"),
						name: "GET",
					}),
				])
			);
			expect(unused.orphanFiles.map((item) => item.file)).toEqual([
				path.join("src", "hooks", "dispatch.ts"),
				path.join("src", "lib", "route.ts"),
			]);
		} finally {
			await cleanup(dir);
		}
	});
});
