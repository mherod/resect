import { afterAll, describe, expect, test } from "bun:test";
import path from "node:path";
import { cleanup, makeFixture } from "./__test-helpers.ts";
import { moveInFixture } from "./move-test-helpers.ts";

/**
 * End-to-end coverage for #118: a cross-package `move` must sync the moved
 * file's external dependencies into the destination package.json. Exercises the
 * scanner external-import seam (scanExternalImports) + the dependency-sync
 * write path through the real moveModule pipeline on a pnpm-workspace fixture.
 */

const created: string[] = [];
async function fixture(name: string, files: Record<string, string>) {
	const dir = await makeFixture(`move-deps-${name}`, files);
	created.push(dir);
	return dir;
}

afterAll(async () => {
	await Promise.all(created.map(cleanup));
});

const WORKSPACE = {
	"pnpm-workspace.yaml": 'packages:\n  - "packages/*"\n',
	"tsconfig.json": JSON.stringify({
		compilerOptions: { strict: true },
		include: ["packages/**/*.ts"],
	}),
	"packages/pkg-a/package.json": JSON.stringify({
		name: "@scope/pkg-a",
		dependencies: { lodash: "^4.17.21" },
	}),
	"packages/pkg-a/src/foo.ts": 'import _ from "lodash";\nexport const foo = _;',
	"packages/pkg-b/package.json": JSON.stringify({
		name: "@scope/pkg-b",
		dependencies: {},
	}),
	"packages/pkg-b/src/keep.ts": "export const keep = true;",
} as const;

async function readJson(filePath: string): Promise<Record<string, unknown>> {
	return JSON.parse(await Bun.file(filePath).text());
}

describe("move cross-package dependency sync (#118)", () => {
	test("adds the moved file's external dep to the destination package.json", async () => {
		const dir = await fixture("external-added", { ...WORKSPACE });
		const result = await moveInFixture(
			dir,
			"packages/pkg-a/src/foo.ts",
			"packages/pkg-b/src/foo.ts"
		);

		expect(result.success).toBe(true);
		expect(result.dependencyChanges).toEqual([
			{
				packageJsonPath: path.join(dir, "packages/pkg-b/package.json"),
				name: "lodash",
				version: "^4.17.21",
				field: "dependencies",
			},
		]);

		const destPkg = await readJson(
			path.join(dir, "packages/pkg-b/package.json")
		);
		expect((destPkg.dependencies as Record<string, string>).lodash).toBe(
			"^4.17.21"
		);
	});

	test("is a no-op when the destination already declares the dep", async () => {
		const dir = await fixture("already-present", {
			...WORKSPACE,
			"packages/pkg-b/package.json": JSON.stringify({
				name: "@scope/pkg-b",
				dependencies: { lodash: "^4.0.0" },
			}),
		});
		const result = await moveInFixture(
			dir,
			"packages/pkg-a/src/foo.ts",
			"packages/pkg-b/src/foo.ts"
		);

		expect(result.dependencyChanges).toEqual([]);
		const destPkg = await readJson(
			path.join(dir, "packages/pkg-b/package.json")
		);
		// Existing range is untouched (no downgrade/upgrade).
		expect((destPkg.dependencies as Record<string, string>).lodash).toBe(
			"^4.0.0"
		);
	});

	test("dry-run reports the proposed addition without writing", async () => {
		const dir = await fixture("dry-run", { ...WORKSPACE });
		const result = await moveInFixture(
			dir,
			"packages/pkg-a/src/foo.ts",
			"packages/pkg-b/src/foo.ts",
			true
		);

		expect(result.dependencyChanges).toHaveLength(1);
		const destPkg = await readJson(
			path.join(dir, "packages/pkg-b/package.json")
		);
		// Nothing written on dry-run.
		expect(destPkg.dependencies).toEqual({});
	});

	test("maps a subpath import (lodash/fp) back to its package name", async () => {
		const dir = await fixture("subpath", {
			...WORKSPACE,
			"packages/pkg-a/src/foo.ts":
				'import fp from "lodash/fp";\nexport const foo = fp;',
		});
		const result = await moveInFixture(
			dir,
			"packages/pkg-a/src/foo.ts",
			"packages/pkg-b/src/foo.ts"
		);

		expect(result.dependencyChanges).toEqual([
			{
				packageJsonPath: path.join(dir, "packages/pkg-b/package.json"),
				name: "lodash",
				version: "^4.17.21",
				field: "dependencies",
			},
		]);
	});

	test("same-package move does not touch any package.json", async () => {
		const dir = await fixture("same-pkg", { ...WORKSPACE });
		const result = await moveInFixture(
			dir,
			"packages/pkg-a/src/foo.ts",
			"packages/pkg-a/src/bar.ts"
		);

		expect(result.dependencyChanges).toEqual([]);
	});
});

/**
 * End-to-end coverage for #119 (#102 B/3): a cross-package `move` must sync the
 * moved file's INTERNAL monorepo imports into the destination package.json as
 * `workspace:*`, distinct from #118's external semver copy. Exercises the
 * internal/external partition keyed on `workspace.packages[].name`.
 */
