import { describe, expect, test } from "bun:test";
import path from "node:path";
import type { BarrelScan } from "../types/barrel.ts";
import { CLI, captureOutput, cleanup, makeFixture } from "./__test-helpers.ts";
import {
	type BarrelReportContext,
	barrelCommand,
	barrelReportToJson,
	buildBarrelReport,
} from "./barrel.ts";

// ─── Helpers ───────────────────────────────────────────────────────────────

function makeContext(
	overrides: Partial<BarrelReportContext> = {}
): BarrelReportContext {
	return {
		barrelFiles: new Set<string>(),
		skippedFiles: [],
		consumersOf: () => 1,
		subpathExportOf: () => null,
		...overrides,
	};
}

// ─── buildBarrelReport ───────────────────────────────────────────────────────

describe("buildBarrelReport", () => {
	test("counts entry kinds and source modules per barrel", () => {
		const scans: BarrelScan[] = [
			{
				barrel: "/repo/src/index.ts",
				entries: [
					{ type: "all", from: "./a" },
					{ type: "named", name: "x", from: "./b" },
					{ type: "named", name: "y", from: "./b" },
					{ type: "all-as", name: "ns", from: "./c" },
				],
				reExportedFiles: ["/repo/src/a.ts", "/repo/src/b.ts", "/repo/src/c.ts"],
			},
		];
		const report = buildBarrelReport(scans, makeContext());

		expect(report.totalBarrels).toBe(1);
		const info = report.barrels[0];
		expect(info?.totalEntries).toBe(4);
		expect(info?.sourceModules).toBe(3);
		expect(info?.wildcardCount).toBe(1);
		expect(info?.namedCount).toBe(2);
		expect(info?.namespaceCount).toBe(1);
	});

	test("flags barrels with wildcard re-exports", () => {
		const scans: BarrelScan[] = [
			{
				barrel: "/repo/src/index.ts",
				entries: [{ type: "all", from: "./a" }],
				reExportedFiles: ["/repo/src/a.ts"],
			},
			{
				barrel: "/repo/src/named.ts",
				entries: [{ type: "named", name: "x", from: "./b" }],
				reExportedFiles: ["/repo/src/b.ts"],
			},
		];
		const report = buildBarrelReport(scans, makeContext());

		expect(report.wildcardBarrels.map((b) => b.barrel)).toEqual([
			"/repo/src/index.ts",
		]);
	});

	test("detects barrel chains (barrels re-exporting other barrels)", () => {
		const scans: BarrelScan[] = [
			{
				barrel: "/repo/src/index.ts",
				entries: [{ type: "all", from: "./feature" }],
				reExportedFiles: ["/repo/src/feature/index.ts"],
			},
		];
		const report = buildBarrelReport(
			scans,
			makeContext({
				barrelFiles: new Set(["/repo/src/feature/index.ts"]),
			})
		);

		expect(report.chainedBarrels).toHaveLength(1);
		expect(report.chainedBarrels[0]?.reExportsBarrels).toEqual([
			"/repo/src/feature/index.ts",
		]);
	});

	test("flags unused barrels (no importers)", () => {
		const scans: BarrelScan[] = [
			{
				barrel: "/repo/src/used.ts",
				entries: [{ type: "named", name: "x", from: "./a" }],
				reExportedFiles: ["/repo/src/a.ts"],
			},
			{
				barrel: "/repo/src/orphan.ts",
				entries: [{ type: "named", name: "y", from: "./b" }],
				reExportedFiles: ["/repo/src/b.ts"],
			},
		];
		const report = buildBarrelReport(
			scans,
			makeContext({
				consumersOf: (file) => (file === "/repo/src/orphan.ts" ? 0 : 3),
			})
		);

		expect(report.unusedBarrels.map((b) => b.barrel)).toEqual([
			"/repo/src/orphan.ts",
		]);
	});

	// @BDD: BARL-001-Verified
	// @BDD: BARL-002-Verified
	test("keeps framework metadata barrels observable without marking them unused", () => {
		const frameworkBarrels = [
			"/repo/app/twitter-image.tsx",
			"/repo/app/blog/opengraph-image.tsx",
			"/repo/src/app/sitemap.ts",
		];
		const ordinaryBarrels = [
			"/repo/lib/twitter-image.tsx",
			"/repo/packages/app/lib/twitter-image.tsx",
		];
		const scans: BarrelScan[] = [...frameworkBarrels, ...ordinaryBarrels].map(
			(barrel) => ({
				barrel,
				entries: [{ type: "named", name: "value", from: "./source" }],
				reExportedFiles: [path.join(path.dirname(barrel), "source.ts")],
			})
		);

		const report = buildBarrelReport(
			scans,
			makeContext({ consumersOf: () => 0 })
		);

		expect(report.barrels.map(({ barrel }) => barrel)).toEqual([
			...frameworkBarrels,
			...ordinaryBarrels,
		]);
		expect(report.unusedBarrels.map(({ barrel }) => barrel)).toEqual(
			ordinaryBarrels
		);
	});

	test("reports sub-path export shadowing (#93) and dedupes per barrel+file", () => {
		const scans: BarrelScan[] = [
			{
				barrel: "/repo/packages/utils/src/index.ts",
				entries: [
					{ type: "all", from: "./cn" },
					{ type: "all", from: "./cn" },
				],
				reExportedFiles: ["/repo/packages/utils/src/cn.ts"],
			},
		];
		const report = buildBarrelReport(
			scans,
			makeContext({
				subpathExportOf: (file) =>
					file === "/repo/packages/utils/src/cn.ts"
						? { packageName: "@scope/utils", specifier: "@scope/utils/cn" }
						: null,
			})
		);

		expect(report.subpathShadowing).toHaveLength(1);
		expect(report.subpathShadowing[0]).toEqual({
			barrel: "/repo/packages/utils/src/index.ts",
			file: "/repo/packages/utils/src/cn.ts",
			packageName: "@scope/utils",
			specifier: "@scope/utils/cn",
		});
	});

	test("no shadowing when no dedicated sub-path export exists", () => {
		const scans: BarrelScan[] = [
			{
				barrel: "/repo/src/index.ts",
				entries: [{ type: "all", from: "./a" }],
				reExportedFiles: ["/repo/src/a.ts"],
			},
		];
		const report = buildBarrelReport(scans, makeContext());
		expect(report.subpathShadowing).toEqual([]);
	});

	test("sorts barrels by total entries descending", () => {
		const scans: BarrelScan[] = [
			{
				barrel: "/repo/src/small.ts",
				entries: [{ type: "named", name: "x", from: "./a" }],
				reExportedFiles: ["/repo/src/a.ts"],
			},
			{
				barrel: "/repo/src/big.ts",
				entries: [
					{ type: "named", name: "x", from: "./a" },
					{ type: "named", name: "y", from: "./b" },
				],
				reExportedFiles: ["/repo/src/a.ts", "/repo/src/b.ts"],
			},
		];
		const report = buildBarrelReport(scans, makeContext());
		expect(report.barrels.map((b) => b.barrel)).toEqual([
			"/repo/src/big.ts",
			"/repo/src/small.ts",
		]);
	});

	test("exposes skipped-file coverage in reports and JSON", () => {
		const report = buildBarrelReport(
			[],
			makeContext({ skippedFiles: ["/repo/src/unreadable.ts"] })
		);
		const json = barrelReportToJson(report, "/repo");

		expect(report.skippedFiles).toEqual(["/repo/src/unreadable.ts"]);
		expect(json.skippedFileCount).toBe(1);
		expect(json.skippedFiles).toEqual(["src/unreadable.ts"]);
	});
});

