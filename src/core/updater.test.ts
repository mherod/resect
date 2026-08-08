import { afterAll, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import path from "node:path";
import ts from "typescript";
import type { ExportInfo } from "../types/analysis.ts";
import type { ModuleReference } from "../types/graph.ts";
import type { ProjectConfig } from "../types.ts";
import { generateBarrelExport, updateFileReferences } from "./updater.ts";
import type { WorkspaceInfo } from "./workspace.ts";

let fixtureCounter = 0;
function nextDir(): string {
	fixtureCounter++;
	return path.join(
		import.meta.dir,
		"../commands/__fixtures__",
		`updater-${fixtureCounter}-${Date.now()}`
	);
}

async function writeFixture(dir: string, relPath: string, content: string) {
	const abs = path.join(dir, relPath);
	await Bun.write(abs, content);
	return abs;
}

async function makeProject(dir: string): Promise<ProjectConfig> {
	const tsconfigPath = await writeFixture(
		dir,
		"tsconfig.json",
		JSON.stringify({
			compilerOptions: {
				target: "ES2020",
				module: "ESNext",
				moduleResolution: "NodeNext",
				strict: true,
			},
			include: ["**/*.ts"],
		})
	);

	// Minimal ProjectConfig for resolver: we only rely on compilerOptions/rootDir.
	return {
		rootDir: dir,
		tsconfigPath,
		compilerOptions: {
			target: ts.ScriptTarget.ES2020,
			module: ts.ModuleKind.ESNext,
			moduleResolution: ts.ModuleResolutionKind.NodeNext,
			strict: true,
		},
		pathAliases: new Map(),
		include: ["**/*.ts"],
		exclude: [],
		files: [],
	};
}

function makeWorkspace(dir: string): WorkspaceInfo {
	return {
		root: dir,
		type: "unknown",
		patterns: [],
		packages: [
			{
				name: "@scope/pkg-a",
				path: path.join(dir, "packages", "pkg-a"),
				packageJsonPath: path.join(dir, "packages", "pkg-a", "package.json"),
				srcDir: "src",
				barrelFiles: [path.join(dir, "packages", "pkg-a", "src", "index.ts")],
			},
			{
				name: "@scope/pkg-b",
				path: path.join(dir, "packages", "pkg-b"),
				packageJsonPath: path.join(dir, "packages", "pkg-b", "package.json"),
				srcDir: "src",
				barrelFiles: [path.join(dir, "packages", "pkg-b", "src", "index.ts")],
			},
		],
	};
}

afterAll(async () => {
	// Best-effort cleanup of any updater fixtures we created under __fixtures__
	const fixturesDir = path.join(import.meta.dir, "../commands/__fixtures__");
	try {
		const glob = new Bun.Glob("updater-*");
		for await (const match of glob.scan({
			cwd: fixturesDir,
			onlyFiles: false,
		})) {
			const abs = path.join(fixturesDir, match);
			await rm(abs, { recursive: true, force: true });
		}
	} catch {
		// Fixtures directory may not exist yet — nothing to clean up
	}
});

describe("generateBarrelExport", () => {
	test("strips modern TS/JS extensions from barrel export specifier", () => {
		const barrelPath = "/repo/packages/a/src/index.ts";
		const barrelContent = 'export * from "./existing";\n';

		const { exportStatement } = generateBarrelExport(
			barrelContent,
			"/repo/packages/a/src/foo.mts",
			barrelPath
		);
		expect(exportStatement).toBe('export * from "./foo";\n');
	});

	test("strips .vue extension from barrel export specifier", () => {
		const barrelPath = "/repo/packages/a/src/index.ts";
		const barrelContent = "";

		const { exportStatement } = generateBarrelExport(
			barrelContent,
			"/repo/packages/a/src/components/Thing.vue",
			barrelPath
		);
		// Empty barrel defaults to single quotes
		expect(exportStatement).toBe("export * from './components/Thing';\n");
	});

	test("matches existing double-quote style", () => {
		const barrelPath = "/repo/packages/a/src/index.ts";
		const barrelContent = 'export * from "./existing";\n';

		const { exportStatement } = generateBarrelExport(
			barrelContent,
			"/repo/packages/a/src/foo.ts",
			barrelPath
		);
		expect(exportStatement).toBe('export * from "./foo";\n');
	});

	test("matches existing single-quote style", () => {
		const barrelPath = "/repo/packages/a/src/index.ts";
		const barrelContent = "export * from './existing';\n";

		const { exportStatement } = generateBarrelExport(
			barrelContent,
			"/repo/packages/a/src/bar.ts",
			barrelPath
		);
		expect(exportStatement).toBe("export * from './bar';\n");
	});

	test("preserves extension when existing barrel uses extensions", () => {
		const barrelPath = "/repo/packages/a/src/index.ts";
		const barrelContent = "export * from './existing.ts';\n";

		const { exportStatement } = generateBarrelExport(
			barrelContent,
			"/repo/packages/a/src/foo.ts",
			barrelPath
		);
		expect(exportStatement).toBe("export * from './foo.ts';\n");
	});
});

describe("updateFileReferences — barrel reference detection", () => {
	test("does not treat direct imports as barrel references", async () => {
		const dir = nextDir();
		await writeFixture(
			dir,
			"packages/pkg-a/package.json",
			JSON.stringify({ name: "@scope/pkg-a" })
		);
		await writeFixture(
			dir,
			"packages/pkg-b/package.json",
			JSON.stringify({ name: "@scope/pkg-b" })
		);
		await writeFixture(
			dir,
			"packages/pkg-a/src/moved.ts",
			"export const a = 1; export const c = 2;\n"
		);
		await writeFixture(
			dir,
			"packages/pkg-a/src/barrel.ts",
			'export * from "./moved";\n'
		);
		const consumerPath = await writeFixture(
			dir,
			"packages/pkg-a/src/consumer.ts",
			'import { a, c } from "./moved";\n'
		);

		const project = await makeProject(dir);
		project.files = [
			consumerPath,
			path.join(dir, "packages/pkg-a/src/barrel.ts"),
			path.join(dir, "packages/pkg-a/src/moved.ts"),
		];
		const program = ts.createProgram(project.files, project.compilerOptions);
		const consumerSf = program.getSourceFile(consumerPath);
		expect(consumerSf).toBeTruthy();
		if (!consumerSf) {
			return;
		}

		const oldPath = path.join(dir, "packages/pkg-a/src/moved.ts");
		const newPath = path.join(dir, "packages/pkg-b/src/moved.ts");
		const refs: ModuleReference[] = [
			{
				sourceFile: consumerPath,
				specifier: "./moved",
				resolvedPath: oldPath,
				type: "import-named",
				line: 1,
				column: 1,
				bindings: [
					{ name: "a", isType: false },
					{ name: "c", isType: false },
				],
				isTypeOnly: false,
			},
		];

		const movedFileExports: ExportInfo[] = [
			{ name: "a", type: "named", isType: false, line: 1 },
			{ name: "c", type: "named", isType: false, line: 1 },
		];

		const { newContent } = updateFileReferences(
			consumerSf,
			refs,
			oldPath,
			newPath,
			project,
			makeWorkspace(dir),
			movedFileExports
		);

		// Should remain a single import (specifier updated), no split into two statements.
		expect(newContent.split("\n").filter(Boolean).length).toBe(1);
	});

	test("splits barrel imports when only some bindings come from moved file", async () => {
		const dir = nextDir();
		await writeFixture(
			dir,
			"packages/pkg-a/package.json",
			JSON.stringify({ name: "@scope/pkg-a" })
		);
		await writeFixture(
			dir,
			"packages/pkg-b/package.json",
			JSON.stringify({ name: "@scope/pkg-b" })
		);
		await writeFixture(
			dir,
			"packages/pkg-a/src/moved.ts",
			"export const a = 1;\n"
		);
		await writeFixture(
			dir,
			"packages/pkg-a/src/other.ts",
			"export const c = 2;\n"
		);
		await writeFixture(
			dir,
			"packages/pkg-a/src/barrel.ts",
			['export { a } from "./moved";', 'export { c } from "./other";', ""].join(
				"\n"
			)
		);
		const consumerPath = await writeFixture(
			dir,
			"packages/pkg-a/src/consumer.ts",
			'import { a, c } from "./barrel";\n'
		);

		const project = await makeProject(dir);
		project.files = [
			consumerPath,
			path.join(dir, "packages/pkg-a/src/barrel.ts"),
			path.join(dir, "packages/pkg-a/src/moved.ts"),
			path.join(dir, "packages/pkg-a/src/other.ts"),
		];
		const program = ts.createProgram(project.files, project.compilerOptions);
		const consumerSf = program.getSourceFile(consumerPath);
		expect(consumerSf).toBeTruthy();
		if (!consumerSf) {
			return;
		}

		const oldPath = path.join(dir, "packages/pkg-a/src/moved.ts");
		const newPath = path.join(dir, "packages/pkg-b/src/moved.ts");
		const refs: ModuleReference[] = [
			{
				sourceFile: consumerPath,
				specifier: "./barrel",
				resolvedPath: oldPath, // effective target rewritten by findAllReferences
				type: "import-named",
				line: 1,
				column: 1,
				bindings: [
					{ name: "a", isType: false },
					{ name: "c", isType: false },
				],
				isTypeOnly: false,
			},
		];

		const movedFileExports: ExportInfo[] = [
			{ name: "a", type: "named", isType: false, line: 1 },
		];

		const { newContent } = updateFileReferences(
			consumerSf,
			refs,
			oldPath,
			newPath,
			project,
			makeWorkspace(dir),
			movedFileExports
		);

		// Should be split into two statements.
		expect(newContent).toContain('from "@scope/pkg-b"');
		expect(newContent).toContain('from "./barrel"');
	});

	test("keeps split-contained specifier edits in the original coordinate space", async () => {
		const dir = nextDir();
		await writeFixture(
			dir,
			"packages/pkg-a/package.json",
			JSON.stringify({ name: "@scope/pkg-a" })
		);
		await writeFixture(
			dir,
			"packages/pkg-b/package.json",
			JSON.stringify({ name: "@scope/pkg-b" })
		);
		await writeFixture(
			dir,
			"packages/pkg-a/src/moved.ts",
			"export const a = 1;\n"
		);
		await writeFixture(
			dir,
			"packages/pkg-a/src/other.ts",
			"export const c = 2;\n"
		);
		await writeFixture(
			dir,
			"packages/pkg-a/src/barrel.ts",
			['export { a } from "./moved";', 'export { c } from "./other";', ""].join(
				"\n"
			)
		);
		const consumerPath = await writeFixture(
			dir,
			"packages/pkg-a/src/consumer.ts",
			'import { a, c } from "./barrel"; const trailing = require("./barrel");\n'
		);

		const project = await makeProject(dir);
		project.files = [
			consumerPath,
			path.join(dir, "packages/pkg-a/src/barrel.ts"),
			path.join(dir, "packages/pkg-a/src/moved.ts"),
			path.join(dir, "packages/pkg-a/src/other.ts"),
		];
		const program = ts.createProgram(project.files, project.compilerOptions);
		const consumerSf = program.getSourceFile(consumerPath);
		expect(consumerSf).toBeTruthy();
		if (!consumerSf) {
			return;
		}

		const oldPath = path.join(dir, "packages/pkg-a/src/moved.ts");
		const newPath = path.join(dir, "packages/pkg-b/src/moved.ts");
		const refs: ModuleReference[] = [
			{
				sourceFile: consumerPath,
				specifier: "./barrel",
				resolvedPath: oldPath,
				type: "import-named",
				line: 1,
				column: 1,
				bindings: [
					{ name: "a", isType: false },
					{ name: "c", isType: false },
				],
				isTypeOnly: false,
			},
			{
				sourceFile: consumerPath,
				specifier: "./barrel",
				resolvedPath: oldPath,
				type: "require",
				line: 1,
				column: 50,
				isTypeOnly: false,
			},
		];

		const { newContent } = updateFileReferences(
			consumerSf,
			refs,
			oldPath,
			newPath,
			project,
			makeWorkspace(dir),
			[{ name: "a", type: "named", isType: false, line: 1 }]
		);

		expect(newContent).toBe(
			'import { a } from "@scope/pkg-b";\nimport { c } from "./barrel"; const trailing = require("./barrel");\n'
		);
	});
});
