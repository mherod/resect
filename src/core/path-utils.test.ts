import { describe, expect, test } from "bun:test";
import path from "node:path";
import { isWithinPath, toRelativePath } from "./path-utils.ts";

/**
 * `isWithinPath` is the single path-containment predicate (#204). Before that
 * consolidation there were three: this one, plus private copies in
 * `package-entrypoints.ts` and `audit.ts` — with three different argument
 * orders and three different levels of correctness. The two behaviours proven
 * here came from the copies; this exported one had neither.
 */
describe("isWithinPath", () => {
	const base = path.resolve("/project/src");

	test("a directory contains itself", () => {
		expect(isWithinPath(base, base)).toBe(true);
	});

	test("a nested descendant is inside", () => {
		expect(isWithinPath(base, path.join(base, "core", "graph.ts"))).toBe(true);
	});

	test("a direct child is inside", () => {
		expect(isWithinPath(base, path.join(base, "cli.ts"))).toBe(true);
	});

	test("the parent directory is not inside", () => {
		expect(isWithinPath(base, path.resolve("/project"))).toBe(false);
	});

	test("a sibling directory is not inside", () => {
		expect(isWithinPath(base, path.resolve("/project/dist/index.js"))).toBe(
			false
		);
	});

	test("a sibling whose name starts with two dots is not inside", () => {
		// `path.relative` yields "../..cache/x.ts" here. A `startsWith("..")`
		// guard sees the leading dots and correctly rejects it, but the same
		// guard wrongly rejects a *descendant* named `..cache` — see below.
		expect(isWithinPath(base, path.resolve("/project/..cache/x.ts"))).toBe(
			false
		);
	});

	test("a descendant whose first segment starts with two dots is inside", () => {
		// `path.relative` yields "..cache/x.ts" — no separator after the dots, so
		// this is a real child. `relative.startsWith("..")` misclassifies it as an
		// escape; only a separator-aware check gets this right.
		expect(isWithinPath(base, path.join(base, "..cache", "x.ts"))).toBe(true);
	});

	test("mixed relative and absolute inputs resolve against cwd", () => {
		// The copy in package-entrypoints.ts resolved both inputs; this exported
		// one compared them raw, so a relative file path against an absolute base
		// produced a wrong answer. Same class of bug as #67.
		const cwd = process.cwd();
		expect(isWithinPath(cwd, "src/core/path-utils.ts")).toBe(true);
		expect(isWithinPath("src", path.join(cwd, "src", "cli.ts"))).toBe(true);
	});

	test("an unrelated absolute path is not inside", () => {
		expect(isWithinPath(base, path.resolve("/elsewhere/file.ts"))).toBe(false);
	});
});

describe("toRelativePath", () => {
	test("returns . for the base directory itself", () => {
		expect(toRelativePath("/project", "/project")).toBe(".");
	});

	test("returns a relative path for a descendant", () => {
		expect(toRelativePath("/project", "/project/src/cli.ts")).toBe(
			path.join("src", "cli.ts")
		);
	});
});
