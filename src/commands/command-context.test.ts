import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { cleanup, makeTempDir } from "./__test-helpers.ts";
import { setupCommandContext } from "./command-context.ts";

const tempDirectories: string[] = [];

const createFixture = async (
	name: string,
	files: Record<string, string>
): Promise<string> => {
	const directory = await makeTempDir(name);
	tempDirectories.push(directory);
	for (const [relativePath, content] of Object.entries(files)) {
		const filePath = path.join(directory, relativePath);
		await mkdir(path.dirname(filePath), { recursive: true });
		await writeFile(filePath, content);
	}
	return directory;
};

afterAll(async () => {
	for (const directory of tempDirectories) {
		await cleanup(directory);
	}
});

describe("setupCommandContext", () => {
	test("relative search paths retain absolute all-config graph paths", async () => {
		const directory = await createFixture("command-context-relative", {
			"package.json": '{"name":"relative-context"}',
			"tsconfig.json": JSON.stringify({ include: ["*.ts"] }),
			"index.ts": "export const value = 1;\n",
		});
		const context = await setupCommandContext({
			searchPath: path.relative(process.cwd(), directory),
			graph: "project-configs",
			retainProgram: false,
		});
		expect(context?.graphs.map(({ tsconfigPath }) => tsconfigPath)).toEqual([
			path.join(directory, "tsconfig.json"),
		]);
		expect(context?.graph?.imports.has(path.join(directory, "index.ts"))).toBe(
			true
		);
	});

	test("requested workspace merging preserves the merged graph even without siblings", async () => {
		const directory = await createFixture("command-context-empty-merge", {
			"package.json": '{"name":"empty-merge-context"}',
			"tsconfig.json": JSON.stringify({ include: ["*.ts"] }),
			"index.ts": "export const value = 1;\n",
		});
		const context = await setupCommandContext({
			searchPath: directory,
			graph: "project",
			mergeWorkspaceGraphs: true,
		});
		expect(context?.graphs).toHaveLength(1);
		expect(context?.graph).not.toBe(context?.graphs[0]?.graph);
		expect(context?.graph?.imports).toEqual(context?.graphs[0]?.graph.imports);
	});

	test("defaults to loading only the project for directory and explicit config inputs", async () => {
		const directory = await createFixture("command-context-defaults", {
			"package.json": JSON.stringify({ name: "context-defaults" }),
			"tsconfig.json": JSON.stringify({ include: ["src/**/*.ts"] }),
			"src/index.ts": "export const value = 1;\n",
		});
		for (const project of [directory, path.join(directory, "tsconfig.json")]) {
			const progress: number[] = [];
			const context = await setupCommandContext({
				project,
				searchPath: directory,
				onProgress: (completed) => progress.push(completed),
			});
			expect(context?.tsconfigPath).toBe(path.join(directory, "tsconfig.json"));
			expect(context?.project.files).toEqual([
				path.join(directory, "src/index.ts"),
			]);
			expect(context?.graph).toBeUndefined();
			expect(context?.graphs).toEqual([]);
			expect(context?.workspace).toBeUndefined();
			expect(context?.extraProjects).toEqual([]);
			expect(progress).toEqual([]);
		}
	});

	test("preserves resolved versus owning config graph coverage", async () => {
		const directory = await createFixture("command-context-coverage", {
			"package.json": JSON.stringify({ name: "context-coverage" }),
			"tsconfig.json": JSON.stringify({
				references: [{ path: "./a" }, { path: "./b" }],
			}),
			"a/tsconfig.json": JSON.stringify({ include: ["*.ts"] }),
			"a/index.ts": "export const a = 1;\n",
			"b/tsconfig.json": JSON.stringify({ include: ["*.ts"] }),
			"b/index.ts": "export const b = 2;\n",
		});
		const targetFile = path.join(directory, "b/index.ts");
		for (const retainProgram of [false, true]) {
			for (const [graph, projectConfigsFrom, count] of [
				["project", "resolved", 1],
				["project-configs", "owning", 1],
				["project-configs", "resolved", 2],
			] as const) {
				const context = await setupCommandContext({
					project: directory,
					searchPath: directory,
					targetFile,
					graph,
					projectConfigsFrom,
					retainProgram,
				});
				expect(context?.project.tsconfigPath).toBe(
					path.join(directory, "b/tsconfig.json")
				);
				expect(context?.graphs).toHaveLength(count);
				expect(context?.graph?.imports.has(targetFile)).toBe(true);
				for (const result of context?.graphs ?? []) {
					expect(Boolean(result.graph.program)).toBe(retainProgram);
				}
			}
		}
	});

	test("discovers workspace metadata or sibling projects without constructing graphs", async () => {
		const directory = await createFixture("command-context-no-graphs", {
			"pnpm-workspace.yaml": 'packages:\n  - "packages/*"\n',
			"package.json": JSON.stringify({
				name: "context-no-graphs",
				private: true,
			}),
			"packages/a/package.json": JSON.stringify({ name: "@test/a" }),
			"packages/a/tsconfig.json": JSON.stringify({ include: ["*.ts"] }),
			"packages/a/index.ts": "export const a = 1;\n",
			"packages/b/package.json": JSON.stringify({ name: "@test/b" }),
			"packages/b/tsconfig.json": JSON.stringify({ include: ["*.ts"] }),
			"packages/b/index.ts": "export const b = 2;\n",
		});
		for (const workspace of ["discover", "projects"] as const) {
			const progress: number[] = [];
			const context = await setupCommandContext({
				project: path.join(directory, "packages/a"),
				searchPath: directory,
				workspace,
				workspaceFromProjectRoot: true,
				mergeWorkspaceGraphs: true,
				onProgress: (completed) => progress.push(completed),
			});
			expect(context?.workspace?.root).toBe(directory);
			expect(context?.extraProjects).toHaveLength(
				workspace === "projects" ? 1 : 0
			);
			expect(context?.graph).toBeUndefined();
			expect(context?.graphs).toEqual([]);
			expect(progress).toEqual([]);
		}
	});

	test("returns null when no TypeScript project can be found", async () => {
		const directory = await createFixture("command-context-missing", {
			"source.ts": "export const value = 1;\n",
		});

		const context = await setupCommandContext({ searchPath: directory });

		expect(context).toBeNull();
	});

	test("selects the owning config and retains sibling project graphs", async () => {
		const directory = await createFixture("command-context-siblings", {
			"pnpm-workspace.yaml": 'packages:\n  - "packages/*"\n',
			"package.json": JSON.stringify({ name: "workspace-root", private: true }),
			"tsconfig.json": JSON.stringify({
				references: [{ path: "./packages/a" }, { path: "./packages/b" }],
			}),
			"packages/a/package.json": JSON.stringify({ name: "@test/a" }),
			"packages/a/tsconfig.json": JSON.stringify({
				compilerOptions: { composite: true },
				include: ["src/**/*.ts"],
			}),
			"packages/a/src/index.ts": "export const value = 1;\n",
			"packages/b/package.json": JSON.stringify({ name: "@test/b" }),
			"packages/b/tsconfig.json": JSON.stringify({
				compilerOptions: { composite: true },
				include: ["src/**/*.ts"],
			}),
			"packages/b/src/index.ts":
				'import { value } from "../../a/src/index";\nexport { value };\n',
		});
		const targetFile = path.join(directory, "packages/b/src/index.ts");

		const context = await setupCommandContext({
			project: directory,
			searchPath: targetFile,
			targetFile,
			graph: "project-configs",
			workspace: "projects",
			workspaceStart: directory,
			mergeWorkspaceGraphs: true,
		});

		expect(context?.project.tsconfigPath).toBe(
			path.join(directory, "packages/b/tsconfig.json")
		);
		expect(context?.graphs).toHaveLength(2);
		expect(context?.extraProjects).toHaveLength(0);
		expect(context?.graph?.imports.has(targetFile)).toBe(true);
	});

	test("loads sibling workspace projects and merges their graphs", async () => {
		const directory = await createFixture("command-context-workspace", {
			"pnpm-workspace.yaml": 'packages:\n  - "packages/*"\n',
			"package.json": JSON.stringify({ name: "workspace-root", private: true }),
			"packages/a/package.json": JSON.stringify({ name: "@test/a" }),
			"packages/a/tsconfig.json": JSON.stringify({
				compilerOptions: { composite: true },
				include: ["src/**/*.ts"],
			}),
			"packages/a/src/index.ts": "export const value = 1;\n",
			"packages/b/package.json": JSON.stringify({
				name: "@test/b",
				dependencies: { "@test/a": "workspace:*" },
			}),
			"packages/b/tsconfig.json": JSON.stringify({
				compilerOptions: { composite: true },
				include: ["src/**/*.ts"],
			}),
			"packages/b/src/index.ts":
				'import { value } from "../../a/src/index";\nexport { value };\n',
		});
		const sourceFile = path.join(directory, "packages/a/src/index.ts");
		const importerFile = path.join(directory, "packages/b/src/index.ts");

		const context = await setupCommandContext({
			project: path.join(directory, "packages/a"),
			searchPath: sourceFile,
			targetFile: sourceFile,
			graph: "project-configs",
			workspace: "projects",
			workspaceStart: directory,
			mergeWorkspaceGraphs: true,
		});

		expect(context?.workspace?.root).toBe(directory);
		expect(context?.extraProjects).toHaveLength(1);
		expect(context?.graphs).toHaveLength(2);
		expect(
			context?.graph?.importedBy
				.get(sourceFile)
				?.some((reference) => reference.sourceFile === importerFile)
		).toBe(true);
	});

	test("preserves command policy for workspace project load failures", async () => {
		const directory = await createFixture("command-context-errors", {
			"pnpm-workspace.yaml": 'packages:\n  - "packages/*"\n',
			"package.json": JSON.stringify({ name: "workspace-root", private: true }),
			"packages/a/package.json": JSON.stringify({ name: "@test/a" }),
			"packages/a/tsconfig.json": JSON.stringify({
				include: ["src/**/*.ts"],
			}),
			"packages/a/src/index.ts": "export const value = 1;\n",
			"packages/b/package.json": JSON.stringify({ name: "@test/b" }),
			"packages/b/tsconfig.json": "{ invalid json",
		});
		const projectDirectory = path.join(directory, "packages/a");

		const skipped = await setupCommandContext({
			project: projectDirectory,
			searchPath: projectDirectory,
			workspace: "projects",
			workspaceStart: directory,
		});

		expect(skipped?.extraProjects).toHaveLength(0);
		let thrown: unknown;
		try {
			await setupCommandContext({
				project: projectDirectory,
				searchPath: projectDirectory,
				workspace: "projects",
				workspaceStart: directory,
				workspaceProjectErrors: "throw",
			});
		} catch (error) {
			thrown = error;
		}
		expect(thrown).toBeInstanceOf(Error);
		if (!(thrown instanceof Error)) {
			throw new Error("Expected workspace project loading to fail");
		}
		expect(thrown.message).toContain("Failed to read tsconfig");
	});
});
