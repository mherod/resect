import { afterEach, expect, spyOn, test } from "bun:test";
import path from "node:path";
import { buildDependencyGraph } from "../core/graph.ts";
import { loadProject } from "../core/project.ts";
import { discoverWorkspace } from "../core/workspace.ts";
import { bunRuntime, setRuntime } from "../runtime/index.ts";
import type { MoveResult } from "../types/move.ts";
import { cleanup, makeFixture } from "./__test-helpers.ts";
import { moveModule } from "./move-apply.ts";
import { MoveSession } from "./move-session.ts";

const directories: string[] = [];

afterEach(async () => {
	setRuntime(bunRuntime);
	for (const directory of directories.splice(0)) {
		await cleanup(directory);
	}
});

async function fixture(dryRun: boolean, executeMove = moveModule) {
	const directory = await makeFixture(
		"move-session",
		{
			"src/value.ts": "export const value = 1;\n",
			"src/use.ts":
				'import { value } from "./value";\nexport const used = value;\n',
			"src/empty.ts": "",
		},
		{ outsideRepo: true, tsconfig: "bundler" }
	);
	directories.push(directory);
	const project = loadProject(path.join(directory, "tsconfig.json"));
	const graph = await buildDependencyGraph(project, { retainProgram: false });
	return {
		project,
		graph,
		file: (name: string) => path.join(directory, "src", name),
		session: new MoveSession(project, graph, dryRun, executeMove),
	};
}

test.each([
	true,
	false,
])("sequential moves retain importer edits through two hops and case changes (preview=%s)", async (dryRun) => {
	const { file, graph, session } = await fixture(dryRun);
	const source = file("value.ts");
	const intermediate = file("nested/value.ts");
	const target = file("nested/Value.ts");
	const consumer = file("nested/use.ts");
	for (const [from, to] of [
		[source, intermediate],
		[intermediate, target],
		[file("use.ts"), consumer],
	] as const) {
		expect((await session.move(from, to)).success).toBe(true);
	}
	expect(await session.context.readFile(consumer)).toContain('from "./Value"');
	expect(await session.context.exists(source)).toBe(false);
	expect(await session.context.getSourceFile(source)).toBeUndefined();
	expect((await session.context.getSourceFile(consumer))?.text).toContain(
		"./Value"
	);
	expect(session.translateBeforeFile(source)).toBe(target);
	expect(session.translateBeforeFile(intermediate)).toBe(target);
	expect(graph.imports.has(source)).toBe(false);
	expect(graph.imports.has(intermediate)).toBe(false);
	expect(
		graph.importedBy.get(target)?.map(({ sourceFile }) => sourceFile)
	).toEqual([consumer]);
	expect(graph.importedBy.has(source)).toBe(false);
	expect(graph.importedBy.has(intermediate)).toBe(false);
	expect(await Bun.file(source).exists()).toBe(dryRun);
	expect(graph.program).toBeUndefined();
});

async function workspaceFixture(dryRun: boolean) {
	const names = ["a", "b", "c"];
	const files: Record<string, string> = {
		"pnpm-workspace.yaml": 'packages:\n  - "packages/*"\n',
		"tsconfig.json": JSON.stringify({
			compilerOptions: {
				module: "ESNext",
				moduleResolution: "Bundler",
				baseUrl: ".",
				paths: Object.fromEntries(
					names.map((name) => [
						`@fixture/${name}`,
						[`packages/${name}/src/index.ts`],
					])
				),
			},
			include: ["**/*.ts"],
		}),
		"packages/a/src/value.ts": "export const value = 1;\n",
		"packages/a/src/keep.ts": "export const keep = 2;\n",
		"packages/a/src/bridge.ts": 'export * from "./index";\n',
		"consumer-a.ts":
			'import { value, keep } from "@fixture/a";\nexport const values = [value, keep];\n',
		"consumer-b.ts":
			'import { value, keep } from "./packages/a/src/bridge";\nexport const values = [value, keep];\n',
	};
	for (const name of names) {
		files[`packages/${name}/package.json`] = JSON.stringify({
			name: `@fixture/${name}`,
			exports: "./src/index.ts",
		});
		files[`packages/${name}/src/index.ts`] = `export const ${name} = 1;\n`;
	}
	files["packages/a/src/index.ts"] =
		'export * from "./value";\nexport * from "./keep";\n';
	const directory = await makeFixture("move-session-barrels", files, {
		outsideRepo: true,
	});
	directories.push(directory);
	const project = loadProject(path.join(directory, "tsconfig.json"));
	const graph = await buildDependencyGraph(project, { retainProgram: false });
	const workspace = await discoverWorkspace(directory);
	if (!workspace) {
		throw new Error("Expected the fixture workspace");
	}
	return {
		directory,
		graph,
		workspace,
		file: (name: string) => path.join(directory, name),
		session: new MoveSession(project, graph, dryRun),
	};
}

