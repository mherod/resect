import { expect, test } from "bun:test";
import { unlink, utimes } from "node:fs/promises";
import path from "node:path";
import { makeProject } from "../commands/__test-helpers.ts";
import {
	analyzeExtractComponentFreeVariables,
	buildExtractComponentModule,
} from "../index.ts";
import { buildDependencyGraph, type DependencyGraph } from "./graph.ts";
import {
	createProjectLoader,
	loadProject,
	loadProjectDirect,
	resolveTsConfig,
} from "./project.ts";
import {
	buildProjectGraphContext,
	type ProjectContextDependencies,
	resolveProjectContext,
	setupProjectContext,
} from "./project-context.ts";
import { discoverProject, toProjectConfig } from "./tsconfig-discovery.ts";
import { discoverWorkspace } from "./workspace.ts";

async function makeWorkspace(
	name: string,
	extraFiles: Record<string, string> = {}
) {
	return makeProject({
		name,
		files: {
			"package.json": '{"name":"context-counts","private":true}',
			"pnpm-workspace.yaml": 'packages:\n  - "packages/*"\n',
			"tsconfig.json": JSON.stringify({
				references: [{ path: "./packages/a" }, { path: "./packages/b" }],
			}),
			"packages/a/package.json": '{"name":"@context/a"}',
			"packages/a/tsconfig.json": JSON.stringify({ include: ["*.ts"] }),
			"packages/a/index.ts": "export const value = 1;\n",
			"packages/b/package.json": '{"name":"@context/b"}',
			"packages/b/tsconfig.json": JSON.stringify({ include: ["*.ts"] }),
			"packages/b/index.ts":
				'import { value } from "../a/index";\nexport const consumed = value;\n',
			...extraFiles,
		},
	});
}

function observeSetup() {
	const counts = {
		resolutions: 0,
		discoveries: [] as string[],
		constructions: [] as string[],
		directLoads: [] as string[],
		graphs: [] as string[],
		workspaces: [] as string[],
	};
	const dependencies: ProjectContextDependencies = {
		resolveTsConfig(...args) {
			counts.resolutions += 1;
			return resolveTsConfig(...args);
		},
		discoverProject(directory) {
			counts.discoveries.push(path.resolve(directory));
			return discoverProject(directory);
		},
		loadProjectDirect(config) {
			counts.directLoads.push(config);
			const project = loadProjectDirect(config);
			counts.constructions.push(project.tsconfigPath);
			return project;
		},
		toProjectConfig(config) {
			counts.constructions.push(config.path);
			return toProjectConfig(config);
		},
		async buildDependencyGraph(project, options) {
			counts.graphs.push(project.tsconfigPath);
			return buildDependencyGraph(project, options);
		},
		async discoverWorkspace(directory) {
			counts.workspaces.push(directory);
			return discoverWorkspace(directory);
		},
	};
	return { counts, dependencies };
}

test("cold and warm setup resolve and construct each selected project once", async () => {
	const fixture = await makeWorkspace("context-request-counts");
	let previous: DependencyGraph[] | undefined;
	for (const _temperature of ["cold", "warm"]) {
		const { counts, dependencies } = observeSetup();
		const context = await setupProjectContext(
			{
				project: fixture.dir,
				searchPath: fixture.dir,
				targetFile: fixture.path("packages/a/index.ts"),
				graph: "project-configs",
				retainProgram: false,
				workspace: "projects",
				workspaceStart: fixture.dir,
				mergeWorkspaceGraphs: true,
			},
			dependencies
		);
		expect(counts.resolutions).toBe(1);
		expect(counts.discoveries).toEqual([fixture.dir]);
		expect(counts.directLoads).toEqual([]);
		expect(counts.constructions.sort()).toEqual([
			fixture.path("packages/a/tsconfig.json"),
			fixture.path("packages/b/tsconfig.json"),
		]);
		expect(counts.graphs).toHaveLength(2);
		expect(counts.workspaces).toEqual([fixture.dir]);
		expect(context?.extraProjects).toEqual([]);
		const graphs = context?.graphs.map((result) => result.graph) ?? [];
		if (previous) {
			for (const [index, graph] of graphs.entries()) {
				expect(previous[index]).toBe(graph);
			}
		}
		previous = graphs;
	}
});

test("direct primary loading is reused by all-config graph construction", async () => {
	const fixture = await makeWorkspace("context-direct-reuse");
	const { counts, dependencies } = observeSetup();
	const context = await setupProjectContext(
		{
			project: fixture.path("packages/a"),
			searchPath: fixture.dir,
			graph: "project-configs",
			retainProgram: false,
		},
		dependencies
	);
	const config = fixture.path("packages/a/tsconfig.json");
	expect(context?.project).toEqual(loadProject(config));
	expect(counts.resolutions).toBe(1);
	expect(counts.discoveries).toEqual([fixture.path("packages/a")]);
	expect(counts.directLoads).toEqual([config]);
	expect(counts.constructions).toEqual([config]);
});

