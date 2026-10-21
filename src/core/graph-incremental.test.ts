import { expect, test } from "bun:test";
import { rename, unlink } from "node:fs/promises";
import path from "node:path";
import { cleanup, makeFixture } from "../commands/__test-helpers.ts";
import { buildDependencyGraph } from "./graph.ts";
import { loadProject } from "./project.ts";
import { discoverProject } from "./tsconfig-discovery.ts";

test("successive edits bound incremental rebuilding and reparse the changed file", async () => {
	const dir = await makeFixture("incremental-history", {
		"tsconfig.json": JSON.stringify({ include: ["src/*.ts"] }),
		"src/value.ts": "export const value = 0;",
	});
	try {
		const project = loadProject(path.join(dir, "tsconfig.json"));
		await buildDependencyGraph(project, { retainProgram: false });
		for (let edit = 1; edit <= 33; edit++) {
			await Bun.write(
				path.join(dir, "src/value.ts"),
				`export const value = ${edit};`
			);
			const graph = await buildDependencyGraph(project, {
				retainProgram: false,
			});
			expect(graph.inputs?.parsedFiles).toBe(1);
			expect(graph.inputs?.incrementalBuilds).toBe(edit === 33 ? 0 : edit);
		}
	} finally {
		await cleanup(dir);
	}
});

test("explicit hidden include segments refresh after additions below a wildcard", async () => {
	const dir = await makeFixture("discovery-hidden-include", {
		"tsconfig.json": JSON.stringify({ include: ["src/*/.generated/**/*.ts"] }),
		"src/feature/.generated/first.ts": "export const first = 1;",
	});
	try {
		expect(discoverProject(dir).fileOwnership.size).toBe(1);
		const added = path.join(dir, "src/feature/.generated/second.ts");
		await Bun.write(added, "export const second = 2;");
		expect(discoverProject(dir).fileOwnership.has(added)).toBe(true);
	} finally {
		await cleanup(dir);
	}
});

test("source additions, renames and deletions immediately refresh ownership without a config edit", async () => {
	const dir = await makeFixture("discovery-source-edits", {
		"tsconfig.json": JSON.stringify({ include: ["src/**/*.ts"] }),
		"src/existing.ts": "export const existing = 1;",
	});
	try {
		const existing = path.join(dir, "src/existing.ts");
		const added = path.join(dir, "src/added.ts");
		const renamed = path.join(dir, "src/renamed.ts");
		expect([...discoverProject(dir).fileOwnership.keys()]).toEqual([existing]);
		await Bun.write(added, "export const added = 2;");
		expect(discoverProject(dir).fileOwnership.has(added)).toBe(true);
		await rename(added, renamed);
		const afterRename = discoverProject(dir).fileOwnership;
		expect(afterRename.has(added)).toBe(false);
		expect(afterRename.has(renamed)).toBe(true);
		await unlink(renamed);
		expect([...discoverProject(dir).fileOwnership.keys()]).toEqual([existing]);
	} finally {
		await cleanup(dir);
	}
});

test("new sources in an outside include root invalidate discovery", async () => {
	const dir = await makeFixture("discovery-outside-edits", {
		"app/tsconfig.json": JSON.stringify({ include: ["../shared/**/*.ts"] }),
		"shared/placeholder.txt": "",
	});
	try {
		const app = path.join(dir, "app");
		expect(discoverProject(app).fileOwnership.size).toBe(0);
		const added = path.join(dir, "shared/added.ts");
		await Bun.write(added, "export const added = 1;");
		expect(discoverProject(app).fileOwnership.has(added)).toBe(true);
	} finally {
		await cleanup(dir);
	}
});

test("edits reuse unchanged plain records without mutating the previous graph", async () => {
	const dir = await makeFixture("incremental-graph", {
		"tsconfig.json": JSON.stringify({ include: ["src/*.ts"] }),
		"src/a.ts": "export const a = 1;",
		"src/b.ts": "import { a } from './a'; export const b = a;",
	});
	try {
		const project = loadProject(path.join(dir, "tsconfig.json"));
		const first = await buildDependencyGraph(project, { retainProgram: false });
		const a = path.join(dir, "src/a.ts");
		const b = path.join(dir, "src/b.ts");
		await Bun.write(a, "export const changed = 2;");
		const next = await buildDependencyGraph(project, { retainProgram: false });
		expect(next).not.toBe(first);
		expect(next.imports.get(b)).toBe(first.imports.get(b));
		expect(
			first.sourceMetadata?.get(a)?.exports.map((exp) => exp.name)
		).toEqual(["a"]);
		expect(next.sourceMetadata?.get(a)?.exports.map((exp) => exp.name)).toEqual(
			["changed"]
		);
	} finally {
		await cleanup(dir);
	}
});

test("changes outside include invalidate export metadata and unresolved imports", async () => {
	const dir = await makeFixture("incremental-outside", {
		"tsconfig.json": JSON.stringify({
			compilerOptions: { moduleResolution: "node" },
			include: ["src/*.ts"],
		}),
		"src/consumer.ts": "import '../outside/value'; import '../optional/later';",
		"outside/value.ts": "export const before = 1;",
		"optional/placeholder.txt": "",
	});
	try {
		const project = loadProject(path.join(dir, "tsconfig.json"));
		await buildDependencyGraph(project, { retainProgram: false });
		const outside = path.join(dir, "outside/value.ts");
		await Bun.write(outside, "export const after = 2;");
		const changed = await buildDependencyGraph(project, {
			retainProgram: false,
		});
		expect(
			changed.sourceMetadata?.get(outside)?.exports.map((exp) => exp.name)
		).toEqual(["after"]);
		const added = path.join(dir, "optional/later.ts");
		await Bun.write(added, "export const later = 1;");
		const resolved = await buildDependencyGraph(project, {
			retainProgram: false,
		});
		expect(
			resolved.imports
				.get(path.join(dir, "src/consumer.ts"))
				?.map((ref) => ref.resolvedPath)
		).toContain(added);
	} finally {
		await cleanup(dir);
	}
});

test("package main changes invalidate resolution even when source files do not change", async () => {
	const dir = await makeFixture("incremental-manifest", {
		"tsconfig.json": JSON.stringify({
			compilerOptions: { moduleResolution: "node" },
			include: ["src/*.ts"],
		}),
		"src/consumer.ts": "import '../package';",
		"package/package.json": JSON.stringify({ main: "one.ts" }),
		"package/one.ts": "export const one = 1;",
		"package/two.ts": "export const two = 2;",
	});
	try {
		const project = loadProject(path.join(dir, "tsconfig.json"));
		const first = await buildDependencyGraph(project, { retainProgram: false });
		const consumer = path.join(dir, "src/consumer.ts");
		expect(first.imports.get(consumer)?.[0]?.resolvedPath).toBe(
			path.join(dir, "package/one.ts")
		);
		await Bun.write(
			path.join(dir, "package/package.json"),
			JSON.stringify({ main: "two.ts" })
		);
		const next = await buildDependencyGraph(project, { retainProgram: false });
		expect(next.imports.get(consumer)?.[0]?.resolvedPath).toBe(
			path.join(dir, "package/two.ts")
		);
	} finally {
		await cleanup(dir);
	}
});
