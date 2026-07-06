import { afterAll, describe, expect, test } from "bun:test";
import { cleanup, makeFixture } from "./__test-helpers.ts";
import { affected } from "./affected.ts";

const created: string[] = [];
async function fixture(name: string, files: Record<string, string>) {
	const dir = await makeFixture(`affected-${name}`, files);
	created.push(dir);
	return dir;
}

afterAll(async () => {
	await Promise.all(created.map(cleanup));
});

const TSCONFIG = JSON.stringify({
	compilerOptions: { strict: true },
	include: ["**/*.ts"],
});

describe("affected engine", () => {
	test("finds transitive importers in a single-package project", async () => {
		const dir = await fixture("transitive", {
			"tsconfig.json": TSCONFIG,
			"c.ts": "export const c = 1;",
			"b.ts": 'import { c } from "./c";\nexport const b = c + 1;',
			"a.ts": 'import { b } from "./b";\nconsole.log(b);',
			"unrelated.ts": "console.log('hello');",
		});

		// We need to temporarily change current working directory or pass absolute files
		const originalCwd = process.cwd();
		process.chdir(dir);
		try {
			const result = await affected({
				files: ["c.ts"],
				project: dir,
			});

			expect(result).toContain("c.ts");
			expect(result).toContain("b.ts");
			expect(result).toContain("a.ts");
			expect(result).not.toContain("unrelated.ts");
			expect(result.length).toBe(3);
		} finally {
			process.chdir(originalCwd);
		}
	});

	test("handles multiple changed files", async () => {
		const dir = await fixture("multiple", {
			"tsconfig.json": TSCONFIG,
			"b.ts": "export const b = 1;",
			"a.ts": 'import { b } from "./b";\nconsole.log(b);',
			"y.ts": "export const y = 1;",
			"x.ts": 'import { y } from "./y";\nconsole.log(y);',
		});

		const originalCwd = process.cwd();
		process.chdir(dir);
		try {
			const result = await affected({
				files: ["b.ts", "y.ts"],
				project: dir,
			});

			expect(result).toEqual(["a.ts", "b.ts", "x.ts", "y.ts"]);
		} finally {
			process.chdir(originalCwd);
		}
	});

	test("workspace option traces cross-package transitive imports", async () => {
		const dir = await fixture("workspace-transitive", {
			"pnpm-workspace.yaml": 'packages:\n  - "packages/*"\n',
			"tsconfig.json": JSON.stringify({
				compilerOptions: {
					strict: true,
					baseUrl: ".",
					paths: {
						"@scope/pkg-a": ["packages/pkg-a/src"],
					},
				},
				include: ["packages/**/*.ts"],
			}),
			"packages/pkg-a/package.json": JSON.stringify({
				name: "@scope/pkg-a",
				dependencies: {},
			}),
			"packages/pkg-a/tsconfig.json": JSON.stringify({
				compilerOptions: {
					strict: true,
					baseUrl: ".",
					paths: {
						"@scope/pkg-a": ["src"],
					},
				},
				include: ["src/**/*.ts"],
			}),
			"packages/pkg-a/src/helper.ts": "export const helper = 42;",
			"packages/pkg-a/src/index.ts": "export * from './helper';",

			"packages/pkg-b/package.json": JSON.stringify({
				name: "@scope/pkg-b",
				dependencies: {
					"@scope/pkg-a": "workspace:*",
				},
			}),
			"packages/pkg-b/tsconfig.json": JSON.stringify({
				compilerOptions: {
					strict: true,
					baseUrl: ".",
					paths: {
						"@scope/pkg-a": ["../pkg-a/src"],
					},
				},
				include: ["src/**/*.ts"],
			}),
			"packages/pkg-b/src/app.ts":
				"import { helper } from '@scope/pkg-a';\nconsole.log(helper);",
		});

		// Build path aliases / resolve specifier mappings for packages
		const originalCwd = process.cwd();
		process.chdir(dir);
		try {
			const result = await affected({
				files: ["packages/pkg-a/src/helper.ts"],
				project: dir,
				workspace: true,
			});

			expect(result).toContain("packages/pkg-a/src/helper.ts");
			expect(result).toContain("packages/pkg-a/src/index.ts");
			// Check if it also traced the cross-package import in pkg-b/src/app.ts
			expect(result).toContain("packages/pkg-b/src/app.ts");
		} finally {
			process.chdir(originalCwd);
		}
	});
});