test("preview and apply share mixed import, indirect barrel and multi-hop state", async () => {
	const snapshots: string[] = [];
	for (const dryRun of [true, false]) {
		const { directory, file, graph, session, workspace } =
			await workspaceFixture(dryRun);
		const reports: MoveResult[] = [];
		for (const [from, to] of [
			["a", "b"],
			["b", "c"],
		]) {
			const result = await session.move(
				file(`packages/${from}/src/value.ts`),
				file(`packages/${to}/src/value.ts`),
				{ workspace }
			);
			expect(result.success).toBe(true);
			reports.push(result);
		}
		const contents: string[] = [];
		for (const name of ["consumer-a.ts", "consumer-b.ts"]) {
			const content = await session.context.readFile(file(name));
			expect(content).toContain('from "@fixture/c"');
			expect(content).toContain("keep");
			contents.push(content);
		}
		expect(
			await session.context.readFile(file("packages/b/src/index.ts"))
		).not.toContain("./value");
		expect(graph.barrelReExports.get(file("packages/a/src/index.ts"))).toEqual([
			file("packages/a/src/keep.ts"),
		]);
		expect(graph.barrelReExports.has(file("packages/b/src/index.ts"))).toBe(
			false
		);
		expect(graph.barrelReExports.get(file("packages/c/src/index.ts"))).toEqual([
			file("packages/c/src/value.ts"),
		]);
		expect(graph.imports.has(file("packages/b/package.json"))).toBe(false);
		snapshots.push(
			JSON.stringify({
				reports,
				contents,
				imports: [...graph.imports],
				reverse: [...graph.importedBy].sort(([left], [right]) =>
					left.localeCompare(right)
				),
			}).replaceAll(directory, "<fixture>")
		);
	}
	expect(snapshots[0]).toBe(snapshots[1]);
});

test("a preview leaves reusable filesystem graphs fresh for a later application", async () => {
	const { file, graph, project, session } = await fixture(true);
	const other = await fixture(true);
	expect(
		(await session.move(file("value.ts"), file("preview/value.ts"))).success
	).toBe(true);
	const fresh = await buildDependencyGraph(project, { retainProgram: false });
	expect(fresh).not.toBe(graph);
	expect(
		await buildDependencyGraph(other.project, { retainProgram: false })
	).toBe(other.graph);
	const applied = new MoveSession(project, fresh, false);
	expect(
		(await applied.move(file("value.ts"), file("applied/value.ts"))).success
	).toBe(true);
	expect(await Bun.file(file("use.ts")).text()).toContain(
		'from "./applied/value"'
	);
});

test("path reuse preserves the original file identity", async () => {
	const { file, session } = await fixture(true);
	for (const [source, target] of [
		["value.ts", "nested/value.ts"],
		["empty.ts", "value.ts"],
		["value.ts", "nested/empty.ts"],
	] as const) {
		expect((await session.move(file(source), file(target))).success).toBe(true);
	}
	expect(session.translateBeforeFile(file("value.ts"))).toBe(
		file("nested/value.ts")
	);
	expect(session.translateBeforeFile(file("empty.ts"))).toBe(
		file("nested/empty.ts")
	);
});

test("returning a file to its original path retains intermediate translations", async () => {
	const { file, session } = await fixture(true);
	expect(
		(await session.move(file("value.ts"), file("nested/value.ts"))).success
	).toBe(true);
	expect(
		(await session.move(file("nested/value.ts"), file("value.ts"))).success
	).toBe(true);
	expect(session.translateBeforeFile(file("value.ts"))).toBe(file("value.ts"));
	expect(session.translateBeforeFile(file("nested/value.ts"))).toBe(
		file("value.ts")
	);
});

test("translator lookups allocate no destination maps", async () => {
	const { file, session } = await fixture(true);
	expect(
		(await session.move(file("value.ts"), file("nested/value.ts"))).success
	).toBe(true);
	const NativeMap = globalThis.Map;
	let constructions = 0;
	const translated: string[] = [];
	try {
		globalThis.Map = class<Key, Value> extends NativeMap<Key, Value> {
			constructor(entries?: Iterable<readonly [Key, Value]> | null) {
				super(entries);
				constructions++;
			}
		};
		for (let query = 0; query < 100; query++) {
			translated.push(session.translateBeforeFile(file("value.ts")));
		}
	} finally {
		globalThis.Map = NativeMap;
	}
	expect(constructions).toBe(0);
	expect(new Set(translated)).toEqual(new Set([file("nested/value.ts")]));
});

