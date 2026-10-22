import { afterAll, describe, expect, test } from "bun:test";
import path from "node:path";
import { loadProject } from "../core/project.ts";
import { setLargeProjectSourceFiles } from "../core/project-scale.ts";
import {
	applyStructuredEdits,
	type SerializedEdit,
	serializeStructuredEdits,
} from "../core/text-changes.ts";
import { runTypeCheckDetailed } from "../core/verify.ts";
import { discoverWorkspace } from "../core/workspace.ts";
import { moveTool } from "../mcp-tools/mutating.ts";
import {
	cleanup,
	makeFixture,
	parseMcpTextPayload,
	runCli,
} from "./__test-helpers.ts";
import { applyMoveModulePlan, moveModule } from "./move-apply.ts";
import { moveInFixture } from "./move-test-helpers.ts";
import { runMutationPlanning } from "./mutation-planning.ts";

/**
 * Regression coverage for #121: when `move` relocates a file INTO a package and
 * that file imports the destination package's barrel specifier (`@scope/pkg`),
 * the now-internal self-import must be rewritten to a relative sibling path
 * (e.g. `./types`) — never to `@scope/pkg/index`, an unexported subpath that
 * fails with TS2307. Surfaces during a leaf-first migration (types.ts moved in
 * first, then dependent modules).
 */

const created: string[] = [];
async function fixture(name: string, files: Record<string, string>) {
	const dir = await makeFixture(`move-self-import-${name}`, files);
	created.push(dir);
	return dir;
}

afterAll(async () => {
	await Promise.all(created.map(cleanup));
});

