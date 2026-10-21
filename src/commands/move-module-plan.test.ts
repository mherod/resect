import { afterEach, expect, test } from "bun:test";
import path from "node:path";
import { runMutation } from "../core/mutation-pipeline.ts";
import { loadProject } from "../core/project.ts";
import { applyStructuredEdits } from "../core/text-changes.ts";
import { discoverWorkspace } from "../core/workspace.ts";
import { withCancellationSignal } from "../runtime/cancellation.ts";
import { bunRuntime, setRuntime } from "../runtime/index.ts";
import { initializeGitRepository, makeFixture } from "./__test-helpers.ts";
import {
	applyMoveModulePlan,
	moveModule,
	rollbackTransformMove,
} from "./move-apply.ts";
import { planMoveModule } from "./move-module-plan.ts";
import { runMutationPlanning } from "./mutation-planning.ts";

afterEach(() => {
	setRuntime(bunRuntime);
});

async function simpleFixture() {
	const dir = await makeFixture(
		"move-plan",
		{
			"src/value.ts":
				"export const env = { A: 1, B: 2 };\nexport const value = env.A;\n",
			"src/use.ts":
				'import { value } from "./value";\nexport const used = value;\n',
		},
		{ outsideRepo: true, tsconfig: "bundler" }
	);
	return {
		dir,
		project: loadProject(path.join(dir, "tsconfig.json")),
		source: path.join(dir, "src/value.ts"),
		target: path.join(dir, "src/nested/value.ts"),
		consumer: path.join(dir, "src/use.ts"),
	};
}

async function workspaceFixture() {
	const files = {
		"pnpm-workspace.yaml": 'packages:\n  - "packages/*"\n',
		"tsconfig.json": JSON.stringify({
			compilerOptions: {
				module: "ESNext",
				moduleResolution: "Bundler",
				baseUrl: ".",
				noEmit: true,
				paths: {
					"@fixture/a": ["packages/a/src/index.ts"],
					"@fixture/b": ["packages/b/src/index.ts"],
				},
			},
			include: ["packages/**/*.ts"],
		}),
		"packages/a/package.json": JSON.stringify({
			name: "@fixture/a",
			dependencies: { external: "^1.0.0" },
		}),
		"packages/a/src/value.ts":
			'import { external } from "external";\nexport const value = external;\n',
		"packages/a/src/keep.ts": "export const keep = 1;\n",
		"packages/a/src/index.ts":
			'export { value } from "./value";\nexport { keep } from "./keep";\n',
		"packages/b/package.json": JSON.stringify({
			name: "@fixture/b",
			custom: "preserve me",
		}),
		// The destination barrel is also a mixed-import consumer. Both changes
		// must compose against the same original file in previews and applies.
		"packages/b/src/index.ts":
			'import { value as moved, keep as retained } from "@fixture/a";\nexport const combined = [moved, retained];\n',
	};
	const dir = await makeFixture("move-plan-workspace", files, {
		outsideRepo: true,
	});
	const workspace = await discoverWorkspace(dir);
	if (!workspace) {
		throw new Error("Expected workspace fixture");
	}
	return {
		dir,
		files,
		workspace,
		project: loadProject(path.join(dir, "tsconfig.json")),
		source: path.join(dir, "packages/a/src/value.ts"),
		target: path.join(dir, "packages/b/src/value.ts"),
		barrel: path.join(dir, "packages/b/src/index.ts"),
		manifest: path.join(dir, "packages/b/package.json"),
	};
}

test("planning performs no writes and applying consumes precomputed contents", async () => {
	const { project, source, target, consumer } = await simpleFixture();
	const sourceBefore = await Bun.file(source).text();
	const consumerBefore = await Bun.file(consumer).text();
	const mutations: string[] = [];
	setRuntime({
		...bunRuntime,
		fs: {
			...bunRuntime.fs,
			writeFile: async (file) => {
				mutations.push(file);
				throw new Error("planner wrote");
			},
			deleteFile: async (file) => {
				mutations.push(file);
				throw new Error("planner deleted");
			},
			rename: async (file) => {
				mutations.push(file);
				throw new Error("planner renamed");
			},
		},
	});
	const plan = await planMoveModule(
		source,
		target,
		project,
		false,
		undefined,
		false,
		[{ from: "env.A", to: "env.B" }]
	);
	expect(plan.result.success).toBe(true);
	expect(mutations).toEqual([]);
	expect(await Bun.file(source).text()).toBe(sourceBefore);
	expect(await Bun.file(target).exists()).toBe(false);
	expect(await Bun.file(consumer).text()).toBe(consumerBefore);
	setRuntime({
		...bunRuntime,
		fs: {
			...bunRuntime.fs,
			readFile: async () => {
				throw new Error("applier must not recalculate file contents");
			},
		},
	});
	const result = await applyMoveModulePlan(plan);
	expect(result).toEqual(plan.result);
	expect(await Bun.file(source).exists()).toBe(false);
	expect(await Bun.file(target).text()).toBe(
		applyStructuredEdits(
			sourceBefore,
			result.edits.filter((edit) => edit.file === target)
		)
	);
	expect(await Bun.file(consumer).text()).toBe(
		applyStructuredEdits(
			consumerBefore,
			result.edits.filter((edit) => edit.file === consumer)
		)
	);
});