test("successful updates do not sweep unrelated edges or rebuild reverse indexes", async () => {
	const { file, graph, session } = await fixture(true);
	const existing = graph.imports.get(file("use.ts"))?.[0];
	if (!existing) {
		throw new Error("Expected the fixture import");
	}
	let unrelatedEdgeReads = 0;
	for (let index = 0; index < 1000; index++) {
		const reference = new Proxy(
			{
				...existing,
				sourceFile: file(`unrelated-${index}.ts`),
				resolvedPath: file("empty.ts"),
			},
			{
				get(target, property, receiver) {
					if (property === "sourceFile" || property === "resolvedPath") {
						unrelatedEdgeReads++;
					}
					return Reflect.get(target, property, receiver);
				},
			}
		);
		graph.imports.set(file(`unrelated-${index}.ts`), [reference]);
		const incoming = graph.importedBy.get(file("empty.ts")) ?? [];
		incoming.push(reference);
		graph.importedBy.set(file("empty.ts"), incoming);
	}
	const sweeps = spyOn(graph.imports, "values");
	const rebuilds = spyOn(graph.importedBy, "clear");
	const barrelSweeps = spyOn(graph.barrelReExports, Symbol.iterator);
	expect(
		(await session.move(file("value.ts"), file("nested/value.ts"))).success
	).toBe(true);
	expect(sweeps).not.toHaveBeenCalled();
	expect(rebuilds).not.toHaveBeenCalled();
	expect(barrelSweeps).not.toHaveBeenCalled();
	expect(unrelatedEdgeReads).toBe(0);
	sweeps.mockRestore();
	rebuilds.mockRestore();
	barrelSweeps.mockRestore();
});

test.each([
	true,
	false,
])("empty sources still advance (preview=%s)", async (dryRun) => {
	const { file, session, graph } = await fixture(dryRun);
	const source = file("empty.ts");
	const target = file("nested/empty.ts");
	expect((await session.move(source, target)).success).toBe(true);
	expect(await session.context.readFile(target)).toBe("");
	expect(await session.context.exists(source)).toBe(false);
	expect(graph.imports.get(target)).toEqual([]);
	expect(session.translateBeforeFile(source)).toBe(target);
});

test.each([
	true,
	false,
])("rejected plans preserve session state (preview=%s)", async (dryRun) => {
	const { file, session, graph } = await fixture(dryRun);
	const before = structuredClone({
		imports: graph.imports,
		importedBy: graph.importedBy,
	});
	const source = file("value.ts");
	const result = await session.move(source, file("use.ts"));
	expect(result.success).toBe(false);
	expect({ imports: graph.imports, importedBy: graph.importedBy }).toEqual(
		before
	);
	expect(session.translateBeforeFile(source)).toBe(source);
	expect(await session.context.readFile(source)).toBe(
		"export const value = 1;\n"
	);
	expect((await session.move(source, file("nested/value.ts"))).success).toBe(
		true
	);
});

test("injected move execution receives the same local context and thrown failures do not advance", async () => {
	const contexts: unknown[] = [];
	const { file, session } = await fixture(true, (...args) => {
		contexts.push(args[10]);
		throw new Error("planning failed");
	});
	const source = file("value.ts");
	let failure: unknown;
	try {
		await session.move(source, file("nested/value.ts"));
	} catch (error) {
		failure = error;
	}
	expect(failure).toEqual(new Error("planning failed"));
	expect(contexts).toEqual([session.context]);
	expect(session.translateBeforeFile(source)).toBe(source);
	expect(await session.context.exists(source)).toBe(true);
	expect(await session.context.exists(file("nested/value.ts"))).toBe(false);
});

test("a preview rescan failure rolls back virtual contents and path history", async () => {
	const { file, project, graph, session } = await fixture(
		true,
		async (source, target) => ({
			success: true,
			movedFile: { from: source, to: target },
			edits: [],
			updatedReferences: [],
			errors: [],
		})
	);
	const source = file("value.ts");
	const target = file("nested/value.ts");
	const before = structuredClone(graph);
	setRuntime({
		...bunRuntime,
		fs: {
			...bunRuntime.fs,
			readFile: async (destination) => {
				if (destination === file("use.ts")) {
					throw new Error("rescan failed");
				}
				return bunRuntime.fs.readFile(destination);
			},
		},
	});
	let failure: unknown;
	try {
		await session.move(source, target);
	} catch (error) {
		failure = error;
	}
	expect(failure).toEqual(new Error("rescan failed"));
	expect(graph).toEqual(before);
	expect(await session.context.exists(source)).toBe(true);
	expect(await session.context.exists(target)).toBe(false);
	expect(session.translateBeforeFile(source)).toBe(source);
	expect(await buildDependencyGraph(project, { retainProgram: false })).toBe(
		graph
	);
});

test("failed application reports the partial write without advancing successful paths", async () => {
	const { file, session, graph } = await fixture(false);
	const source = file("value.ts");
	const target = file("nested/value.ts");
	const consumer = file("use.ts");
	setRuntime({
		...bunRuntime,
		fs: {
			...bunRuntime.fs,
			writeFile: async (destination, content) => {
				if (destination === consumer) {
					throw new Error("importer write failed");
				}
				return bunRuntime.fs.writeFile(destination, content);
			},
		},
	});
	const result = await session.move(source, target);
	expect(result.success).toBe(false);
	expect(
		result.errors.some(({ message }) => message === "importer write failed")
	).toBe(true);
	expect(await Bun.file(target).exists()).toBe(true);
	expect(await Bun.file(source).exists()).toBe(false);
	expect(graph.imports.has(source)).toBe(true);
	expect(session.translateBeforeFile(source)).toBe(source);
});
