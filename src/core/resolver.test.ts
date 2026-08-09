import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import path from "node:path";
import type ts from "typescript";
import { cleanup, makeFixture } from "../commands/__test-helpers.ts";
import type {
	ExtensionPolicy,
	PreferStrategy,
} from "../commands/option-domains.ts";
import type { ProjectConfig } from "../types.ts";
import {
	calculateNewSpecifier,
	calculateRelativeSpecifier,
	findAliasForPath,
	findCrossPackageImport,
	findPackageForPath,
	findSubpathExportForFile,
	isBareImport,
	isCrossPackageMove,
	isRelativeImport,
	matchPathAlias,
	normalizePath,
	type ResolveResult,
	resolveModuleSpecifier,
} from "./resolver.ts";
import type { WorkspaceInfo, WorkspacePackage } from "./workspace.ts";

// ─── Helpers ───────────────────────────────────────────────────────────────

function makeProject(
	rootDir: string,
	pathAliases: Record<string, string[]> = {}
): ProjectConfig {
	return {
		rootDir,
		tsconfigPath: `${rootDir}/tsconfig.json`,
		compilerOptions: {
			baseUrl: rootDir,
		} as ts.CompilerOptions,
		pathAliases: new Map(Object.entries(pathAliases)),
		include: [],
		exclude: [],
		files: [],
	};
}

function makeWorkspace(
	root: string,
	packages: Array<{
		name: string;
		subdir: string;
		srcDir?: string;
		barrelFiles?: string[];
		exports?: WorkspacePackage["exports"];
	}>
): WorkspaceInfo {
	return {
		root,
		type: "pnpm",
		patterns: ["packages/*"],
		packages: packages.map(
			({ name, subdir, srcDir, barrelFiles, exports }): WorkspacePackage => ({
				name,
				path: `${root}/${subdir}`,
				packageJsonPath: `${root}/${subdir}/package.json`,
				srcDir,
				barrelFiles,
				exports,
			})
		),
	};
}

// ─── isRelativeImport ──────────────────────────────────────────────────────

describe("isRelativeImport", () => {
	test("returns true for ./ imports", () => {
		expect(isRelativeImport("./foo")).toBe(true);
	});

	test("returns true for ../ imports", () => {
		expect(isRelativeImport("../foo")).toBe(true);
	});

	test("returns false for bare package imports", () => {
		expect(isRelativeImport("react")).toBe(false);
		expect(isRelativeImport("@scope/pkg")).toBe(false);
	});

	test("returns false for path alias imports", () => {
		expect(isRelativeImport("@/components/Foo")).toBe(false);
	});
});

// ─── isBareImport ──────────────────────────────────────────────────────────

describe("isBareImport", () => {
	test("returns true for bare package names", () => {
		expect(isBareImport("react")).toBe(true);
		expect(isBareImport("lodash")).toBe(true);
	});

	test("returns true for scoped packages", () => {
		expect(isBareImport("@scope/package")).toBe(true);
	});

	test("returns false for relative imports", () => {
		expect(isBareImport("./foo")).toBe(false);
		expect(isBareImport("../bar")).toBe(false);
	});

	test("returns false for absolute paths", () => {
		expect(isBareImport("/absolute/path")).toBe(false);
	});
});

// ─── normalizePath ─────────────────────────────────────────────────────────

describe("normalizePath", () => {
	test("normalizes double slashes", () => {
		expect(normalizePath("/foo//bar")).toBe("/foo/bar");
	});

	test("normalizes . and .. segments", () => {
		expect(normalizePath("/foo/./bar")).toBe("/foo/bar");
		expect(normalizePath("/foo/baz/../bar")).toBe("/foo/bar");
	});

	test("handles already-clean paths", () => {
		expect(normalizePath("/foo/bar/baz.ts")).toBe("/foo/bar/baz.ts");
	});
});

// ─── calculateRelativeSpecifier ────────────────────────────────────────────