const INTERNAL_WORKSPACE = {
	"pnpm-workspace.yaml": 'packages:\n  - "packages/*"\n',
	"tsconfig.json": JSON.stringify({
		compilerOptions: { strict: true },
		include: ["packages/**/*.ts"],
	}),
	"packages/core/package.json": JSON.stringify({ name: "@scope/core" }),
	"packages/core/src/index.ts": "export const core = 1;",
	"packages/pkg-a/package.json": JSON.stringify({
		name: "@scope/pkg-a",
		dependencies: { lodash: "^4.17.21" },
	}),
	"packages/pkg-a/src/foo.ts":
		'import { core } from "@scope/core";\nexport const foo = core;',
	"packages/pkg-b/package.json": JSON.stringify({
		name: "@scope/pkg-b",
		dependencies: {},
	}),
	"packages/pkg-b/src/keep.ts": "export const keep = true;",
} as const;

describe("move cross-package internal-dependency sync (#119)", () => {
	test("adds an imported sibling workspace package as workspace:*", async () => {
		const dir = await fixture("internal-added", { ...INTERNAL_WORKSPACE });
		const result = await moveInFixture(
			dir,
			"packages/pkg-a/src/foo.ts",
			"packages/pkg-b/src/foo.ts"
		);

		expect(result.success).toBe(true);
		expect(result.dependencyChanges).toEqual([
			{
				packageJsonPath: path.join(dir, "packages/pkg-b/package.json"),
				name: "@scope/core",
				version: "workspace:*",
				field: "dependencies",
			},
		]);
		const destPkg = await readJson(
			path.join(dir, "packages/pkg-b/package.json")
		);
		expect(
			(destPkg.dependencies as Record<string, string>)["@scope/core"]
		).toBe("workspace:*");
	});

	test("splits a mixed external + internal import correctly", async () => {
		const dir = await fixture("mixed", {
			...INTERNAL_WORKSPACE,
			"packages/pkg-a/src/foo.ts":
				'import _ from "lodash";\nimport { core } from "@scope/core";\nexport const foo = [_, core];',
		});
		const result = await moveInFixture(
			dir,
			"packages/pkg-a/src/foo.ts",
			"packages/pkg-b/src/foo.ts"
		);

		expect(result.success).toBe(true);
		const destPkg = await readJson(
			path.join(dir, "packages/pkg-b/package.json")
		);
		const deps = destPkg.dependencies as Record<string, string>;
		// External keeps the source semver; internal becomes workspace:*.
		expect(deps.lodash).toBe("^4.17.21");
		expect(deps["@scope/core"]).toBe("workspace:*");
	});

	test("never declares the destination package as its own dependency", async () => {
		const dir = await fixture("self-import", {
			...INTERNAL_WORKSPACE,
			// The moved file imports the destination package's own barrel.
			"packages/pkg-a/src/foo.ts":
				'import { keep } from "@scope/pkg-b";\nexport const foo = keep;',
			"packages/pkg-b/src/index.ts": 'export { keep } from "./keep.ts";',
			"packages/pkg-b/package.json": JSON.stringify({
				name: "@scope/pkg-b",
				dependencies: {},
			}),
		});
		const result = await moveInFixture(
			dir,
			"packages/pkg-a/src/foo.ts",
			"packages/pkg-b/src/foo.ts"
		);

		// @scope/pkg-b must NOT be added as a dependency of @scope/pkg-b.
		expect(result.dependencyChanges).toEqual([]);
		const destPkg = await readJson(
			path.join(dir, "packages/pkg-b/package.json")
		);
		expect(destPkg.dependencies).toEqual({});
	});

	test("dry-run reports the internal addition without writing", async () => {
		const dir = await fixture("internal-dry-run", { ...INTERNAL_WORKSPACE });
		const result = await moveInFixture(
			dir,
			"packages/pkg-a/src/foo.ts",
			"packages/pkg-b/src/foo.ts",
			true
		);

		expect(result.dependencyChanges).toEqual([
			{
				packageJsonPath: path.join(dir, "packages/pkg-b/package.json"),
				name: "@scope/core",
				version: "workspace:*",
				field: "dependencies",
			},
		]);
		const destPkg = await readJson(
			path.join(dir, "packages/pkg-b/package.json")
		);
		expect(destPkg.dependencies).toEqual({});
	});

	test("does not clobber an existing workspace protocol style", async () => {
		const dir = await fixture("internal-existing", {
			...INTERNAL_WORKSPACE,
			"packages/pkg-b/package.json": JSON.stringify({
				name: "@scope/pkg-b",
				dependencies: { "@scope/core": "workspace:^" },
			}),
		});
		const result = await moveInFixture(
			dir,
			"packages/pkg-a/src/foo.ts",
			"packages/pkg-b/src/foo.ts"
		);

		expect(result.dependencyChanges).toEqual([]);
		const destPkg = await readJson(
			path.join(dir, "packages/pkg-b/package.json")
		);
		// Existing protocol style is preserved (no downgrade to workspace:*).
		expect(
			(destPkg.dependencies as Record<string, string>)["@scope/core"]
		).toBe("workspace:^");
	});
});