describe("barrel command coverage", () => {
	// @BDD: BARL-001-Verified
	// @BDD: BARL-002-Verified
	test("filters framework metadata barrels consistently in JSON and human output", async () => {
		const dir = await makeFixture(
			"barrel-framework-entrypoints",
			{
				"tsconfig.json": JSON.stringify({
					compilerOptions: { jsx: "preserve", strict: true },
					include: ["app/**/*", "lib/**/*"],
				}),
				"app/metadata-source.ts": [
					'export const alt = "Example";',
					"export const size = { width: 1200, height: 630 };",
					'export const contentType = "image/png";',
					"export default function Image() { return null; }",
				].join("\n"),
				"app/twitter-image.tsx":
					'export { alt, contentType, default, size } from "./metadata-source";\n',
				"app/blog/metadata-source.ts": "export const image = 1;\n",
				"app/blog/opengraph-image.tsx":
					'export { image } from "./metadata-source";\n',
				"app/sitemap-source.ts": "export const sitemap = 1;\n",
				"app/sitemap.ts": 'export { sitemap } from "./sitemap-source";\n',
				"lib/metadata-source.ts": "export const ordinary = 1;\n",
				"lib/twitter-image.tsx":
					'export { ordinary } from "./metadata-source";\n',
			},
			{ outsideRepo: true }
		);

		try {
			const jsonResult = await captureOutput(async () => {
				await barrelCommand({ directory: dir, json: true });
			});
			const report = JSON.parse(jsonResult.stdout);
			expect(
				report.barrels.map(({ barrel }: { barrel: string }) => barrel)
			).toEqual(
				expect.arrayContaining([
					"app/twitter-image.tsx",
					"app/blog/opengraph-image.tsx",
					"app/sitemap.ts",
					"lib/twitter-image.tsx",
				])
			);
			expect(
				report.unusedBarrels.map(({ barrel }: { barrel: string }) => barrel)
			).toEqual(["lib/twitter-image.tsx"]);

			const humanResult = await captureOutput(async () => {
				await barrelCommand({ directory: dir });
			});
			expect(humanResult.stdout).toContain("Unused barrels (1, no importers)");
			expect(humanResult.stdout).toContain("lib/twitter-image.tsx");
			expect(humanResult.stdout).not.toContain("app/twitter-image.tsx");
			expect(humanResult.stdout).not.toContain("app/blog/opengraph-image.tsx");
			expect(humanResult.stdout).not.toContain("app/sitemap.ts");
		} finally {
			await cleanup(dir);
		}
	});

	test("MCP barrel analysis serializes the shared report", async () => {
		const toolSource = await Bun.file(
			path.resolve(import.meta.dir, "../mcp-tools/read-only.ts")
		).text();
		expect(toolSource).toContain(
			"const { report, baseDir } = await analyzeBarrels({"
		);
		expect(toolSource).toContain("barrelReportToJson(report, baseDir)");
	});

	test("surfaces skipped files in JSON and human output", async () => {
		const dir = await makeFixture("barrel-skipped-file", {
			"tsconfig.json": JSON.stringify({
				compilerOptions: { strict: true },
				files: ["index.ts", "live.ts", "missing.ts"],
			}),
			"index.ts": 'export * from "./live";\n',
			"live.ts": "export const live = 1;\n",
		});

		const jsonProc = Bun.spawn([...CLI, "barrel", dir, "--json"], {
			stdout: "pipe",
			stderr: "pipe",
		});
		const jsonStdout = await new Response(jsonProc.stdout).text();
		await new Response(jsonProc.stderr).text();
		await jsonProc.exited;
		expect(jsonProc.exitCode).toBe(0);
		const report = JSON.parse(jsonStdout);
		expect(report.skippedFileCount).toBe(1);
		expect(report.skippedFiles).toEqual(["missing.ts"]);

		const humanProc = Bun.spawn([...CLI, "barrel", dir], {
			stdout: "pipe",
			stderr: "pipe",
		});
		await new Response(humanProc.stdout).text();
		const humanStderr = await new Response(humanProc.stderr).text();
		await humanProc.exited;
		expect(humanProc.exitCode).toBe(0);
		expect(humanStderr).toContain("Coverage incomplete: 1 file(s)");
		expect(humanStderr).toContain("missing.ts");

		await cleanup(dir);
	});
});