describe("calculateRelativeSpecifier", () => {
	test("uses ./ prefix for same-directory files", () => {
		const result = calculateRelativeSpecifier(
			"/project/src/a.ts",
			"/project/src/b.ts"
		);
		expect(result).toBe("./b");
	});

	test("uses ../ for parent directory files", () => {
		const result = calculateRelativeSpecifier(
			"/project/src/components/Button.ts",
			"/project/src/utils.ts"
		);
		expect(result).toBe("../utils");
	});

	test("uses deep ../ chains for distant ancestors", () => {
		const result = calculateRelativeSpecifier(
			"/project/src/a/b/c.ts",
			"/project/src/d.ts"
		);
		expect(result).toBe("../../d");
	});

	test("strips .ts extension from result", () => {
		const result = calculateRelativeSpecifier(
			"/project/src/a.ts",
			"/project/src/b.ts"
		);
		expect(result).not.toContain(".ts");
	});

	test("collapses index.ts to bare directory path", () => {
		const result = calculateRelativeSpecifier(
			"/project/src/a.ts",
			"/project/src/utils/index.ts"
		);
		expect(result).toBe("./utils");
	});

	test("returns . for same directory index.ts → index.ts", () => {
		const result = calculateRelativeSpecifier(
			"/project/src/utils/consumer.ts",
			"/project/src/utils/index.ts"
		);
		expect(result).toBe(".");
	});

	test("preserves .ts extension when old specifier had .ts", () => {
		const result = calculateRelativeSpecifier(
			"/project/src/a.ts",
			"/project/src/b.ts",
			"./old.ts"
		);
		expect(result).toBe("./b.ts");
	});

	test("strips extension when old specifier had no extension", () => {
		const result = calculateRelativeSpecifier(
			"/project/src/a.ts",
			"/project/src/b.ts",
			"./old"
		);
		expect(result).toBe("./b");
	});

	test("strips extension when no old specifier provided", () => {
		const result = calculateRelativeSpecifier(
			"/project/src/a.ts",
			"/project/src/b.ts"
		);
		expect(result).toBe("./b");
	});

	test("preserves .tsx extension when old specifier had .tsx", () => {
		const result = calculateRelativeSpecifier(
			"/project/src/a.tsx",
			"/project/src/b.tsx",
			"../components/old.tsx"
		);
		expect(result).toBe("./b.tsx");
	});

	test("relative-target inputs are resolved against cwd, not stitched into the from-dir (regression #67)", () => {
		// The reporter saw `move` produce `../src/core/cookies/cookieSpecsFromUrl`
		// when the correct answer was `../cookieSpecsFromUrl`. That output is
		// what you get if a relative target ("src/core/cookies/foo") is treated
		// as cwd-relative AND the from-dir happens to be a sibling of `src` —
		// the relative result then carries the `src/...` prefix back into the
		// new file. The guard absolutises both inputs first, so the result
		// always starts with a relative-style prefix and never contains a
		// stray `src/...` repetition from the from-dir basis.
		const result = calculateRelativeSpecifier(
			"/abs/proj/src/core/cookies/__tests__/foo.test.ts",
			"src/core/cookies/foo.ts"
		);
		// Whatever cwd is at test time, the specifier should be a valid
		// relative path that does NOT contain the literal "src/core/cookies"
		// segment as a re-rooted path under the from-dir. (Before the fix, a
		// mis-anchored compute could produce `../src/core/cookies/foo` — the
		// exact symptom from issue #67.)
		expect(result.startsWith(".")).toBe(true);
		expect(result).not.toBe("../src/core/cookies/foo");
	});
});

// ─── extension policy (#175) ───────────────────────────────────────────────

describe("calculateRelativeSpecifier extension policy", () => {
	const FROM = "/project/src/app/page.ts";
	const TARGET = "/project/src/lib/locale.ts";

	describe("preserve reproduces the pre-#175 rule byte-for-byte", () => {
		// Each case pairs the explicit "preserve" argument with the omitted
		// argument. If the default ever stops meaning preserve, these diverge.
		const cases: Array<{ name: string; oldSpecifier?: string }> = [
			{ name: "extensionless old specifier", oldSpecifier: "@/lib/locale" },
			{ name: "extension-carrying old specifier", oldSpecifier: "./locale.ts" },
			{ name: "no old specifier", oldSpecifier: undefined },
		];

		for (const { name, oldSpecifier } of cases) {
			test(name, () => {
				const explicitDefault = calculateRelativeSpecifier(
					FROM,
					TARGET,
					oldSpecifier,
					"preserve"
				);
				const omitted = calculateRelativeSpecifier(FROM, TARGET, oldSpecifier);
				expect(explicitDefault).toBe(omitted);
			});
		}

		test("still strips the extension for an extensionless source specifier", () => {
			expect(
				calculateRelativeSpecifier(FROM, TARGET, "@/lib/locale", "preserve")
			).toBe("../lib/locale");
		});

		test("still keeps the extension for an extension-carrying source specifier", () => {
			expect(
				calculateRelativeSpecifier(FROM, TARGET, "./locale.ts", "preserve")
			).toBe("../lib/locale.ts");
		});
	});

	describe("explicit emits the target's real extension", () => {
		test("adds the extension an extensionless source specifier lacked", () => {
			// The #175 repro: `@/lib/locale` -> `../lib/locale` is unresolvable
			// under `node --experimental-strip-types`, which needs the `.ts`.
			expect(
				calculateRelativeSpecifier(FROM, TARGET, "@/lib/locale", "explicit")
			).toBe("../lib/locale.ts");
		});

		test("leaves an already-explicit specifier unchanged", () => {
			expect(
				calculateRelativeSpecifier(FROM, TARGET, "./locale.ts", "explicit")
			).toBe("../lib/locale.ts");
		});

		test("applies with no old specifier to compare against", () => {
			expect(
				calculateRelativeSpecifier(FROM, TARGET, undefined, "explicit")
			).toBe("../lib/locale.ts");
		});

		test("emits the target's own extension, not the source specifier's", () => {
			expect(
				calculateRelativeSpecifier(
					FROM,
					"/project/src/lib/Button.tsx",
					"./old.ts",
					"explicit"
				)
			).toBe("../lib/Button.tsx");
		});

		test("keeps index.ts addressable instead of collapsing it to the directory", () => {
			// `preserve` collapses to `../lib`, which the strip-types loader cannot
			// resolve — directory resolution is exactly what it does not do.
			expect(
				calculateRelativeSpecifier(
					FROM,
					"/project/src/lib/index.ts",
					"@/lib",
					"preserve"
				)
			).toBe("../lib");
			expect(
				calculateRelativeSpecifier(
					FROM,
					"/project/src/lib/index.ts",
					"@/lib",
					"explicit"
				)
			).toBe("../lib/index.ts");
		});
	});
});

