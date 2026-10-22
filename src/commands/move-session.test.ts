import { afterEach, expect, test } from "bun:test";
import path from "node:path";
import { buildDependencyGraph } from "../core/graph.ts";
import { loadProject } from "../core/project.ts";
import { bunRuntime, setRuntime } from "../runtime/index.ts";
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