test("overlapping workspace config sets reuse constructions and graph builds", async () => {
	const fixture = await makeWorkspace("context-overlapping-configs");
	const { counts, dependencies } = observeSetup();
	const result = await buildProjectGraphContext(
		{
			tsconfigPath: fixture.path("tsconfig.json"),
			workspaceStart: fixture.dir,
			retainProgram: false,
		},
		dependencies
	);
	const configs = [
		fixture.path("packages/a/tsconfig.json"),
		fixture.path("packages/b/tsconfig.json"),
	];
	expect(result.graphs.map(({ tsconfigPath }) => tsconfigPath).sort()).toEqual(
		configs
	);
	expect(result.workspaceRoot).toBe(fixture.dir);
	expect(counts.resolutions).toBe(0);
	expect(counts.discoveries.sort()).toEqual(
		[fixture.dir, fixture.path("packages/a"), fixture.path("packages/b")].sort()
	);
	expect(counts.constructions.sort()).toEqual(configs);
	expect(counts.graphs.sort()).toEqual(configs);
	expect(counts.workspaces).toEqual([fixture.dir]);
});

test("the synchronous seam reuses equivalent requests and selects the owning config", async () => {
	const fixture = await makeWorkspace("context-sync-seam");
	const { counts, dependencies } = observeSetup();
	const loader = createProjectLoader(dependencies);
	const targetFile = fixture.path("packages/b/index.ts");
	const first = resolveProjectContext(
		{ project: fixture.dir, searchPath: fixture.dir, targetFile },
		loader
	);
	const second = resolveProjectContext(
		{ project: `${fixture.dir}/.`, searchPath: targetFile, targetFile },
		loader
	);
	expect(first).not.toBeInstanceOf(Promise);
	expect(first?.project).toEqual(
		loadProject(fixture.path("tsconfig.json"), targetFile)
	);
	expect(second?.project).toBe(first?.project);
	expect(counts.resolutions).toBe(1);
	expect(counts.discoveries).toEqual([fixture.dir]);
	expect(counts.constructions).toEqual([
		fixture.path("packages/b/tsconfig.json"),
	]);
	expect(counts.graphs).toEqual([]);
	expect(counts.workspaces).toEqual([]);
});

test("no-graph workspace requests never invoke a graph builder", async () => {
	const fixture = await makeWorkspace("context-graph-free");
	const { counts, dependencies } = observeSetup();
	const context = await setupProjectContext(
		{
			project: fixture.path("packages/a"),
			searchPath: fixture.dir,
			workspace: "projects",
			workspaceStart: fixture.dir,
			mergeWorkspaceGraphs: true,
		},
		{
			...dependencies,
			buildDependencyGraph: () => {
				throw new Error("Unexpected graph construction");
			},
		}
	);
	expect(context?.graphs).toEqual([]);
	expect(context?.graph).toBeUndefined();
	expect(context?.extraProjects.map((project) => project.tsconfigPath)).toEqual(
		[fixture.path("packages/b/tsconfig.json")]
	);
	expect(counts.discoveries).toEqual([]);
	expect(counts.graphs).toEqual([]);
	expect(counts.workspaces).toEqual([fixture.dir]);
});

test("synchronous loading preserves direct and owning-config metadata", async () => {
	const fixture = await makeProject({
		name: "context-loading-projections",
		tsconfig: {
			compilerOptions: { strict: true },
			references: [],
			include: ["*.ts"],
		},
		files: { "index.ts": "export const value = 1;\n" },
	});
	const loader = createProjectLoader();
	const config = fixture.path("tsconfig.json");
	const direct = loader.load(config);
	const owned = loader.load(config, fixture.path("index.ts"));
	expect(direct.references).toEqual([]);
	expect(owned.references).toBeUndefined();
	expect(owned).toEqual(loadProject(config, fixture.path("index.ts")));
});

test("public component analysis and code generation still return synchronously", async () => {
	const fixture = await makeProject({
		name: "context-sync-components",
		tsconfig: {
			compilerOptions: { jsx: "preserve", types: [] },
			include: ["*.tsx"],
		},
		files: {
			"App.tsx":
				"export function App({ name }: { name: string }) { return <section>{name}</section>; }\n",
		},
	});
	const options = {
		file: fixture.path("App.tsx"),
		project: fixture.dir,
		selector: "section",
		newFile: fixture.path("Greeting.tsx"),
	};
	const analysis = analyzeExtractComponentFreeVariables(options);
	const generated = buildExtractComponentModule(options);
	expect(analysis).not.toBeInstanceOf(Promise);
	expect(generated).not.toBeInstanceOf(Promise);
	expect(analysis.propCandidates.map((candidate) => candidate.name)).toEqual([
		"name",
	]);
	expect(generated.moduleText).toContain("export function Greeting");
	expect(await Bun.file(options.newFile).exists()).toBe(false);
});