describe("calculateNewSpecifier prefer x extensions matrix (#175)", () => {
	// `@/*` maps onto src/*, so an aliased import can stay aliased or become
	// relative depending on `prefer` — the two axes have to compose.
	const project = makeProject("/project", { "@/*": ["/project/src/*"] });
	const FROM = "/project/src/app/page.ts";
	const OLD_TARGET = "/project/src/lib/locale.ts";
	const NEW_TARGET = "/project/src/i18n/locale.ts";

	function specifier(
		oldSpecifier: string,
		prefer: PreferStrategy | undefined,
		extensions: ExtensionPolicy | undefined
	): string {
		return calculateNewSpecifier(
			oldSpecifier,
			FROM,
			OLD_TARGET,
			NEW_TARGET,
			project,
			prefer,
			extensions
		);
	}

	// Every combination is defined, so a future change cannot leave a hole.
	// `alias` rows are identical across the extension axis by design: an alias
	// is resolved by tsconfig paths, not by Node's ESM loader, so an extension
	// on it would be meaningless. See the decision recorded on issue #175.
	const MATRIX: Array<{
		prefer: PreferStrategy | undefined;
		oldSpecifier: string;
		preserve: string;
		explicit: string;
	}> = [
		{
			prefer: "relative",
			oldSpecifier: "@/lib/locale",
			preserve: "../i18n/locale",
			explicit: "../i18n/locale.ts",
		},
		{
			prefer: "relative",
			oldSpecifier: "../lib/locale.ts",
			preserve: "../i18n/locale.ts",
			explicit: "../i18n/locale.ts",
		},
		{
			prefer: "alias",
			oldSpecifier: "@/lib/locale",
			preserve: "@/i18n/locale",
			explicit: "@/i18n/locale",
		},
		{
			prefer: "shortest",
			oldSpecifier: "@/lib/locale",
			preserve: "@/i18n/locale",
			explicit: "@/i18n/locale",
		},
		{
			prefer: undefined,
			oldSpecifier: "@/lib/locale",
			preserve: "@/i18n/locale",
			explicit: "@/i18n/locale",
		},
		{
			prefer: undefined,
			oldSpecifier: "../lib/locale",
			preserve: "../i18n/locale",
			explicit: "../i18n/locale.ts",
		},
	];

	for (const row of MATRIX) {
		const label = `prefer=${row.prefer ?? "omitted"} old=${row.oldSpecifier}`;

		test(`${label} -> preserve`, () => {
			expect(specifier(row.oldSpecifier, row.prefer, "preserve")).toBe(
				row.preserve
			);
		});

		test(`${label} -> explicit`, () => {
			expect(specifier(row.oldSpecifier, row.prefer, "explicit")).toBe(
				row.explicit
			);
		});

		test(`${label} -> omitted matches preserve`, () => {
			expect(specifier(row.oldSpecifier, row.prefer, undefined)).toBe(
				row.preserve
			);
		});
	}
});

// ─── matchPathAlias ────────────────────────────────────────────────────────