test.each([
	false,
	true,
])("mixed barrel removal, destination addition and manifest edits match the preview (compact: %s)", async (compact) => {
	const { source, target, project, workspace, barrel, manifest, dir, files } =
		await workspaceFixture();
	const preview = await moveModule(
		source,
		target,
		project,
		true,
		false,
		workspace
	);
	expect(preview.success).toBe(true);
	for (const [file, content] of Object.entries(files)) {
		expect(await Bun.file(path.join(dir, file)).text()).toBe(content);
	}
	expect(await Bun.file(target).exists()).toBe(false);
	// One combined edit, not two overlapping edits on different snapshots.
	expect(preview.edits.filter((edit) => edit.file === barrel)).toHaveLength(1);
	const originals = new Map<string, string>();
	for (const edit of preview.edits) {
		originals.set(
			edit.file,
			await Bun.file(edit.file === target ? source : edit.file).text()
		);
	}
	const plan = compact
		? await runMutationPlanning({
				kind: "move",
				args: [source, target, project, false, workspace],
				compactWrites: true,
			})
		: await planMoveModule(source, target, project, false, workspace);
	expect(plan.result).toEqual(preview);
	const result = await applyMoveModulePlan(plan);
	expect(result).toEqual(preview);
	for (const [file, original] of originals) {
		expect(await Bun.file(file).text()).toBe(
			applyStructuredEdits(
				original,
				preview.edits.filter((edit) => edit.file === file)
			)
		);
	}
	const destination = await Bun.file(barrel).text();
	expect(destination).toContain("keep as retained");
	expect(destination).toContain('from "@fixture/a"');
	expect(destination).toContain('export * from "./value"');
	expect(
		await Bun.file(path.join(dir, "packages/a/src/index.ts")).text()
	).not.toContain('"./value"');
	expect(await Bun.file(manifest).json()).toEqual({
		name: "@fixture/b",
		custom: "preserve me",
		dependencies: { external: "^1.0.0" },
	});
});

test("the wrapper completes planning before its first write", async () => {
	const { source, target, project, workspace, manifest } =
		await workspaceFixture();
	let readManifest = false;
	let wrote = false;
	setRuntime({
		...bunRuntime,
		fs: {
			...bunRuntime.fs,
			readFile: async (file) => {
				if (file === manifest) {
					readManifest = true;
				}
				return bunRuntime.fs.readFile(file);
			},
			writeFile: async (file, content) => {
				expect(readManifest).toBe(true);
				wrote = true;
				await bunRuntime.fs.writeFile(file, content);
			},
		},
	});
	const result = await moveModule(
		source,
		target,
		project,
		false,
		false,
		workspace
	);
	expect(result.success).toBe(true);
	expect(wrote).toBe(true);
});

test("a rejected plan cannot be applied and preserves the existing destination", async () => {
	const { source, target, project } = await simpleFixture();
	await bunRuntime.fs.writeFile(target, "existing destination");
	const before = await Bun.file(source).text();
	const plan = await planMoveModule(source, target, project, false);
	expect(plan.result.success).toBe(false);
	expect(plan.writes).toEqual([]);
	expect(await applyMoveModulePlan(plan)).toEqual(plan.result);
	expect(await Bun.file(source).text()).toBe(before);
	expect(await Bun.file(target).text()).toBe("existing destination");
});

test("case-only moves plan without mutation and still use the safe applier", async () => {
	const { source, project, consumer } = await simpleFixture();
	const target = path.join(path.dirname(source), "VALUE.ts");
	const original = await Bun.file(source).text();
	const plan = await planMoveModule(source, target, project, false);
	expect(plan.result.success).toBe(true);
	expect(await Bun.file(source).text()).toBe(original);
	const result = await applyMoveModulePlan(plan);
	expect(result.success).toBe(true);
	expect(await Bun.file(target).text()).toBe(original);
	expect(await Bun.file(consumer).text()).toContain('"./VALUE"');
});

test("source write failures still throw before any importer changes", async () => {
	const { source, target, project, consumer } = await simpleFixture();
	const before = await Bun.file(consumer).text();
	const plan = await planMoveModule(source, target, project, false);
	setRuntime({
		...bunRuntime,
		fs: {
			...bunRuntime.fs,
			writeFile: async () => {
				throw new Error("source write denied");
			},
		},
	});
	let failure: unknown;
	try {
		await applyMoveModulePlan(plan);
	} catch (error) {
		failure = error;
	}
	expect(failure).toEqual(new Error("source write denied"));
	expect(await Bun.file(source).exists()).toBe(true);
	expect(await Bun.file(target).exists()).toBe(false);
	expect(await Bun.file(consumer).text()).toBe(before);
});