test("command graph failures preserve skip/throw policy without invoking load-error callbacks", async () => {
	const fixture = await makeWorkspace("context-graph-errors");
	const failure = new Error("Sibling graph unavailable");
	const loadErrors: unknown[] = [];
	const dependencies = {
		buildDependencyGraph: async (
			project: Parameters<typeof buildDependencyGraph>[0],
			options: Parameters<typeof buildDependencyGraph>[1]
		) => {
			if (project.tsconfigPath === fixture.path("packages/b/tsconfig.json")) {
				return Promise.reject(failure);
			}
			return buildDependencyGraph(project, options);
		},
	};
	const options = {
		project: fixture.path("packages/a"),
		searchPath: fixture.dir,
		graph: "project" as const,
		retainProgram: false,
		workspace: "projects" as const,
		workspaceStart: fixture.dir,
		mergeWorkspaceGraphs: true,
		onWorkspaceProjectError: (_pkg: unknown, error: unknown) =>
			loadErrors.push(error),
	};
	const skipped = await setupProjectContext(options, dependencies);
	expect(skipped?.extraProjects).toHaveLength(1);
	expect(skipped?.graphs).toHaveLength(1);
	const thrown = await setupProjectContext(
		{ ...options, workspaceProjectErrors: "throw" },
		dependencies
	).catch((error: unknown) => error);
	expect(thrown).toBe(failure);
	expect(loadErrors).toEqual([]);
});

test("reporting skips the whole failing package while retaining successful siblings", async () => {
	const fixture = await makeWorkspace("context-package-errors", {
		"packages/b/tsconfig.second.json": JSON.stringify({ include: ["*.ts"] }),
	});
	const result = await buildProjectGraphContext(
		{
			tsconfigPath: fixture.path("packages/a/tsconfig.json"),
			workspaceStart: fixture.dir,
			retainProgram: false,
		},
		{
			async buildDependencyGraph(project, options) {
				return project.tsconfigPath ===
					fixture.path("packages/b/tsconfig.second.json")
					? Promise.reject(new Error("Second config failed"))
					: buildDependencyGraph(project, options);
			},
		}
	);
	expect(result.graphs.map(({ tsconfigPath }) => tsconfigPath)).toEqual([
		fixture.path("packages/a/tsconfig.json"),
	]);
	expect(result.workspaceRoot).toBe(fixture.dir);
});

test("command and reporting adapters preserve workspace discovery order", async () => {
	const fixture = await makeWorkspace("context-order");
	const events: string[] = [];
	const dependencies = {
		async buildDependencyGraph(
			project: Parameters<typeof buildDependencyGraph>[0],
			options: Parameters<typeof buildDependencyGraph>[1]
		) {
			events.push("graph");
			return buildDependencyGraph(project, options);
		},
		async discoverWorkspace(directory: string) {
			events.push("workspace");
			return discoverWorkspace(directory);
		},
	};
	await setupProjectContext(
		{
			project: fixture.path("packages/a"),
			searchPath: fixture.dir,
			graph: "project",
			workspace: "discover",
			workspaceStart: fixture.dir,
			retainProgram: false,
		},
		dependencies
	);
	expect(events).toEqual(["workspace", "graph"]);
	events.length = 0;
	await buildProjectGraphContext(
		{
			tsconfigPath: fixture.path("packages/a/tsconfig.json"),
			workspaceStart: fixture.dir,
			retainProgram: false,
		},
		dependencies
	);
	expect(events).toEqual(["graph", "workspace", "graph"]);
});

test("later requests observe config changes, source additions and removals", async () => {
	const configuration = (target: string) => ({
		compilerOptions: { baseUrl: ".", paths: { "@value": [target] } },
		include: ["*.ts"],
	});
	const fixture = await makeProject({
		name: "context-request-invalidation",
		tsconfig: configuration("a.ts"),
		files: {
			"package.json": '{"name":"context-invalidation"}',
			"entry.ts":
				'import { value } from "@value";\nexport const selected = value;\n',
			"a.ts": "export const value = 1;\n",
			"b.ts": "export const value = 2;\n",
			"gone.ts": "export const gone = true;\n",
		},
	});
	const options = {
		tsconfigPath: fixture.path("tsconfig.json"),
		retainProgram: false,
	};
	const before = (await buildProjectGraphContext(options)).graphs[0]?.graph;
	await Bun.write(
		fixture.path("tsconfig.json"),
		JSON.stringify(configuration("b.ts"))
	);
	await Bun.write(fixture.path("added.ts"), "export const added = true;\n");
	await unlink(fixture.path("gone.ts"));
	const changedAt = new Date(Date.now() + 1000);
	await utimes(fixture.path("tsconfig.json"), changedAt, changedAt);
	const after = (await buildProjectGraphContext(options)).graphs[0]?.graph;
	expect(before?.imports.get(fixture.path("entry.ts"))?.[0]?.resolvedPath).toBe(
		fixture.path("a.ts")
	);
	expect(after?.imports.get(fixture.path("entry.ts"))?.[0]?.resolvedPath).toBe(
		fixture.path("b.ts")
	);
	expect(after?.imports.has(fixture.path("added.ts"))).toBe(true);
	expect(after?.imports.has(fixture.path("gone.ts"))).toBe(false);
	expect(before?.imports.has(fixture.path("gone.ts"))).toBe(true);
	expect(after?.program).toBeUndefined();
});