describe("matchPathAlias", () => {
	test("matches a wildcard alias", () => {
		const project = makeProject("/project", {
			"@/*": ["src/*"],
		});
		const result = matchPathAlias("@/components/Button", project);
		expect(result).not.toBeNull();
		expect(result?.alias).toBe("@/*");
		expect(result?.remainder).toBe("components/Button");
	});

	test("matches an exact alias", () => {
		const project = makeProject("/project", {
			"@utils": ["src/utils/index"],
		});
		const result = matchPathAlias("@utils", project);
		expect(result).not.toBeNull();
		expect(result?.alias).toBe("@utils");
		expect(result?.remainder).toBe("");
	});

	test("returns null when no alias matches", () => {
		const project = makeProject("/project", {
			"@/*": ["src/*"],
		});
		const result = matchPathAlias("./relative/path", project);
		expect(result).toBeNull();
	});

	test("returns null for bare package imports", () => {
		const project = makeProject("/project", {
			"@/*": ["src/*"],
		});
		expect(matchPathAlias("react", project)).toBeNull();
	});

	test("returns null when there are no aliases", () => {
		const project = makeProject("/project");
		expect(matchPathAlias("@/foo", project)).toBeNull();
	});
});

// ─── findAliasForPath ──────────────────────────────────────────────────────

describe("findAliasForPath", () => {
	test("finds wildcard alias for a file inside src/", () => {
		const project = makeProject("/project", {
			"@/*": ["src/*"],
		});
		const result = findAliasForPath("/project/src/utils/helpers.ts", project);
		expect(result).toBe("@/utils/helpers");
	});

	test("returns null when no alias covers the path", () => {
		const project = makeProject("/project", {
			"@/*": ["src/*"],
		});
		const result = findAliasForPath("/other-project/src/foo.ts", project);
		expect(result).toBeNull();
	});

	test("returns null when there are no aliases", () => {
		const project = makeProject("/project");
		expect(findAliasForPath("/project/src/foo.ts", project)).toBeNull();
	});

	test("strips file extension from result", () => {
		const project = makeProject("/project", {
			"@/*": ["src/*"],
		});
		const result = findAliasForPath("/project/src/foo.ts", project);
		expect(result).toBe("@/foo");
		expect(result).not.toContain(".ts");
	});
});

// ─── findPackageForPath ────────────────────────────────────────────────────

describe("findPackageForPath", () => {
	test("returns package info when file is inside a known package", () => {
		const workspace = makeWorkspace("/repo", [
			{ name: "@scope/pkg", subdir: "packages/pkg" },
		]);
		const result = findPackageForPath(
			"/repo/packages/pkg/src/foo.ts",
			workspace
		);
		expect(result).not.toBeNull();
		expect(result?.packageName).toBe("@scope/pkg");
		expect(result?.packagePath).toBe("/repo/packages/pkg");
	});

	test("returns null when file is not inside any package", () => {
		const workspace = makeWorkspace("/repo", [
			{ name: "@scope/pkg", subdir: "packages/pkg" },
		]);
		const result = findPackageForPath("/other/path/foo.ts", workspace);
		expect(result).toBeNull();
	});

	test("returns null for empty workspace", () => {
		const workspace = makeWorkspace("/repo", []);
		expect(
			findPackageForPath("/repo/packages/pkg/foo.ts", workspace)
		).toBeNull();
	});

	test("returns the most specific (longest path) matching package", () => {
		// When a file is in a nested package, the deepest match should win
		const workspace = makeWorkspace("/repo", [
			{ name: "@scope/outer", subdir: "packages" },
			{ name: "@scope/inner", subdir: "packages/inner" },
		]);
		const result = findPackageForPath(
			"/repo/packages/inner/src/foo.ts",
			workspace
		);
		// findPackageForPath uses startsWith, so both match; first match wins
		expect(result?.packageName).toBe("@scope/outer");
	});
});

// ─── isCrossPackageMove ────────────────────────────────────────────────────

describe("isCrossPackageMove", () => {
	test("returns true when source and target are in different packages", () => {
		const workspace = makeWorkspace("/repo", [
			{ name: "@scope/a", subdir: "packages/a" },
			{ name: "@scope/b", subdir: "packages/b" },
		]);
		const result = isCrossPackageMove(
			"/repo/packages/a/src/foo.ts",
			"/repo/packages/b/src/foo.ts",
			workspace
		);
		expect(result).toBe(true);
	});

	test("returns false when source and target are in the same package", () => {
		const workspace = makeWorkspace("/repo", [
			{ name: "@scope/a", subdir: "packages/a" },
		]);
		const result = isCrossPackageMove(
			"/repo/packages/a/src/foo.ts",
			"/repo/packages/a/src/bar.ts",
			workspace
		);
		expect(result).toBe(false);
	});

	test("returns false when source is not in any package", () => {
		const workspace = makeWorkspace("/repo", [
			{ name: "@scope/a", subdir: "packages/a" },
		]);
		const result = isCrossPackageMove(
			"/other/foo.ts",
			"/repo/packages/a/src/bar.ts",
			workspace
		);
		expect(result).toBe(false);
	});

	test("returns false when target is not in any package", () => {
		const workspace = makeWorkspace("/repo", [
			{ name: "@scope/a", subdir: "packages/a" },
		]);
		const result = isCrossPackageMove(
			"/repo/packages/a/src/foo.ts",
			"/other/bar.ts",
			workspace
		);
		expect(result).toBe(false);
	});
});

