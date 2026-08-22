import { describe, expect, test } from "bun:test";
import {
	mkdir,
	mkdtemp,
	rm,
	unlink,
	utimes,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ModuleReference } from "../types/graph";
import {
	buildDependencyGraph,
	buildProjectGraphs,
	type DependencyGraph,
	findAllReferences,
	mergeDependencyGraphs,
} from "./graph";
import { loadProject } from "./project";
import { normalizePath } from "./resolver";

describe("findAllReferences", () => {
	// Mock graph helper
	const createMockGraph = (
		imports: Record<string, string[]>, // file -> imports
		reExports: Record<string, string[]> // barrel -> re-exported files
	): DependencyGraph => {
		const importMap = new Map<string, ModuleReference[]>();
		const importedBy = new Map<string, ModuleReference[]>();
		const barrelFiles = new Set<string>();
		const barrelReExports = new Map<string, string[]>();

		// Setup barrel re-exports
		for (const [barrel, files] of Object.entries(reExports)) {
			barrelFiles.add(barrel);
			barrelReExports.set(barrel, files);
		}

		// Setup imports and reverse lookups
		for (const [file, deps] of Object.entries(imports)) {
			const refs = deps.map(
				(dep) =>
					({
						sourceFile: file,
						specifier: `./${dep}`,
						resolvedPath: dep,
						type: "import",
						line: 1,
						column: 1,
						isTypeOnly: false,
					}) as ModuleReference
			);
			importMap.set(file, refs);

			for (const ref of refs) {
				const existing = importedBy.get(ref.resolvedPath) ?? [];
				existing.push(ref);
				importedBy.set(ref.resolvedPath, existing);
			}
		}

		return {
			imports: importMap,
			importedBy,
			skippedFiles: [],
			barrelFiles,
			barrelReExports,
		};
	};

	test("finds direct references", () => {
		const graph = createMockGraph(
			{
				"src/consumer.ts": ["src/target.ts"],
			},
			{}
		);

		const refs = findAllReferences("src/target.ts", graph);
		expect(refs).toHaveLength(1);
		expect(refs[0]?.sourceFile).toBe("src/consumer.ts");
	});

	test("finds references through single barrel", () => {
		const graph = createMockGraph(
			{
				"src/consumer.ts": ["src/barrel.ts"],
				"src/barrel.ts": ["src/target.ts"],
			},
			{
				"src/barrel.ts": ["src/target.ts"],
			}
		);

		const refs = findAllReferences("src/target.ts", graph);
		// Should find:
		// 1. Consumer -> Barrel (indirect)
		// 2. Barrel -> Target (direct)
		expect(refs).toHaveLength(2);

		const consumerRef = refs.find((r) => r.sourceFile === "src/consumer.ts");
		expect(consumerRef).toBeDefined();
		expect(consumerRef?.resolvedPath).toBe("src/target.ts");

		const barrelRef = refs.find((r) => r.sourceFile === "src/barrel.ts");
		expect(barrelRef).toBeDefined();
	});

	test("finds references through recursive barrels (A -> Barrel1 -> Barrel2 -> Consumer)", () => {
		const graph = createMockGraph(
			{
				"src/consumer.ts": ["src/barrel2.ts"],
				"src/barrel2.ts": ["src/barrel1.ts"],
				"src/barrel1.ts": ["src/target.ts"],
			},
			{
				"src/barrel2.ts": ["src/barrel1.ts"],
				"src/barrel1.ts": ["src/target.ts"],
			}
		);

		const refs = findAllReferences("src/target.ts", graph);

		// Consumer -> Barrel2 -> Barrel1 -> Target
		// findAllReferences should return:
		// 1. Consumer (imports Barrel2)
		// 2. Barrel2 (imports Barrel1) -- technically an importer in the chain

		expect(refs.some((r) => r.sourceFile === "src/consumer.ts")).toBe(true);

		const consumerRef = refs.find((r) => r.sourceFile === "src/consumer.ts");
		expect(consumerRef?.resolvedPath).toBe("src/target.ts");
	});

	test("handles diamond dependencies (avoid duplicates)", () => {
		// A -> Barrel1 -> Consumer
		// A -> Barrel2 -> Consumer
		const graph = createMockGraph(
			{
				"src/consumer.ts": ["src/barrel1.ts", "src/barrel2.ts"],
				"src/barrel1.ts": ["src/target.ts"],
				"src/barrel2.ts": ["src/target.ts"],
			},
			{
				"src/barrel1.ts": ["src/target.ts"],
				"src/barrel2.ts": ["src/target.ts"],
			}
		);

		const refs = findAllReferences("src/target.ts", graph);
		// Should find consumer twice (two different import statements)
		const consumerRefs = refs.filter((r) => r.sourceFile === "src/consumer.ts");
		expect(consumerRefs).toHaveLength(2);
	});

	test("records project files that cannot be scanned", async () => {
		const dir = await mkdtemp(path.join(tmpdir(), "resect-graph-skipped-"));
		try {
			const srcDir = path.join(dir, "src");
			await mkdir(srcDir, { recursive: true });
			const tsconfigPath = path.join(dir, "tsconfig.json");
			await writeFile(
				tsconfigPath,
				JSON.stringify({
					compilerOptions: { strict: true },
					include: ["src/**/*.ts"],
				})
			);
			const liveFile = path.join(srcDir, "live.ts");
			const missingFile = path.join(srcDir, "missing.ts");
			await writeFile(liveFile, "export const live = 1;\n");

			const project = loadProject(tsconfigPath, dir);
			project.files.push(missingFile);

			const graph = await buildDependencyGraph(project);

			expect(graph.imports.has(normalizePath(liveFile))).toBe(true);
			expect(graph.imports.has(normalizePath(missingFile))).toBe(false);
			expect(graph.skippedFiles).toEqual([normalizePath(missingFile)]);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test("reports project file progress and completes cached scans", async () => {
		const dir = await mkdtemp(path.join(tmpdir(), "resect-graph-progress-"));
		try {
			const srcDir = path.join(dir, "src");
			await mkdir(srcDir, { recursive: true });
			const tsconfigPath = path.join(dir, "tsconfig.json");
			await writeFile(
				tsconfigPath,
				JSON.stringify({
					compilerOptions: { strict: true },
					include: ["src/**/*.ts"],
				})
			);
			await writeFile(path.join(srcDir, "one.ts"), "export const one = 1;\n");
			await writeFile(path.join(srcDir, "two.ts"), "export const two = 2;\n");

			const firstProgress: [done: number, total: number][] = [];
			await buildProjectGraphs(tsconfigPath, {
				onProgress: (done, total) => firstProgress.push([done, total]),
			});
			expect(firstProgress).toEqual([
				[1, 2],
				[2, 2],
			]);

			const cachedProgress: [done: number, total: number][] = [];
			await buildProjectGraphs(tsconfigPath, {
				onProgress: (done, total) => cachedProgress.push([done, total]),
			});
			expect(cachedProgress).toEqual([[2, 2]]);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test("preserves and deduplicates skipped files when graphs are merged", () => {
		const first = createMockGraph({}, {});
		first.skippedFiles = ["/repo/missing.ts"];
		const second = createMockGraph({}, {});
		second.skippedFiles = ["/repo/missing.ts", "/repo/unreadable.ts"];

		const merged = mergeDependencyGraphs([first, second]);

		expect(merged.skippedFiles).toEqual([
			"/repo/missing.ts",
			"/repo/unreadable.ts",
		]);
	});

	test("evicts cached dependency graph when the project file set changes", async () => {
		const dir = await mkdtemp(path.join(tmpdir(), "resect-graph-cache-"));
		try {
			const srcDir = path.join(dir, "src");
			await mkdir(srcDir, { recursive: true });
			const tsconfigPath = path.join(dir, "tsconfig.json");
			await writeFile(
				tsconfigPath,
				JSON.stringify({
					compilerOptions: { strict: true },
					include: ["src/**/*.ts"],
				})
			);
			const deletedFile = path.join(srcDir, "deleted.ts");
			const liveFile = path.join(srcDir, "live.ts");
			await writeFile(
				deletedFile,
				'import { live } from "./live";\nexport const deleted = live;\n'
			);
			await writeFile(liveFile, "export const live = 1;\n");

			const firstGraph = await buildDependencyGraph(
				loadProject(tsconfigPath, dir)
			);
			expect(firstGraph.imports.has(normalizePath(deletedFile))).toBe(true);
			const firstDeletedRef = firstGraph.imports
				.get(normalizePath(deletedFile))
				?.at(0);
			expect(firstDeletedRef).toBeDefined();
			const resolvedLivePath = normalizePath(
				firstDeletedRef?.resolvedPath ?? liveFile
			);
			expect(
				firstGraph.importedBy
					.get(resolvedLivePath)
					?.some((ref) => ref.sourceFile === normalizePath(deletedFile))
			).toBe(true);

			await unlink(deletedFile);

			const secondGraph = await buildDependencyGraph(
				loadProject(tsconfigPath, dir)
			);
			expect(secondGraph.imports.has(normalizePath(deletedFile))).toBe(false);
			expect(
				secondGraph.importedBy
					.get(resolvedLivePath)
					?.some((ref) => ref.sourceFile === normalizePath(deletedFile)) ??
					false
			).toBe(false);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test("rebuilds cached dependency graph when a file's content changes (same file set)", async () => {
		const dir = await mkdtemp(path.join(tmpdir(), "resect-graph-content-"));
		try {
			const srcDir = path.join(dir, "src");
			await mkdir(srcDir, { recursive: true });
			const tsconfigPath = path.join(dir, "tsconfig.json");
			await writeFile(
				tsconfigPath,
				JSON.stringify({
					compilerOptions: { strict: true },
					include: ["src/**/*.ts"],
				})
			);
			const consumer = path.join(srcDir, "consumer.ts");
			const helper = path.join(srcDir, "helper.ts");
			await writeFile(helper, "export const value = 1;\n");
			await writeFile(
				consumer,
				'import { value } from "./helper";\nexport const used = value;\n'
			);

			const resolvedHelper = normalizePath(helper);
			const normalizedConsumer = normalizePath(consumer);
			const firstGraph = await buildDependencyGraph(
				loadProject(tsconfigPath, dir)
			);
			expect(
				firstGraph.importedBy
					.get(resolvedHelper)
					?.some((ref) => ref.sourceFile === normalizedConsumer)
			).toBe(true);

			// Rewrite consumer.ts to drop the import — the file SET is unchanged
			// (still consumer.ts + helper.ts), only the content differs. Force a
			// distinctly-later mtime so staleness is detectable on any filesystem,
			// regardless of mtime resolution.
			await writeFile(consumer, "export const used = 1;\n");
			const future = new Date(Date.now() + 10_000);
			await utimes(consumer, future, future);

			const secondGraph = await buildDependencyGraph(
				loadProject(tsconfigPath, dir)
			);
			// A stale cache would still report the now-removed import edge.
			expect(
				secondGraph.importedBy
					.get(resolvedHelper)
					?.some((ref) => ref.sourceFile === normalizedConsumer) ?? false
			).toBe(false);
			expect(secondGraph.imports.get(normalizedConsumer)?.length ?? 0).toBe(0);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});

// ─── Stylesheet asset imports (#188) ───────────────────────────────────────

describe("stylesheet imports", () => {
	async function makeStylesheetFixture(): Promise<string> {
		const dir = await mkdtemp(path.join(tmpdir(), "resect-graph-stylesheet-"));
		await mkdir(path.join(dir, "app"), { recursive: true });
		await writeFile(
			path.join(dir, "tsconfig.json"),
			JSON.stringify({
				compilerOptions: { strict: true, jsx: "preserve" },
				include: ["app/**/*.tsx"],
			})
		);
		await writeFile(path.join(dir, "app/globals.css"), "body { color: red; }");
		await writeFile(
			path.join(dir, "app/styles.module.css"),
			".title { font-weight: 700; }"
		);
		await writeFile(
			path.join(dir, "app/layout.tsx"),
			'import "./globals.css";\n' +
				'import styles from "./styles.module.css";\n' +
				"export const layout = styles;\n"
		);
		return dir;
	}

	test("existing stylesheets never become dependency-graph nodes", async () => {
		const dir = await makeStylesheetFixture();
		try {
			const graph = await buildDependencyGraph(
				loadProject(path.join(dir, "tsconfig.json"), dir)
			);

			const nodes = [...graph.imports.keys(), ...graph.importedBy.keys()];
			expect(nodes.some((file) => file.endsWith(".css"))).toBe(false);
			// The importing module itself is still tracked.
			expect(nodes.some((file) => file.endsWith("layout.tsx"))).toBe(true);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});

describe("graph cache configuration fingerprint (#244)", () => {
	async function writeAliasProject(
		dir: string,
		aliasTarget: string
	): Promise<string> {
		const srcDir = path.join(dir, "src");
		await mkdir(srcDir, { recursive: true });
		const tsconfigPath = path.join(dir, "tsconfig.json");
		await writeFile(
			tsconfigPath,
			JSON.stringify({
				compilerOptions: {
					strict: true,
					baseUrl: ".",
					paths: { "@thing": [aliasTarget] },
				},
				include: ["src/**/*.ts"],
			})
		);
		await writeFile(path.join(srcDir, "a.ts"), "export const thing = 1;\n");
		await writeFile(path.join(srcDir, "b.ts"), "export const thing = 2;\n");
		await writeFile(
			path.join(srcDir, "hub.ts"),
			'import { thing } from "@thing";\nexport const hub = thing;\n'
		);
		return tsconfigPath;
	}

	function edgeTarget(graph: DependencyGraph, dir: string): string | undefined {
		const hubRefs = graph.imports.get(
			normalizePath(path.join(dir, "src/hub.ts"))
		);
		return hubRefs?.find((ref) => ref.specifier === "@thing")?.resolvedPath;
	}

	test("retargeting a path alias invalidates the graph with unchanged sources", async () => {
		const dir = await mkdtemp(path.join(tmpdir(), "resect-graph-fingerprint-"));
		try {
			const tsconfigPath = await writeAliasProject(dir, "./src/a.ts");

			const firstGraph = await buildDependencyGraph(
				loadProject(tsconfigPath, dir)
			);
			expect(edgeTarget(firstGraph, dir)).toBe(
				normalizePath(path.join(dir, "src/a.ts"))
			);

			// Change ONLY the alias mapping — no source file changes.
			await writeAliasProject(dir, "./src/b.ts");

			const secondGraph = await buildDependencyGraph(
				loadProject(tsconfigPath, dir)
			);
			expect(secondGraph).not.toBe(firstGraph);
			expect(secondGraph.program).not.toBe(firstGraph.program);
			expect(edgeTarget(secondGraph, dir)).toBe(
				normalizePath(path.join(dir, "src/b.ts"))
			);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test("an unchanged project keeps the cache-hit fast path", async () => {
		const dir = await mkdtemp(path.join(tmpdir(), "resect-graph-fastpath-"));
		try {
			const tsconfigPath = await writeAliasProject(dir, "./src/a.ts");

			const firstGraph = await buildDependencyGraph(
				loadProject(tsconfigPath, dir)
			);
			// A fresh but identical ProjectConfig must fingerprint equal and
			// return the cached graph object itself, quickly.
			const start = performance.now();
			const secondGraph = await buildDependencyGraph(
				loadProject(tsconfigPath, dir)
			);
			const cachedMs = performance.now() - start;
			expect(secondGraph).toBe(firstGraph);
			expect(cachedMs).toBeLessThan(1000);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});