/**
 * End-to-end coverage for #120 (#102 C/3): a cross-package `move` must HALT
 * (write nothing, no file move) when it would pull a dependency the destination
 * package forbids via its `restrictedDependencies` policy, unless `--force`.
 * The policy source is the destination package.json's `restrictedDependencies`
 * array (decided on issue #120). pkg-b restricts `lodash`; foo.ts imports it.
 */
const RESTRICTED_WORKSPACE = {
	"pnpm-workspace.yaml": 'packages:\n  - "packages/*"\n',
	"tsconfig.json": JSON.stringify({
		compilerOptions: { strict: true },
		include: ["packages/**/*.ts"],
	}),
	"packages/pkg-a/package.json": JSON.stringify({
		name: "@scope/pkg-a",
		dependencies: { lodash: "^4.17.21" },
	}),
	"packages/pkg-a/src/foo.ts": 'import _ from "lodash";\nexport const foo = _;',
	"packages/pkg-b/package.json": JSON.stringify({
		name: "@scope/pkg-b",
		dependencies: {},
		restrictedDependencies: ["lodash"],
	}),
	"packages/pkg-b/src/keep.ts": "export const keep = true;",
} as const;

describe("move cross-package restricted-dependency guardrail (#120)", () => {
	test("halts the move when a restricted dep would be added", async () => {
		const dir = await fixture("restricted-blocked", {
			...RESTRICTED_WORKSPACE,
		});
		const result = await moveInFixture(
			dir,
			"packages/pkg-a/src/foo.ts",
			"packages/pkg-b/src/foo.ts"
		);

		expect(result.success).toBe(false);
		expect(result.restrictedViolations).toEqual([
			{
				name: "lodash",
				destinationPackage: "@scope/pkg-b",
				packageJsonPath: path.join(dir, "packages/pkg-b/package.json"),
			},
		]);
		// No file move and no package.json write.
		expect(
			await Bun.file(path.join(dir, "packages/pkg-a/src/foo.ts")).exists()
		).toBe(true);
		expect(
			await Bun.file(path.join(dir, "packages/pkg-b/src/foo.ts")).exists()
		).toBe(false);
		const destPkg = await readJson(
			path.join(dir, "packages/pkg-b/package.json")
		);
		expect(destPkg.dependencies).toEqual({});
	});

	test("--force proceeds and reports the overridden violation", async () => {
		const dir = await fixture("restricted-force", { ...RESTRICTED_WORKSPACE });
		const result = await moveInFixture(
			dir,
			"packages/pkg-a/src/foo.ts",
			"packages/pkg-b/src/foo.ts",
			false,
			true
		);

		expect(result.success).toBe(true);
		expect(result.restrictedViolations).toEqual([
			{
				name: "lodash",
				destinationPackage: "@scope/pkg-b",
				packageJsonPath: path.join(dir, "packages/pkg-b/package.json"),
			},
		]);
		// The move proceeded: file moved and the dep was synced despite the policy.
		expect(
			await Bun.file(path.join(dir, "packages/pkg-b/src/foo.ts")).exists()
		).toBe(true);
		const destPkg = await readJson(
			path.join(dir, "packages/pkg-b/package.json")
		);
		expect((destPkg.dependencies as Record<string, string>).lodash).toBe(
			"^4.17.21"
		);
	});

	test("an unrestricted dep is unaffected by the policy", async () => {
		const dir = await fixture("restricted-other-dep", {
			...RESTRICTED_WORKSPACE,
			// pkg-b restricts react-dom, but foo.ts only imports lodash.
			"packages/pkg-b/package.json": JSON.stringify({
				name: "@scope/pkg-b",
				dependencies: {},
				restrictedDependencies: ["react-dom"],
			}),
		});
		const result = await moveInFixture(
			dir,
			"packages/pkg-a/src/foo.ts",
			"packages/pkg-b/src/foo.ts"
		);

		expect(result.success).toBe(true);
		expect(result.restrictedViolations).toBeUndefined();
		const destPkg = await readJson(
			path.join(dir, "packages/pkg-b/package.json")
		);
		expect((destPkg.dependencies as Record<string, string>).lodash).toBe(
			"^4.17.21"
		);
	});

	test("--dry-run reports the would-be violation without writing", async () => {
		const dir = await fixture("restricted-dry-run", {
			...RESTRICTED_WORKSPACE,
		});
		const result = await moveInFixture(
			dir,
			"packages/pkg-a/src/foo.ts",
			"packages/pkg-b/src/foo.ts",
			true
		);

		expect(result.success).toBe(false);
		expect(result.restrictedViolations).toHaveLength(1);
		// Dry-run writes nothing and moves nothing.
		expect(
			await Bun.file(path.join(dir, "packages/pkg-b/src/foo.ts")).exists()
		).toBe(false);
		const destPkg = await readJson(
			path.join(dir, "packages/pkg-b/package.json")
		);
		expect(destPkg.dependencies).toEqual({});
	});
});