// ─── findCrossPackageImport ────────────────────────────────────────────────

describe("findCrossPackageImport", () => {
	test("returns package name when file is in src/ and addingToBarrel is true", () => {
		const workspace = makeWorkspace("/repo", [
			{
				name: "@scope/pkg",
				subdir: "packages/pkg",
				srcDir: "src",
				barrelFiles: ["/repo/packages/pkg/src/index.ts"],
			},
		]);
		const result = findCrossPackageImport(
			"/repo/packages/pkg/src/foo.ts",
			workspace,
			true
		);
		expect(result).toBe("@scope/pkg");
	});

	test("returns package name even when addingToBarrel defaults to true", () => {
		const workspace = makeWorkspace("/repo", [
			{
				name: "@scope/pkg",
				subdir: "packages/pkg",
				srcDir: "src",
				barrelFiles: ["/repo/packages/pkg/src/index.ts"],
			},
		]);
		// default parameter is true
		const result = findCrossPackageImport(
			"/repo/packages/pkg/src/utils.ts",
			workspace
		);
		expect(result).toBe("@scope/pkg");
	});

	test("returns null when target is not in any workspace package", () => {
		const workspace = makeWorkspace("/repo", [
			{ name: "@scope/pkg", subdir: "packages/pkg" },
		]);
		const result = findCrossPackageImport("/other/foo.ts", workspace);
		expect(result).toBeNull();
	});

	test("returns subpath when package has no barrel file", () => {
		const workspace = makeWorkspace("/repo", [
			{ name: "@scope/pkg", subdir: "packages/pkg", srcDir: "src" },
		]);
		const result = findCrossPackageImport(
			"/repo/packages/pkg/src/foo.ts",
			workspace,
			true
		);
		expect(result).toBe("@scope/pkg/src/foo");
	});

	test("returns subpath when barrelFiles is empty", () => {
		const workspace = makeWorkspace("/repo", [
			{
				name: "@scope/pkg",
				subdir: "packages/pkg",
				srcDir: "src",
				barrelFiles: [],
			},
		]);
		const result = findCrossPackageImport(
			"/repo/packages/pkg/src/utils.ts",
			workspace
		);
		expect(result).toBe("@scope/pkg/src/utils");
	});

	test("prefers a dedicated sub-path export over the root barrel (#93)", () => {
		const workspace = makeWorkspace("/repo", [
			{
				name: "@scope/utils",
				subdir: "packages/utils",
				srcDir: "src",
				barrelFiles: ["/repo/packages/utils/src/index.ts"],
				exports: {
					".": {
						types: "./dist/index.d.ts",
						import: "./dist/index.mjs",
						require: "./dist/index.js",
					},
					"./cn": {
						types: "./dist/cn.d.ts",
						import: "./dist/cn.mjs",
						require: "./dist/cn.js",
					},
				},
			},
		]);
		const result = findCrossPackageImport(
			"/repo/packages/utils/src/cn.ts",
			workspace,
			true
		);
		expect(result).toBe("@scope/utils/cn");
	});

	test("falls back to the root barrel when no dedicated export matches", () => {
		const workspace = makeWorkspace("/repo", [
			{
				name: "@scope/utils",
				subdir: "packages/utils",
				srcDir: "src",
				barrelFiles: ["/repo/packages/utils/src/index.ts"],
				exports: {
					".": { import: "./dist/index.mjs" },
					"./cn": { import: "./dist/cn.mjs" },
				},
			},
		]);
		const result = findCrossPackageImport(
			"/repo/packages/utils/src/other.ts",
			workspace,
			true
		);
		expect(result).toBe("@scope/utils");
	});

	test("does not let the root '.' export pre-empt the barrel for nested files", () => {
		const workspace = makeWorkspace("/repo", [
			{
				name: "@scope/utils",
				subdir: "packages/utils",
				srcDir: "src",
				barrelFiles: ["/repo/packages/utils/src/index.ts"],
				exports: { ".": { import: "./dist/index.mjs" } },
			},
		]);
		const result = findCrossPackageImport(
			"/repo/packages/utils/src/nested/foo.ts",
			workspace,
			true
		);
		expect(result).toBe("@scope/utils");
	});

	// ─── wildcard exports key matching (#130) ───────────────────────────────
	test("escapes regex metacharacters in a wildcard exports key (./*.js)", () => {
		const workspace = makeWorkspace("/repo", [
			{
				name: "@scope/pkg",
				subdir: "packages/pkg",
				srcDir: "src",
				exports: { "./*.js": "./dist/*.js" },
			},
		]);
		// removeExtension only strips the trailing .ts, leaving the literal ".js"
		// in the subpath — this is what the "./*.js" key is matched against.
		const matching = findCrossPackageImport(
			"/repo/packages/pkg/src/foo.js.ts",
			workspace,
			false
		);
		expect(matching).toBe("@scope/pkg/foo.js");

		// Before the fix, the unescaped "." in the pattern matched any
		// character, so "fooXjs" (literal X instead of a literal dot) would
		// incorrectly match too. It must not match now.
		const nonMatching = findCrossPackageImport(
			"/repo/packages/pkg/src/fooXjs.ts",
			workspace,
			false
		);
		expect(nonMatching).toBe("@scope/pkg/src/fooXjs");
	});

	test("escapes regex metacharacters in a bracketed wildcard exports key (./[locale]/*)", () => {
		const workspace = makeWorkspace("/repo", [
			{
				name: "@scope/pkg",
				subdir: "packages/pkg",
				srcDir: "src",
				exports: { "./[locale]/*": "./dist/[locale]/*.js" },
			},
		]);
		// The brackets are literal characters in the key, not a character
		// class — constructing the RegExp must not throw, and the literal
		// "[locale]" segment must match exactly.
		expect(() =>
			findCrossPackageImport(
				"/repo/packages/pkg/src/[locale]/greeting.ts",
				workspace,
				false
			)
		).not.toThrow();
		const result = findCrossPackageImport(
			"/repo/packages/pkg/src/[locale]/greeting.ts",
			workspace,
			false
		);
		expect(result).toBe("@scope/pkg/[locale]/greeting");
	});

	test("rejects a multi-star exports key instead of matching wrong (#130)", () => {
		const workspace = makeWorkspace("/repo", [
			{
				name: "@scope/pkg",
				subdir: "packages/pkg",
				srcDir: "src",
				exports: { "./*/*": "./dist/*/*.js" },
			},
		]);
		// Node's exports semantics allow at most one "*" per key; a multi-star
		// key is invalid and must be skipped, not silently mismatched via a
		// pattern that still has a literal "*" in it.
		const result = findCrossPackageImport(
			"/repo/packages/pkg/src/locales/en.ts",
			workspace,
			false
		);
		expect(result).toBe("@scope/pkg/src/locales/en");
	});
});

