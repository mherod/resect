import { afterAll, describe, expect, test } from "bun:test";
import path from "node:path";
import { cleanup, makeFixture } from "./__test-helpers.ts";
import { moveInFixture } from "./move-test-helpers.ts";

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
