import { expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import path from "node:path";
import { loadProject } from "../core/project.ts";
import { findCrossPackageImport } from "../core/resolver.ts";
import {
	applyStructuredEdits,
	type SerializedEdit,
	serializeStructuredEdits,
} from "../core/text-changes.ts";
import { findDestinationBarrel } from "../core/updater.ts";
import { discoverWorkspace } from "../core/workspace.ts";
import { moveTool } from "../mcp-tools/mutating.ts";
import { makeFixture, parseMcpTextPayload, runCli } from "./__test-helpers.ts";
import { applyMoveModulePlan, moveModule } from "./move-apply.ts";
import { planMoveModule } from "./move-module-plan.ts";
import { runMutationPlanning } from "./mutation-planning.ts";

async function subpathFixture(
	overrides: Record<string, string> = {},
	omitted: string[] = []
) {
	const files: Record<string, string> = {
		"pnpm-workspace.yaml": 'packages:\n  - "packages/*"\n  - "apps/*"\n',
		"tsconfig.json": JSON.stringify({
			compilerOptions: {
				module: "ESNext",
				moduleResolution: "Bundler",
				jsx: "preserve",
				baseUrl: ".",
				noEmit: true,
				types: [],
				paths: {
					"@/components/*": ["apps/web/components/*"],
					"@scope/ui": ["packages/ui/src/index.ts"],
					"@scope/ui/loaders": ["packages/ui/src/loaders/index.ts"],
				},
			},
			include: ["apps/**/*.tsx", "packages/**/*.ts", "packages/**/*.tsx"],
		}),
		"apps/web/package.json": JSON.stringify({ name: "web" }),
		"apps/web/components/loaders/detail-loaders.tsx":
			'export const AdminFormLoader = () => "loading";\n',
		"apps/web/components/loaders/keep.tsx":
			'export const ShellLoader = () => "shell";\n',
		"apps/web/components/loaders/index.tsx":
			'export * from "./detail-loaders";\nexport * from "./keep";\n',
		"apps/web/app/loading.tsx":
			'import { AdminFormLoader } from "@/components/loaders";\nexport const Loading = AdminFormLoader;\n',
		"apps/web/app/mixed.tsx":
			'import { AdminFormLoader, ShellLoader } from "@/components/loaders";\nexport const loaders = [AdminFormLoader, ShellLoader];\n',
		"apps/web/app/direct.tsx":
			'import { AdminFormLoader } from "../components/loaders/detail-loaders";\nexport const Direct = AdminFormLoader;\n',
		"packages/ui/package.json": JSON.stringify({
			name: "@scope/ui",
			exports: {
				".": { import: "./dist/index.js", types: "./dist/index.d.ts" },
				"./loaders": {
					import: "./dist/loaders/index.js",
					types: "./dist/loaders/index.d.ts",
				},
			},
		}),
		"packages/ui/src/index.ts": 'export const clientOnly = "client";\n',
		"packages/ui/src/loaders/index.ts":
			'import { AdminFormLoader as moved, ShellLoader as kept } from "@/components/loaders";\nexport const combined = [moved, kept];\n',
		...overrides,
	};
	for (const file of omitted) {
		delete files[file];
	}
	const dir = await makeFixture("move-subpath-barrel", files, {
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
		source: path.join(dir, "apps/web/components/loaders/detail-loaders.tsx"),
		target: path.join(dir, "packages/ui/src/loaders/detail-loaders.tsx"),
		barrel: path.join(dir, "packages/ui/src/loaders/index.ts"),
		rootBarrel: path.join(dir, "packages/ui/src/index.ts"),
	};
}

test("CLI and MCP expose the library's subpath move preview without writes (#263)", async () => {
	const { dir, files, workspace, project, source, target } =
		await subpathFixture();
	const preview = await moveModule(
		source,
		target,
		project,
		true,
		false,
		workspace
	);
	expect(preview.success).toBe(true);
	const expectedEdits = serializeStructuredEdits(preview.edits, (file) =>
		path.relative(dir, file)
	);
	const cli = await runCli([
		"move",
		source,
		target,
		"--workspace",
		"--dry-run",
		"--json",
		"-p",
		dir,
	]);
	expect(cli.exitCode).toBe(0);
	const cliPayload: { success: boolean; edits: SerializedEdit[] } = JSON.parse(
		cli.stdout
	);
	expect(cliPayload.success).toBe(true);
	expect(cliPayload.edits).toEqual(expectedEdits);
	const mcpPayload = parseMcpTextPayload<{
		success: boolean;
		edits: SerializedEdit[];
	}>(
		await moveTool({
			source,
			target,
			project: dir,
			dryRun: true,
			force: false,
			verify: false,
			verbose: false,
		})
	);
	expect(mcpPayload.success).toBe(true);
	expect(mcpPayload.edits).toEqual(expectedEdits);
	for (const [file, content] of Object.entries(files)) {
		expect(await Bun.file(path.join(dir, file)).text()).toBe(content);
	}
	expect(await Bun.file(target).exists()).toBe(false);
});

test.each([
	false,
	true,
])("cross-package folder exports preserve preview/application parity (compact: %s) (#263)", async (compact) => {
	const { dir, files, workspace, project, source, target, barrel, rootBarrel } =
		await subpathFixture();
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
	expect(preview.edits.some((edit) => edit.file === rootBarrel)).toBe(false);
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
	expect(await applyMoveModulePlan(plan)).toEqual(preview);
	for (const [file, original] of originals) {
		expect(await Bun.file(file).text()).toBe(
			applyStructuredEdits(
				original,
				preview.edits.filter((edit) => edit.file === file)
			)
		);
	}
	expect(files["packages/ui/src/index.ts"]).toBe(
		await Bun.file(rootBarrel).text()
	);
	const destination = await Bun.file(barrel).text();
	expect(destination).toContain('export * from "./detail-loaders"');
	expect(destination).toContain('from "./detail-loaders"');
	expect(destination).toContain("ShellLoader as kept");
	for (const file of ["loading.tsx", "mixed.tsx", "direct.tsx"]) {
		const content = await Bun.file(path.join(dir, "apps/web/app", file)).text();
		expect(content).toContain('from "@scope/ui/loaders"');
		expect(content).not.toContain('from "@scope/ui"');
	}
	const mixed = await Bun.file(path.join(dir, "apps/web/app/mixed.tsx")).text();
	expect(mixed).toContain('import { ShellLoader } from "@/components/loaders"');
	expect(await Bun.file(source).exists()).toBe(false);
	expect(await Bun.file(target).exists()).toBe(true);
});

test.each([
	{
		name: "aliased export key with nested conditions",
		exports: {
			"./loading": {
				browser: { default: "./src/loaders/index.ts" },
				types: "./dist/loaders/index.d.ts",
				default: "./dist/loaders/index.js",
			},
		},
		target: "loaders/detail-loaders.tsx",
		barrel: "loaders/index.ts",
		specifier: "@scope/ui/loading",
	},
	{
		name: "most specific covering source folder",
		exports: {
			"./loaders": "./dist/loaders/index.js",
			"./forms": "./dist/loaders/forms/index.js",
		},
		target: "loaders/forms/detail-loaders.tsx",
		barrel: "loaders/forms/index.ts",
		specifier: "@scope/ui/forms",
	},
	{
		name: "most specific folder regardless of manifest order",
		exports: {
			"./forms": "./dist/loaders/forms/index.js",
			"./loaders": "./dist/loaders/index.js",
		},
		target: "loaders/forms/detail-loaders.tsx",
		barrel: "loaders/forms/index.ts",
		specifier: "@scope/ui/forms",
	},
	{
		name: "unrelated target with a matching export key",
		exports: { "./loaders": "./dist/other/index.js" },
		target: "loaders/detail-loaders.tsx",
		barrel: "index.ts",
		specifier: "@scope/ui",
	},
	{
		name: "missing exported barrel",
		exports: { "./loaders": "./dist/missing/index.js" },
		target: "loaders/detail-loaders.tsx",
		barrel: "index.ts",
		specifier: "@scope/ui",
	},
	{
		name: "ambiguous conditional source barrels",
		exports: {
			"./loaders": {
				import: "./src/loaders/index.ts",
				require: "./src/other/index.ts",
			},
		},
		target: "loaders/detail-loaders.tsx",
		barrel: "index.ts",
		specifier: "@scope/ui",
	},
	{
		name: "folder name prefix without directory containment",
		exports: { "./loaders": "./dist/loaders/index.js" },
		target: "loaders-extra/detail-loaders.tsx",
		barrel: "index.ts",
		specifier: "@scope/ui",
	},
])("selects import and destination together: $name (#263)", async (scenario) => {
	const { dir, workspace } = await subpathFixture({
		"packages/ui/package.json": JSON.stringify({
			name: "@scope/ui",
			exports: { ".": "./dist/index.js", ...scenario.exports },
		}),
		"packages/ui/src/loaders/forms/index.ts": "export const form = true;\n",
		"packages/ui/src/other/index.ts": "export const other = true;\n",
	});
	const target = path.join(dir, "packages/ui/src", scenario.target);
	expect(findCrossPackageImport(target, workspace)).toBe(scenario.specifier);
	expect(findDestinationBarrel(target, workspace)).toBe(
		path.join(dir, "packages/ui/src", scenario.barrel)
	);
});

test("a dedicated file export still wins over its folder barrel (#263)", async () => {
	const { workspace, target } = await subpathFixture({
		"packages/ui/package.json": JSON.stringify({
			name: "@scope/ui",
			exports: {
				".": "./dist/index.js",
				"./loaders": "./dist/loaders/index.js",
				"./loaders/detail-loaders": "./dist/loaders/detail-loaders.js",
			},
		}),
	});
	expect(findCrossPackageImport(target, workspace)).toBe(
		"@scope/ui/loaders/detail-loaders"
	);
});

test("a nested barrel does not imply that the package root exists (#263)", async () => {
	const { dir, workspace, target, barrel } = await subpathFixture({}, [
		"packages/ui/src/index.ts",
	]);
	expect(findCrossPackageImport(target, workspace)).toBe("@scope/ui/loaders");
	expect(findDestinationBarrel(target, workspace)).toBe(barrel);
	expect(
		findCrossPackageImport(
			path.join(dir, "packages/ui/src/other.ts"),
			workspace
		)
	).toBe("@scope/ui/src/other");
});

test("new and removed subpath barrels invalidate workspace discovery (#263)", async () => {
	const { dir, target, barrel, workspace } = await subpathFixture({}, [
		"packages/ui/src/loaders/index.ts",
	]);
	expect(findCrossPackageImport(target, workspace)).toBe("@scope/ui");
	await Bun.write(barrel, "export const existing = true;\n");
	const added = await discoverWorkspace(dir);
	expect(added).not.toBeNull();
	if (!added) {
		throw new Error("Expected workspace after adding barrel");
	}
	expect(findCrossPackageImport(target, added)).toBe("@scope/ui/loaders");
	await unlink(barrel);
	const removed = await discoverWorkspace(dir);
	expect(removed).not.toBeNull();
	if (!removed) {
		throw new Error("Expected workspace after removing barrel");
	}
	expect(findCrossPackageImport(target, removed)).toBe("@scope/ui");
});

test("conflicts in the chosen subpath barrel refuse the move without writes (#263)", async () => {
	const { dir, files, source, target, project, workspace } =
		await subpathFixture({
			"packages/ui/src/loaders/index.ts": "export const AdminFormLoader = 1;\n",
		});
	const result = await moveModule(
		source,
		target,
		project,
		false,
		false,
		workspace
	);
	expect(result.success).toBe(false);
	expect(result.errors).toContainEqual({
		file: path.join(dir, "packages/ui/src/loaders/index.ts"),
		message: expect.stringContaining(
			'Conflict: "AdminFormLoader" already exists'
		),
		recoverable: false,
	});
	for (const [file, content] of Object.entries(files)) {
		expect(await Bun.file(path.join(dir, file)).text()).toBe(content);
	}
	expect(await Bun.file(target).exists()).toBe(false);
});

test("root-only names do not conflict with a subpath barrel move (#263)", async () => {
	const { files, source, target, project, workspace, rootBarrel } =
		await subpathFixture({
			"packages/ui/src/index.ts": "export const AdminFormLoader = 1;\n",
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
	expect(files["packages/ui/src/index.ts"]).toBe(
		await Bun.file(rootBarrel).text()
	);
});