// ─── findSubpathExportForFile ───────────────────────────────────────────────

describe("findSubpathExportForFile", () => {
	test("returns the dedicated sub-path export match (#93)", () => {
		const workspace = makeWorkspace("/repo", [
			{
				name: "@scope/utils",
				subdir: "packages/utils",
				srcDir: "src",
				barrelFiles: ["/repo/packages/utils/src/index.ts"],
				exports: {
					".": { import: "./dist/index.mjs" },
					"./cn": { import: "./dist/cn.mjs" },
				},
			},
		]);
		const result = findSubpathExportForFile(
			"/repo/packages/utils/src/cn.ts",
			workspace
		);
		expect(result).toEqual({
			packageName: "@scope/utils",
			exportKey: "cn",
			specifier: "@scope/utils/cn",
		});
	});

	test("returns null when the file has no dedicated sub-path export", () => {
		const workspace = makeWorkspace("/repo", [
			{
				name: "@scope/utils",
				subdir: "packages/utils",
				srcDir: "src",
				exports: { ".": { import: "./dist/index.mjs" } },
			},
		]);
		const result = findSubpathExportForFile(
			"/repo/packages/utils/src/cn.ts",
			workspace
		);
		expect(result).toBeNull();
	});

	test("returns null when no workspace package owns the file", () => {
		const workspace = makeWorkspace("/repo", [
			{ name: "@scope/utils", subdir: "packages/utils" },
		]);
		const result = findSubpathExportForFile("/other/cn.ts", workspace);
		expect(result).toBeNull();
	});
});

// ─── calculateNewSpecifier — intra-package self-import (#121) ─────────────────