async function subpathSelfImportFixture() {
	const compilerOptions = {
		strict: true,
		module: "ESNext",
		moduleResolution: "Bundler",
		target: "ESNext",
		noEmit: true,
		allowImportingTsExtensions: true,
		types: [],
	};
	const files = {
		"pnpm-workspace.yaml": 'packages:\n  - "packages/*"\n  - "apps/*"\n',
		"tsconfig.json": JSON.stringify({
			compilerOptions: {
				...compilerOptions,
				baseUrl: ".",
				paths: {
					"@scope/ui": ["packages/ui/src"],
					"@scope/ui/*": ["packages/ui/src/*"],
				},
			},
			include: ["apps/**/*.ts", "packages/*/src/**/*.ts"],
		}),
		"apps/web/package.json": JSON.stringify({ name: "web" }),
		"packages/ui/package.json": JSON.stringify({
			name: "@scope/ui",
			exports: {
				".": { types: "./dist/index.d.ts", default: "./dist/index.js" },
				"./widgets": {
					types: "./dist/widgets/index.d.ts",
					default: "./dist/widgets/index.js",
				},
				"./loaders": {
					types: "./dist/loaders/index.d.ts",
					default: "./dist/loaders/index.js",
				},
			},
		}),
		"packages/ui/tsconfig.json": JSON.stringify({
			compilerOptions,
			include: ["src/**/*.ts"],
		}),
		"packages/ui/src/index.ts": 'export const rootOnly = "root";\n',
		"packages/ui/src/widgets/index.ts":
			'export const PageWrapper = () => "page";\nexport default PageWrapper;\nexport interface WidgetProps { title: string }\n',
		"packages/ui/src/loaders/detail-page-loader.ts":
			'export const DetailPageLoader = () => "loading";\n',
		"packages/ui/src/loaders/index.ts":
			'export * from "./detail-page-loader";\n',
		"packages/ui/dist/index.d.ts": "export declare const rootOnly: string;\n",
		"packages/ui/dist/widgets/index.d.ts":
			"export declare const PageWrapper: () => string;\nexport default PageWrapper;\nexport interface WidgetProps { title: string }\n",
		"packages/ui/dist/loaders/index.d.ts":
			"export declare const DetailPageLoader: () => string;\n",
		"apps/web/detail-loaders.ts": [
			'import DefaultWrapper, { PageWrapper as NamedWrapper, type WidgetProps } from "@scope/ui/widgets";',
			'import * as Widgets from "@scope/ui/widgets";',
			'import type { WidgetProps as Props } from "@scope/ui/widgets";',
			'import { DetailPageLoader } from "@scope/ui/loaders";',
			"export const render = [DefaultWrapper, NamedWrapper, Widgets.PageWrapper, DetailPageLoader];",
			"export const props: WidgetProps | Props | null = null;",
			"",
		].join("\n"),
		"apps/web/external.ts":
			'import { PageWrapper } from "@scope/ui/widgets";\nexport const External = PageWrapper;\n',
	};
	const dir = await makeFixture("move-subpath-self-import", files, {
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
		destinationProject: loadProject(
			path.join(dir, "packages/ui/tsconfig.json")
		),
		source: path.join(dir, "apps/web/detail-loaders.ts"),
		target: path.join(dir, "packages/ui/src/loaders/detail-loaders.ts"),
	};
}

test.each([
	undefined,
	"relative",
	"alias",
	"shortest",
] as const)("subpath self-imports preserve bindings and destination resolution with preference %s (#262)", async (prefer) => {
	for (const extensions of ["preserve", "explicit"] as const) {
		const {
			files,
			workspace,
			project,
			destinationProject,
			source,
			target,
			dir,
		} = await subpathSelfImportFixture();
		const preview = await moveModule(
			source,
			target,
			project,
			true,
			false,
			workspace,
			false,
			[],
			prefer,
			extensions
		);
		expect(preview.success).toBe(true);
		for (const [file, content] of Object.entries(files)) {
			expect(await Bun.file(path.join(dir, file)).text()).toBe(content);
		}
		expect(await Bun.file(target).exists()).toBe(false);
		const applied = await moveModule(
			source,
			target,
			project,
			false,
			false,
			workspace,
			false,
			[],
			prefer,
			extensions
		);
		expect(applied).toEqual(preview);
		const moved = await Bun.file(target).text();
		const widgets =
			prefer === "alias" || (prefer === "shortest" && extensions === "explicit")
				? "@scope/ui/widgets"
				: `../widgets${extensions === "explicit" ? "/index.ts" : ""}`;
		const loaders =
			prefer === "alias"
				? "@scope/ui/loaders"
				: `./detail-page-loader${extensions === "explicit" ? ".ts" : ""}`;
		expect(moved).toBe(
			files["apps/web/detail-loaders.ts"]
				.replaceAll("@scope/ui/widgets", widgets)
				.replaceAll("@scope/ui/loaders", loaders)
		);
		expect(moved).not.toContain("@scope/ui/widgets/index");
		expect(moved).toBe(
			applyStructuredEdits(
				files["apps/web/detail-loaders.ts"],
				preview.edits.filter((edit) => edit.file === target)
			)
		);
		expect(await Bun.file(path.join(dir, "apps/web/external.ts")).text()).toBe(
			files["apps/web/external.ts"]
		);
		const checked = await runTypeCheckDetailed(destinationProject);
		expect(checked.incomplete).toBe(false);
		expect(checked.errors).toEqual([]);
	}
});

test("CLI, MCP and compact planning preserve subpath self-import preview parity (#262)", async () => {
	const { dir, project, workspace, source, target } =
		await subpathSelfImportFixture();
	const preview = await moveModule(
		source,
		target,
		project,
		true,
		false,
		workspace
	);
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
	const cliPayload: { success: boolean; edits: SerializedEdit[] } = JSON.parse(
		cli.stdout
	);
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
	const plan = await runMutationPlanning({
		kind: "move",
		args: [source, target, project, false, workspace],
		compactWrites: true,
	});
	for (const result of [cliPayload, mcpPayload]) {
		expect(result.success).toBe(true);
		expect(result.edits).toEqual(expectedEdits);
	}
	expect(cli.exitCode).toBe(0);
	expect(plan.result).toEqual(preview);
	expect(await Bun.file(target).exists()).toBe(false);
	expect(await applyMoveModulePlan(plan)).toEqual(preview);
	expect(await Bun.file(target).text()).not.toContain(
		"@scope/ui/widgets/index"
	);
});

test("all moved-file reference forms share valid subpath selection (#262)", async () => {
	const { project, workspace, source, target } =
		await subpathSelfImportFixture();
	const original = [
		'import "@scope/ui/widgets";',
		'import Widgets = require("@scope/ui/widgets");',
		'export * from "@scope/ui/widgets";',
		'export * as AllWidgets from "@scope/ui/widgets";',
		'export { PageWrapper as Wrapper } from "@scope/ui/widgets";',
		'const dynamic = import("@scope/ui/widgets");',
		'const required = require("@scope/ui/widgets");',
		'const resolved = require.resolve("@scope/ui/widgets");',
		'jest.mock("@scope/ui/widgets");',
		'vi.mock("@scope/ui/widgets");',
		"",
	].join("\n");
	await Bun.write(source, original);
	const result = await moveModule(
		source,
		target,
		project,
		false,
		false,
		workspace
	);
	expect(result.success).toBe(true);
	expect(await Bun.file(target).text()).toBe(
		original.replaceAll("@scope/ui/widgets", "../widgets")
	);
});

// A pnpm-workspace where `@scope/web-analytics` is a tsconfig path alias
// pointing at the package `src` directory (so the bare specifier resolves to
// the package barrel `src/index.ts`). The leaf module `types.ts` already lives
// inside the package and is re-exported by the barrel.
const WORKSPACE = {
	"pnpm-workspace.yaml": 'packages:\n  - "packages/*"\n  - "apps/*"\n',
	"tsconfig.json": JSON.stringify({
		compilerOptions: {
			strict: true,
			baseUrl: ".",
			paths: { "@scope/web-analytics": ["packages/web-analytics/src"] },
		},
		include: ["apps/**/*.ts", "packages/**/*.ts"],
	}),
	"packages/web-analytics/package.json": JSON.stringify({
		name: "@scope/web-analytics",
		dependencies: {},
	}),
	"packages/web-analytics/src/types.ts":
		"export type AnalyticsEvent = { name: string };\n" +
		"export type ProviderConfig = { id: string };\n",
	"packages/web-analytics/src/index.ts": 'export * from "./types";\n',
	"apps/web/package.json": JSON.stringify({
		name: "web",
		dependencies: { "@scope/web-analytics": "workspace:*" },
	}),
	"apps/web/lib/analytics/base-provider.ts":
		'import type { AnalyticsEvent, ProviderConfig } from "@scope/web-analytics";\n' +
		"export const make = (): AnalyticsEvent | ProviderConfig | null => null;\n",
} as const;

describe("move intra-package self-import rewrite (#121)", () => {
	test.each([
		0, 128,
	])("resolves wildcard barrel siblings outside include with %s filler files", async (fillers) => {
		const config = JSON.parse(WORKSPACE["tsconfig.json"]);
		config.include = ["apps/**/*.ts"];
		const files: Record<string, string> = {
			...WORKSPACE,
			"tsconfig.json": JSON.stringify(config),
		};
		for (let index = 0; index < fillers; index++) {
			files[`apps/web/filler${index}.ts`] =
				`export const filler${index} = ${index};`;
		}
		const dir = await fixture("barrel-outside-include", files);
		// Filler files stand in for a large project on the planning-worker path.
		setLargeProjectSourceFiles(fillers || undefined);
		const result = await moveInFixture(
			dir,
			"apps/web/lib/analytics/base-provider.ts",
			"packages/web-analytics/src/base-provider.ts"
		).finally(() => {
			setLargeProjectSourceFiles(undefined);
		});
		expect(result.success).toBe(true);
		const moved = await Bun.file(
			path.join(dir, "packages/web-analytics/src/base-provider.ts")
		).text();
		expect(moved).toContain('from "./types"');
	});

	test("rewrites a moved-in file's barrel self-import to the defining sibling", async () => {
		const dir = await fixture("barrel-to-sibling", { ...WORKSPACE });
		const result = await moveInFixture(
			dir,
			"apps/web/lib/analytics/base-provider.ts",
			"packages/web-analytics/src/base-provider.ts"
		);

		expect(result.success).toBe(true);

		const moved = await Bun.file(
			path.join(dir, "packages/web-analytics/src/base-provider.ts")
		).text();

		// Hard requirement: never emit the unexported `@scope/pkg/index` subpath.
		expect(moved).not.toContain("@scope/web-analytics/index");
		// And it must not keep going through the package barrel from inside it.
		expect(moved).not.toContain("@scope/web-analytics");
		// Ideal: resolve to the sibling module that actually defines the bindings.
		expect(moved).toContain('from "./types"');
	});

	test("falls back to a resolvable relative path when bindings are not split", async () => {
		// Bindings come from the barrel directly (no re-export indirection):
		// the rewrite must still be relative and resolvable, never `/index`.
		const dir = await fixture("barrel-direct", {
			...WORKSPACE,
			"packages/web-analytics/src/index.ts":
				"export type AnalyticsEvent = { name: string };\n",
			"apps/web/lib/analytics/base-provider.ts":
				'import type { AnalyticsEvent } from "@scope/web-analytics";\n' +
				"export const make = (): AnalyticsEvent | null => null;\n",
		});
		const result = await moveInFixture(
			dir,
			"apps/web/lib/analytics/base-provider.ts",
			"packages/web-analytics/src/base-provider.ts"
		);

		expect(result.success).toBe(true);
		const moved = await Bun.file(
			path.join(dir, "packages/web-analytics/src/base-provider.ts")
		).text();
		expect(moved).not.toContain("@scope/web-analytics/index");
		// Relative self-reference to the barrel is acceptable (resolvable);
		// the forbidden output is the `/index` subpath.
		expect(moved).toMatch(/from "\.(\/index|)"/);
	});
});