test("independent writes are bounded and drained even after a partial failure", async () => {
	const consumers = Object.fromEntries(
		Array.from({ length: 8 }, (_, index) => [
			`src/use${index}.ts`,
			'import { value } from "./value";\nexport const used = value;\n',
		])
	);
	const dir = await makeFixture(
		"move-plan-writers",
		{
			...consumers,
			"src/value.ts": "export const value = 1;\n",
		},
		{ outsideRepo: true, tsconfig: "bundler" }
	);
	const source = path.join(dir, "src/value.ts");
	const target = path.join(dir, "src/nested/value.ts");
	const plan = await planMoveModule(
		source,
		target,
		loadProject(path.join(dir, "tsconfig.json")),
		false
	);
	const failedFile = path.join(dir, "src/use0.ts");
	const failedFileBefore = await Bun.file(failedFile).text();
	const barrier = Promise.withResolvers<void>();
	let active = 0;
	let peak = 0;
	const completed: string[] = [];
	setRuntime({
		...bunRuntime,
		fs: {
			...bunRuntime.fs,
			writeFile: async (file, content) => {
				if (file === target) {
					await bunRuntime.fs.writeFile(file, content);
					return;
				}
				active += 1;
				peak = Math.max(peak, active);
				if (active === 4) {
					barrier.resolve();
				}
				try {
					await barrier.promise;
					if (file === failedFile) {
						throw new Error("importer denied");
					}
					await bunRuntime.fs.writeFile(file, content);
					completed.push(file);
				} finally {
					active -= 1;
				}
			},
		},
	});
	const result = await applyMoveModulePlan(plan);
	expect(result.success).toBe(false);
	expect(result.errors).toEqual([
		{ file: failedFile, message: "importer denied", recoverable: false },
	]);
	expect(peak).toBe(4);
	expect(active).toBe(0);
	expect(completed).toHaveLength(7);
	expect(plan.result.errors).toEqual([]);
	for (const file of completed) {
		expect(await Bun.file(file).text()).toContain('"./nested/value"');
	}
	expect(await Bun.file(failedFile).text()).toBe(failedFileBefore);
});

test.each([
	false,
	true,
])("failed manifest writes remain fatal without claiming dependency additions (compact=%s)", async (compact) => {
	const { source, target, project, workspace, manifest, barrel } =
		await workspaceFixture();
	const plan = compact
		? await runMutationPlanning({
				kind: "move",
				args: [source, target, project, false, workspace],
				compactWrites: true,
			})
		: await planMoveModule(source, target, project, false, workspace);
	const before = await Bun.file(manifest).text();
	setRuntime({
		...bunRuntime,
		fs: {
			...bunRuntime.fs,
			writeFile: async (file, content) => {
				if (file === manifest) {
					throw new Error("manifest denied");
				}
				await bunRuntime.fs.writeFile(file, content);
			},
		},
	});
	const result = await applyMoveModulePlan(plan);
	expect(result.success).toBe(false);
	expect(result.errors).toContainEqual({
		file: target,
		message: "Could not sync dependencies: manifest denied",
		recoverable: false,
	});
	expect(result.dependencyChanges).toEqual([]);
	expect(plan.result.dependencyChanges).toHaveLength(1);
	expect(await Bun.file(manifest).text()).toBe(before);
	expect(await Bun.file(target).exists()).toBe(true);
	expect(await Bun.file(barrel).text()).toContain('export * from "./value"');
});

test("cancellation after application still permits transform rollback", async () => {
	const { dir, source, target, project, consumer } = await simpleFixture();
	await initializeGitRepository(dir);
	const sourceBefore = await Bun.file(source).text();
	const consumerBefore = await Bun.file(consumer).text();
	const controller = new AbortController();
	const outcome = await withCancellationSignal(controller.signal, async () =>
		runMutation(
			{
				project,
				guardDir: dir,
				operation: "move",
				dryRun: false,
				force: false,
				journalEnabled: false,
				verify: "rollback",
				apply: async () =>
					moveModule(source, target, project, false, false, undefined, false, [
						{ from: "env.A", to: "env.B" },
					]),
				isApplySuccessful: (result) => result.success,
				rollbackStrategy: async (result) =>
					rollbackTransformMove(project, result),
			},
			{
				runWithTypecheckGuard: async (_project, apply) => {
					const result = await apply();
					controller.abort();
					return {
						result,
						delta: {
							success: false,
							verificationIncomplete: true,
							errorsBefore: [],
							errorsAfter: [],
							newErrors: [],
							fixedErrors: [],
						},
					};
				},
			}
		)
	);
	expect(controller.signal.aborted).toBe(true);
	expect(outcome.success).toBe(false);
	expect(outcome.rolledBack).toBe(true);
	expect(await Bun.file(source).text()).toBe(sourceBefore);
	expect(await Bun.file(consumer).text()).toBe(consumerBefore);
	expect(await Bun.file(target).exists()).toBe(false);
});