describe("calculateNewSpecifier intra-package self-import (#121)", () => {
	// `@scope/web-analytics` aliases the package `src` dir, so the bare
	// specifier resolves to the barrel `src/index.ts`.
	const project = makeProject("/repo", {
		"@scope/web-analytics": ["packages/web-analytics/src"],
	});
	const barrel = "/repo/packages/web-analytics/src/index.ts";

	test("rewrites a self-import of the package barrel to a relative path", () => {
		// File moved INTO the package; the barrel did not move.
		const fromFile = "/repo/packages/web-analytics/src/base-provider.ts";
		const result = calculateNewSpecifier(
			"@scope/web-analytics",
			fromFile,
			barrel,
			barrel,
			project
		);
		expect(result).not.toContain("@scope/web-analytics/index");
		expect(result).toBe(".");
	});

	test("leaves an outside importer's bare barrel specifier untouched (#122)", () => {
		// An importer outside the alias root keeps the bare package specifier —
		// never `<alias>/index`, which is an unexported subpath (TS2307).
		const fromFile = "/repo/apps/web/consumer.ts";
		const result = calculateNewSpecifier(
			"@scope/web-analytics",
			fromFile,
			barrel,
			barrel,
			project
		);
		expect(result.startsWith(".")).toBe(false);
		expect(result).not.toContain("/index");
		expect(result).toBe("@scope/web-analytics");
	});
});

describe("calculateNewSpecifier alias slash/extension normalization (#160)", () => {
	test("wildcard alias: moving a sibling file never produces a double slash", () => {
		// "@/*" -> "@/" once the trailing "*" is stripped; the remainder used to
		// keep its leading slash, producing "@//components/visually-hidden".
		const project = makeProject("/repo", { "@/*": ["src/*"] });
		const oldTarget = "/repo/src/components/VisuallyHidden.tsx";
		const newTarget = "/repo/src/components/visually-hidden.tsx";
		const fromFile = "/repo/src/components/video-dialog.tsx";

		const result = calculateNewSpecifier(
			"@/components/VisuallyHidden",
			fromFile,
			oldTarget,
			newTarget,
			project
		);

		expect(result).not.toContain("//");
		expect(result).toBe("@/components/visually-hidden");
	});

	test("non-wildcard package alias: moving a sibling file never produces a double slash", () => {
		const project = makeProject("/repo", {
			"@my-org/shared-utils/*": ["packages/shared-utils/src/*"],
		});
		const oldTarget = "/repo/packages/shared-utils/src/error.ts";
		const newTarget = "/repo/packages/shared-utils/src/errors/error.ts";
		const fromFile = "/repo/packages/shared-utils/src/index.ts";

		const result = calculateNewSpecifier(
			"@my-org/shared-utils/error",
			fromFile,
			oldTarget,
			newTarget,
			project
		);

		expect(result).not.toContain("//");
		expect(result).toBe("@my-org/shared-utils/errors/error");
	});

	test("rewritten specifier never retains a dangling .d from a .d.ts target", () => {
		// A declaration file target (e.g. resolved across a workspace package
		// boundary) must not leave `.d` on the specifier after extension removal.
		const project = makeProject("/repo", {
			"@my-org/shared-schemas/*": ["packages/shared-schemas/dist/*"],
		});
		const oldTarget = "/repo/packages/shared-schemas/dist/audit-log.d.ts";
		const newTarget = "/repo/packages/shared-schemas/dist/types/audit-log.d.ts";
		const fromFile = "/repo/packages/shared-schemas/dist/index.d.ts";

		const result = calculateNewSpecifier(
			"@my-org/shared-schemas/audit-log",
			fromFile,
			oldTarget,
			newTarget,
			project
		);

		expect(result).not.toContain("//");
		expect(result.endsWith(".d")).toBe(false);
		expect(result.endsWith("/index.d")).toBe(false);
		expect(result).toBe("@my-org/shared-schemas/types/audit-log");
	});
});

// ─── calculateNewSpecifier specifier-style preservation (#173) ─────────────

