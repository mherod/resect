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
