import { afterAll, describe, expect, test } from "bun:test";
import path from "node:path";
import { cleanup, makeFixture } from "./__test-helpers.ts";
import { moveInFixture } from "./move-test-helpers.ts";

/**
 * Regression coverage for #122: when `move` relocates a file, its import of an
 * UNRELATED workspace package's barrel (`@scope/other`) — a package that is
 * neither the move source nor destination — must be left untouched. The bug
 * rewrote it to `@scope/other/index`, an unexported subpath that fails with
 * TS2307. A bare package-barrel import resolves identically from any location.
 *
 * Sibling of #121 (the destination-package self-import case).
 */

const created: string[] = [];
async function fixture(name: string, files: Record<string, string>) {
	const dir = await makeFixture(`move-xpkg-barrel-${name}`, files);
	created.push(dir);
	return dir;
}

afterAll(async () => {
	await Promise.all(created.map(cleanup));
});

// `@scope/web-analytics` (move destination) and `@scope/web-hooks` (an
// unrelated package) are both tsconfig path aliases onto their `src` dirs, so
// each bare specifier resolves to that package's barrel `src/index.ts`.
const WORKSPACE = {
	"pnpm-workspace.yaml": 'packages:\n  - "packages/*"\n  - "apps/*"\n',
	"tsconfig.json": JSON.stringify({
		compilerOptions: {
			strict: true,
			baseUrl: ".",
			paths: {
				"@scope/web-analytics": ["packages/web-analytics/src"],
				"@scope/web-hooks": ["packages/web-hooks/src"],
			},
		},
		include: ["apps/**/*.ts", "packages/**/*.ts"],
	}),
	"packages/web-analytics/package.json": JSON.stringify({
		name: "@scope/web-analytics",
		dependencies: { "@scope/web-hooks": "workspace:*" },
	}),
	"packages/web-analytics/src/index.ts": "export const VERSION = 1;\n",
	"packages/web-hooks/package.json": JSON.stringify({
		name: "@scope/web-hooks",
	}),
	"packages/web-hooks/src/types.ts":
		"export type CookiePreferences = { analytics: boolean };\n",
	"packages/web-hooks/src/index.ts": 'export * from "./types";\n',
	"apps/web/package.json": JSON.stringify({
		name: "web",
		dependencies: {
			"@scope/web-analytics": "workspace:*",
			"@scope/web-hooks": "workspace:*",
		},
	}),
	"apps/web/lib/analytics/consent-service.ts":
		'import type { CookiePreferences } from "@scope/web-hooks";\n' +
		"export const accept = (p: CookiePreferences): boolean => p.analytics;\n",
} as const;

describe("move unrelated-package barrel import rewrite (#122)", () => {
	test("leaves an unrelated package's bare barrel import untouched", async () => {
		const dir = await fixture("untouched", { ...WORKSPACE });
		const result = await moveInFixture(
			dir,
			"apps/web/lib/analytics/consent-service.ts",
			"packages/web-analytics/src/consent-service.ts"
		);

		expect(result.success).toBe(true);

		const moved = await Bun.file(
			path.join(dir, "packages/web-analytics/src/consent-service.ts")
		).text();

		// Hard requirement: never append `/index` to a package barrel specifier.
		expect(moved).not.toContain("@scope/web-hooks/index");
		// The bare package import resolves identically from any location — leave it.
		expect(moved).toContain('from "@scope/web-hooks"');
	});
});
