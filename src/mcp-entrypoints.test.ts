import { describe, expect, test } from "bun:test";
import path from "node:path";
import {
	cleanup,
	makeFixture,
	parseMcpTextPayload,
} from "./commands/__test-helpers.ts";
import { analyzeTool, unusedTool } from "./mcp-server.ts";

interface AnalyzeEntrypointPayload {
	externalUsageAssumed: boolean;
	noExternalUsage: boolean;
	publicApiExports: Array<{ name: string }>;
	publicApiTraceIncomplete: boolean;
	unusedExports: Array<{ name: string }>;
}

interface UnusedEntrypointPayload {
	excludedEntrypointFileCount: number;
	excludedEntrypointFiles: string[];
	publicApiExportCount: number;
	publicApiExports: Array<{ file: string; name: string }>;
	unused: Array<{ file: string; name: string }>;
	orphanFiles: Array<{ file: string }>;
}

describe("MCP framework and configured entrypoints", () => {
	// @BDD: ANLY-003-Verified
	// @BDD: ANLY-004-Verified
	// @BDD: ANLY-005-Verified
	test("agrees with library and CLI verdicts for assumed external usage", async () => {
		const dir = await makeFixture("mcp-entrypoints", {
			"package.json": JSON.stringify({
				name: "@scope/fixture",
				exports: "./src/public.ts",
			}),
			"tsconfig.json": JSON.stringify({
				compilerOptions: { strict: true },
				include: ["src/**/*.ts"],
			}),
			"src/app/api/example/route.ts": "export async function GET() {}\n",
			"src/hooks/dispatch.ts": "export function runHook() {}\n",
			"src/lib/route.ts": "export function GET() { return 'ordinary'; }\n",
			"src/public.ts": "export const publicApi = 1;\n",
		});
		try {
			const project = path.join(dir, "tsconfig.json");
			const routeFile = path.join(dir, "src/app/api/example/route.ts");
			const hookFile = path.join(dir, "src/hooks/dispatch.ts");
			const ordinaryFile = path.join(dir, "src/lib/route.ts");
			const publicFile = path.join(dir, "src/public.ts");

			const route = parseMcpTextPayload<AnalyzeEntrypointPayload>(
				await analyzeTool(routeFile, { project })
			);
			expect(route.externalUsageAssumed).toBeTrue();
			expect(route.noExternalUsage).toBeFalse();
			expect(route.unusedExports).toHaveLength(0);

			const configured = parseMcpTextPayload<AnalyzeEntrypointPayload>(
				await analyzeTool(hookFile, {
					project,
					entrypointGlobs: "src/hooks/**",
				})
			);
			expect(configured.externalUsageAssumed).toBeTrue();
			expect(configured.unusedExports).toHaveLength(0);

			const ordinary = parseMcpTextPayload<AnalyzeEntrypointPayload>(
				await analyzeTool(ordinaryFile, { project })
			);
			expect(ordinary.externalUsageAssumed).toBeFalse();
			expect(ordinary.noExternalUsage).toBeTrue();
			expect(ordinary.unusedExports.map((item) => item.name)).toEqual(["GET"]);

			const packagePublic = parseMcpTextPayload<AnalyzeEntrypointPayload>(
				await analyzeTool(publicFile, { project })
			);
			expect(packagePublic.publicApiExports.map((item) => item.name)).toEqual([
				"publicApi",
			]);
			expect(packagePublic.publicApiTraceIncomplete).toBeFalse();
			expect(packagePublic.noExternalUsage).toBeFalse();
			expect(packagePublic.unusedExports).toHaveLength(0);

			const unused = parseMcpTextPayload<UnusedEntrypointPayload>(
				await unusedTool(dir, { project })
			);
			expect(unused.excludedEntrypointFileCount).toBe(1);
			expect(unused.excludedEntrypointFiles).toEqual([
				path.join("src", "app", "api", "example", "route.ts"),
			]);
			expect(unused.publicApiExportCount).toBe(1);
			expect(
				unused.publicApiExports.map(({ file, name }) => ({ file, name }))
			).toEqual([{ file: path.join("src", "public.ts"), name: "publicApi" }]);
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