describe("calculateNewSpecifier specifier style (#173)", () => {
	// Mirrors the issue repro: a project with a tsconfig `paths` alias, where a
	// relative import rewritten to an alias breaks `node --experimental-strip-types`
	// (which does not resolve tsconfig paths).
	const project = makeProject("/repo", { "@/*": ["src/*"] });
	const oldTarget = "/repo/src/lib/locale.ts";
	const newTarget = "/repo/src/lib/i18n/locale.ts";
	const sibling = "/repo/src/lib/i18n/config.ts";
	const distant = "/repo/src/app/page.ts";

	test("keeps a relative specifier relative even when an alias covers the target", () => {
		// Regression: this used to return "@/lib/i18n/locale" because a relative
		// import fell through to findAliasForPath().
		const result = calculateNewSpecifier(
			"../locale",
			sibling,
			oldTarget,
			newTarget,
			project
		);

		expect(isRelativeImport(result)).toBe(true);
		expect(result).toBe("./locale");
	});

	test("keeps an aliased specifier aliased", () => {
		const result = calculateNewSpecifier(
			"@/lib/locale",
			distant,
			oldTarget,
			newTarget,
			project
		);

		expect(result).toBe("@/lib/i18n/locale");
	});

	test("prefer 'relative' rewrites an aliased specifier to a relative path", () => {
		const result = calculateNewSpecifier(
			"@/lib/locale",
			distant,
			oldTarget,
			newTarget,
			project,
			"relative"
		);

		expect(isRelativeImport(result)).toBe(true);
		expect(result).toBe("../lib/i18n/locale");
	});

	test("prefer 'alias' rewrites a relative specifier to an alias", () => {
		const result = calculateNewSpecifier(
			"../locale",
			sibling,
			oldTarget,
			newTarget,
			project,
			"alias"
		);

		expect(result).toBe("@/lib/i18n/locale");
	});

	test("prefer 'shortest' picks the relative form for a near importer", () => {
		const result = calculateNewSpecifier(
			"../locale",
			sibling,
			oldTarget,
			newTarget,
			project,
			"shortest"
		);

		// "./locale" is shorter than "@/lib/i18n/locale"
		expect(result).toBe("./locale");
	});

	test("prefer 'shortest' picks the alias form for a deeply nested importer", () => {
		const deep = "/repo/src/features/a/b/c/deep.ts";

		const result = calculateNewSpecifier(
			"../../../../locale",
			deep,
			oldTarget,
			newTarget,
			project,
			"shortest"
		);

		// "@/lib/i18n/locale" is shorter than "../../../../lib/i18n/locale"
		expect(result).toBe("@/lib/i18n/locale");
	});
});

// ─── Stylesheet asset resolution (#188) ────────────────────────────────────

describe("resolveModuleSpecifier — stylesheet assets", () => {
	let dir: string;

	beforeAll(async () => {
		dir = await makeFixture("resolver-stylesheet-assets", {
			"tsconfig.json": JSON.stringify({
				compilerOptions: {
					strict: true,
					baseUrl: ".",
					paths: { "@/*": ["./*"] },
				},
				include: ["app/**/*.tsx"],
			}),
			"app/globals.css": "body { color: red; }",
			"app/styles.module.css": ".title { font-weight: 700; }",
			"app/theme.scss": "$brand: red;",
			"app/layout.tsx": 'import "./globals.css";\n',
		});
	});

	afterAll(async () => {
		await cleanup(dir);
	});

	function resolveFrom(specifier: string): ResolveResult {
		return resolveModuleSpecifier(
			specifier,
			path.join(dir, "app/layout.tsx"),
			makeProject(dir, { "@/*": ["./*"] })
		);
	}

	test("an existing relative stylesheet resolves as an asset, not unresolvable", () => {
		const result = resolveFrom("./globals.css");

		expect(result.kind).toBe("asset");
		expect(result).toMatchObject({
			kind: "asset",
			path: path.join(dir, "app/globals.css"),
			specifier: "./globals.css",
		});
	});

	test("an existing CSS Module resolves as an asset rather than a graph node", () => {
		const result = resolveFrom("./styles.module.css");

		expect(result.kind).toBe("asset");
		// `resolved` is what creates a TypeScript dependency-graph node, so the
		// asset kind is exactly what keeps CSS Modules out of the graph.
		expect(result.kind).not.toBe("resolved");
	});

	test("non-CSS stylesheet dialects are covered", () => {
		expect(resolveFrom("./theme.scss").kind).toBe("asset");
	});

	test("an alias-style stylesheet import resolves as an asset", () => {
		const result = resolveFrom("@/app/globals.css");

		expect(result).toMatchObject({
			kind: "asset",
			path: path.join(dir, "app/globals.css"),
		});
	});

	test("a missing relative stylesheet is still reported as unresolvable", () => {
		const result = resolveFrom("./missing.css");

		expect(result.kind).toBe("unresolvable");
		expect(result).toMatchObject({
			diagnostic: expect.stringContaining('Cannot resolve "./missing.css"'),
		});
	});

	test("a bare package stylesheet stays external rather than missing", () => {
		const result = resolveFrom("bootstrap/dist/css/bootstrap.css");

		expect(result).toEqual({
			kind: "external",
			specifier: "bootstrap/dist/css/bootstrap.css",
		});
	});
});
