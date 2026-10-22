import { expect, test } from "bun:test";
import { createProjectFixtures } from "../commands/__test-helpers.ts";
import { buildWorkspaceGraphs } from "./workspace-graphs.ts";

const makeProject = createProjectFixtures();

const workspaceFiles = {
	"package.json": JSON.stringify({ name: "context-workspace", private: true }),
	"pnpm-workspace.yaml": 'packages:\n  - "packages/*"\n',
	"packages/a/package.json": JSON.stringify({ name: "@test/a" }),
	"packages/a/tsconfig.json": JSON.stringify({ include: ["src/*.ts"] }),
	"packages/a/tsconfig.spec.json": JSON.stringify({ include: ["spec/*.ts"] }),
	"packages/a/src/index.ts": "export const value = 1;\n",
	"packages/a/spec/check.ts":
		'import { value } from "../src/index";\nexport const checked = value;\n',
	"packages/b/package.json": JSON.stringify({ name: "@test/b" }),
	"packages/b/tsconfig.json": JSON.stringify({ include: ["src/*.ts"] }),
	"packages/b/src/index.ts":
		'import { value } from "../../a/src/index";\nexport const consumed = value;\n',
	"packages/broken/package.json": JSON.stringify({ name: "@test/broken" }),
	"packages/broken/tsconfig.json": "{ invalid json",
	"packages/js/package.json": JSON.stringify({ name: "@test/js" }),
	"packages/js/index.js": "export const js = true;\n",
};

test("workspace graph defaults include every base config without widening", async () => {
	const fixture = await makeProject({
		name: "workspace-graphs-default",
		files: workspaceFiles,
	});
	const result = await buildWorkspaceGraphs({
		tsconfigPath: fixture.path("packages/a/tsconfig.json"),
		reportDirectory: fixture.path("packages/a"),
		retainProgram: false,
	});
	expect(result.workspaceRoot).toBeNull();
	expect(result.graphs.map(({ tsconfigPath }) => tsconfigPath).sort()).toEqual(
		[
			fixture.path("packages/a/tsconfig.json"),
			fixture.path("packages/a/tsconfig.spec.json"),
		].sort()
	);
	expect(result.graphs.every(({ graph }) => graph.program === undefined)).toBe(
		true
	);
});

test("workspace graphs preserve explicit config paths, deduplication and package failures", async () => {
	const fixture = await makeProject({
		name: "workspace-graphs-packages",
		files: workspaceFiles,
	});
	for (const project of [
		undefined,
		fixture.path("packages/a"),
		fixture.path("packages/a/tsconfig.json"),
	]) {
		const result = await buildWorkspaceGraphs({
			tsconfigPath: fixture.path("packages/a/tsconfig.json"),
			reportDirectory: fixture.path("packages/a"),
			project,
			workspace: true,
			retainProgram: false,
		});
		expect(result.workspaceRoot).toBe(fixture.dir);
		expect(
			result.graphs.map(({ tsconfigPath }) => tsconfigPath).sort()
		).toEqual(
			[
				fixture.path("packages/a/tsconfig.json"),
				fixture.path("packages/a/tsconfig.spec.json"),
				fixture.path("packages/b/tsconfig.json"),
			].sort()
		);
		expect(
			result.graphs.some(({ graph }) =>
				graph.importedBy
					.get(fixture.path("packages/a/src/index.ts"))
					?.some(
						({ sourceFile }) =>
							sourceFile === fixture.path("packages/b/src/index.ts")
					)
			)
		).toBe(true);
	}
});

test("workspace mode preserves project-only results when no packages can be discovered", async () => {
	const manifests: Record<string, string>[] = [
		{},
		{ "pnpm-workspace.yaml": "packages: []\n" },
	];
	for (const workspaceManifest of manifests) {
		const fixture = await makeProject({
			name: "workspace-graphs-absent",
			tsconfig: { include: ["*.ts"] },
			files: {
				"package.json": '{"name":"standalone"}',
				"index.ts": "export const value = 1;\n",
				...workspaceManifest,
			},
		});
		const result = await buildWorkspaceGraphs({
			tsconfigPath: fixture.path("tsconfig.json"),
			reportDirectory: fixture.dir,
			workspace: true,
		});
		expect(result.workspaceRoot).toBeNull();
		expect(result.graphs).toHaveLength(1);
		expect(result.graphs[0]?.graph.program).toBeDefined();
	}
});

test("all-config graph setup tolerates an invalid selected config when a sibling is valid", async () => {
	const fixture = await makeProject({
		name: "workspace-graphs-selected-invalid",
		files: {
			"package.json": '{"name":"selected-invalid"}',
			"tsconfig.json": "{ invalid json",
			"tsconfig.valid.json": JSON.stringify({ include: ["*.ts"] }),
			"index.ts": "export const value = 1;\n",
		},
	});
	const result = await buildWorkspaceGraphs({
		tsconfigPath: fixture.path("tsconfig.json"),
		reportDirectory: fixture.dir,
	});
	expect(result.graphs.map(({ tsconfigPath }) => tsconfigPath)).toEqual([
		fixture.path("tsconfig.valid.json"),
	]);
});

test("all-config graph setup propagates a missing primary config without valid alternatives", async () => {
	const fixture = await makeProject({
		name: "workspace-graphs-missing",
		files: { "index.ts": "export const value = 1;\n" },
	});
	const failure = await buildWorkspaceGraphs({
		tsconfigPath: fixture.path("missing.json"),
		reportDirectory: fixture.dir,
		workspace: true,
	}).catch((error: unknown) => error);
	expect(failure).toEqual(
		expect.objectContaining({
			message: expect.stringContaining("Failed to read tsconfig"),
		})
	);
});
