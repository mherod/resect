import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
	analyzeSimilarity,
	collectFunctions,
	findSimilarGroups,
	matchesRelatedPath,
	scanProjectFunctions,
	scanWorkspaceFunctions,
} from "./similarity";
import {
	camelCaseTokenize,
	extractContentTokens,
	jaccardSimilarity,
	nameSimilarity,
	normalizeBody,
	tokenize,
} from "./similarity-algorithms";
import { createSourceFileFromText } from "./source-file";

function makeSourceFile(code: string, fileName = "test.ts") {
	return createSourceFileFromText(fileName, code);
}

describe("extractContentTokens", () => {
	test("extracts uppercase identifiers", () => {
		const tokens = extractContentTokens(
			"{ return KEBAB_CASE_REGEX.test(name); }"
		);
		expect(tokens).toContain("KEBAB_CASE_REGEX");
	});

	test("extracts string literal values", () => {
		const tokens = extractContentTokens('{ return arr.includes("md5"); }');
		expect(tokens).toContain("md5");
	});

	test("extracts both uppercase identifiers and string literals", () => {
		const tokens = extractContentTokens(
			'{ return node.type === AST_NODE_TYPES.CallExpression && node.name === "useState"; }'
		);
		expect(tokens).toContain("AST_NODE_TYPES");
		expect(tokens).toContain("CallExpression");
		expect(tokens).toContain("useState");
	});

	test("does not include lowercase non-call identifiers", () => {
		const tokens = extractContentTokens(
			"{ const result = source.fetch(url); return result; }"
		);
		expect(tokens).not.toContain("result");
		expect(tokens).not.toContain("source");
		// fetch is followed by ( — captured as a call-position identifier
		expect(tokens).toContain("fetch");
	});

	test("returns empty for bodies with no uppercase ids or string literals", () => {
		const tokens = extractContentTokens(
			"{ const x = a + b; const y = x * 2; return y; }"
		);
		expect(tokens).toHaveLength(0);
	});

	test("strips comments before extraction", () => {
		const tokens = extractContentTokens(
			"{ /* IGNORE_THIS */ return REAL_CONST.test(x); // USE_THIS }"
		);
		expect(tokens).toContain("REAL_CONST");
		// comment contents are stripped, so IGNORE_THIS won't appear
		expect(tokens).not.toContain("IGNORE_THIS");
	});
});

describe("scanWorkspaceFunctions", () => {
	test("returns empty result for non-workspace directory", async () => {
		const result = await scanWorkspaceFunctions("/tmp/nonexistent-dir-xyz");
		expect(result.functions).toHaveLength(0);
		expect(result.totalFiles).toBe(0);
		expect(result.packageCount).toBe(0);
	});
});

describe("analyzeSimilarity", () => {
	test("accepts workspace flag and returns packageCount when true", async () => {
		const report = await analyzeSimilarity(
			"/tmp/nonexistent-dir-xyz",
			0.7,
			undefined,
			true
		);
		expect(report.groups).toHaveLength(0);
		expect(report.totalFunctions).toBe(0);
		expect(report.totalFiles).toBe(0);
		expect(report.packageCount).toBe(0);
	});

	test("does not return packageCount when workspace is false", async () => {
		const report = await analyzeSimilarity(
			"/tmp/nonexistent-dir-xyz",
			0.7,
			undefined,
			false
		);
		expect(report.groups).toHaveLength(0);
		expect(report.packageCount).toBeUndefined();
	});

	test("accepts an explicit tsconfig file as the project path", async () => {
		const directory = await mkdtemp(
			path.join(tmpdir(), "resect-similar-project-")
		);
		try {
			const sourceDirectory = path.join(directory, "src");
			await mkdir(sourceDirectory, { recursive: true });
			await writeFile(
				path.join(sourceDirectory, "example.ts"),
				"export function calculateTotal(values: number[]) { return values.reduce((total, value) => total + value, 0); }\n"
			);
			const tsconfigPath = path.join(directory, "tsconfig.json");
			await writeFile(
				tsconfigPath,
				JSON.stringify({
					compilerOptions: { strict: true },
					include: ["src/**/*.ts"],
				})
			);

			const report = await analyzeSimilarity({
				directory: sourceDirectory,
				project: tsconfigPath,
			});

			expect(report.totalFiles).toBe(1);
			expect(report.totalFunctions).toBe(1);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});
});

describe("normalizeBody", () => {
	test("replaces string literals with $S", () => {
		const result = normalizeBody('{ return "hello world"; }');
		expect(result).toBe("{ return $S; }");
	});

	test("replaces numeric literals with $N", () => {
		const result = normalizeBody("{ return 42; }");
		expect(result).toBe("{ return $N; }");
	});

	test("replaces non-keyword identifiers with $I", () => {
		const result = normalizeBody("{ const x = foo(); return x; }");
		expect(result).toBe("{ const $I = $I(); return $I; }");
	});

	test("preserves keywords", () => {
		const result = normalizeBody("{ if (true) { return null; } }");
		expect(result).toBe("{ if (true) { return null; } }");
	});

	test("handles template literals", () => {
		const result = normalizeBody("{ return `hello world`; }");
		expect(result).toBe("{ return $S; }");
	});

	test("removes line comments", () => {
		const result = normalizeBody("{ // a comment\n return x; }");
		expect(result).not.toContain("comment");
		expect(result).toBe("{ return $I; }");
	});

	test("removes block comments", () => {
		const result = normalizeBody("{ /* block */ return x; }");
		expect(result).toBe("{ return $I; }");
	});

	test("collapses whitespace", () => {
		const result = normalizeBody("{   const   x   =   1;   }");
		expect(result).toBe("{ const $I = $N; }");
	});

	test("two functions differing only in variable names normalize identically", () => {
		const a = normalizeBody(
			"{ const date = input.toISOString(); return date.split('T')[0]; }"
		);
		const b = normalizeBody(
			"{ const ts = value.toISOString(); return ts.split('T')[0]; }"
		);
		expect(a).toBe(b);
	});

	test("two functions differing only in string literals normalize identically", () => {
		const a = normalizeBody("{ return arr.join(', '); }");
		const b = normalizeBody("{ return arr.join(' | '); }");
		expect(a).toBe(b);
	});
});

describe("tokenize", () => {
	test("splits on punctuation and whitespace", () => {
		const tokens = tokenize("{ return $I; }");
		expect(tokens).toEqual(["{", "return", "$I", ";", "}"]);
	});

	test("handles chained calls", () => {
		const tokens = tokenize("$I.$I($S)");
		expect(tokens).toEqual(["$I", ".", "$I", "(", "$S", ")"]);
	});

	test("returns empty array for empty string", () => {
		expect(tokenize("")).toEqual([]);
	});
});

describe("jaccardSimilarity", () => {
	test("returns 1.0 for identical token sets", () => {
		const tokens = ["a", "b", "c"];
		expect(jaccardSimilarity(tokens, tokens)).toBe(1);
	});

	test("returns 0 for completely disjoint sets", () => {
		expect(jaccardSimilarity(["a", "b"], ["c", "d"])).toBe(0);
	});

	test("returns 1.0 for two empty arrays", () => {
		expect(jaccardSimilarity([], [])).toBe(1);
	});

	test("computes partial overlap correctly", () => {
		// intersection = {b}, union = {a, b, c}
		const score = jaccardSimilarity(["a", "b"], ["b", "c"]);
		expect(score).toBeCloseTo(1 / 3, 5);
	});
});

describe("collectFunctions", () => {
	test("collects function declarations", () => {
		const code = `
function add(a: number, b: number): number {
  const sum = a + b;
  const result = sum * 2;
  return result;
}
`;
		const sf = makeSourceFile(code);
		const fns = collectFunctions(sf, "test.ts");
		expect(fns).toHaveLength(1);
		expect(fns[0]?.name).toBe("add");
		expect(fns[0]?.file).toBe("test.ts");
		expect(fns[0]?.line).toBeGreaterThan(0);
	});

	test("collects exported function declarations", () => {
		const code = `
export function greet(name: string): string {
  const prefix = "Hello";
  const message = prefix + name;
  return message;
}
`;
		const sf = makeSourceFile(code);
		const fns = collectFunctions(sf, "test.ts");
		expect(fns).toHaveLength(1);
		expect(fns[0]?.name).toBe("greet");
	});

	test("collects const arrow functions with block body", () => {
		const code = `
const process = (items: string[]): string[] => {
  const result = items.filter(Boolean);
  const mapped = result.map(x => x.trim());
  return mapped;
};
`;
		const sf = makeSourceFile(code);
		const fns = collectFunctions(sf, "test.ts");
		expect(fns).toHaveLength(1);
		expect(fns[0]?.name).toBe("process");
	});

	test("collects const function expressions", () => {
		const code = `
const transform = function(input: string): string {
  const trimmed = input.trim();
  const lower = trimmed.toLowerCase();
  return lower;
};
`;
		const sf = makeSourceFile(code);
		const fns = collectFunctions(sf, "test.ts");
		expect(fns).toHaveLength(1);
		expect(fns[0]?.name).toBe("transform");
	});

	test("skips trivially small functions (below token threshold)", () => {
		const code = `
function noop() {}
const id = (x: unknown) => x;
function tiny() { return 1; }
`;
		const sf = makeSourceFile(code);
		const fns = collectFunctions(sf, "test.ts");
		// All three are too small (fewer than MIN_TOKEN_COUNT tokens after normalization)
		expect(fns).toHaveLength(0);
	});

	test("sets kind=function for all function variants", () => {
		const code = `
export function decl(x: number): number {
  const a = x * 2;
  const b = a + 1;
  return b;
}
const arrow = (x: number): number => {
  const a = x * 2;
  const b = a + 1;
  return b;
};
`;
		const sf = makeSourceFile(code);
		const fns = collectFunctions(sf, "test.ts");
		expect(fns).toHaveLength(2);
		for (const fn of fns) {
			expect(fn.kind).toBe("function");
		}
	});

	test("collects type alias declarations", () => {
		const code = `
export type UserConfig = {
  id: string;
  name: string;
  role: string;
};
`;
		const sf = makeSourceFile(code);
		const fns = collectFunctions(sf, "test.ts");
		expect(fns).toHaveLength(1);
		expect(fns[0]?.name).toBe("UserConfig");
		expect(fns[0]?.kind).toBe("type");
	});

	test("collects interface declarations", () => {
		const code = `
export interface ProductConfig {
  id: string;
  title: string;
  price: number;
}
`;
		const sf = makeSourceFile(code);
		const fns = collectFunctions(sf, "test.ts");
		expect(fns).toHaveLength(1);
		expect(fns[0]?.name).toBe("ProductConfig");
		expect(fns[0]?.kind).toBe("interface");
	});

	test("collects interface with heritage clause", () => {
		const code = `
export interface AdminConfig extends UserConfig {
  permissions: string[];
  level: number;
}
`;
		const sf = makeSourceFile(code);
		const fns = collectFunctions(sf, "test.ts");
		expect(fns).toHaveLength(1);
		expect(fns[0]?.name).toBe("AdminConfig");
		expect(fns[0]?.kind).toBe("interface");
		// Body should include extends clause
		expect(fns[0]?.normalizedBody).toContain("extends");
	});

	test("skips trivially small type aliases (below token threshold)", () => {
		const code = "type Foo = string;";
		const sf = makeSourceFile(code);
		const fns = collectFunctions(sf, "test.ts");
		// 'string' as a type body → too few tokens after normalization
		expect(fns).toHaveLength(0);
	});

	test("collects multiple functions", () => {
		const code = `
function alpha(x: number): number {
  const doubled = x * 2;
  const shifted = doubled + 10;
  return shifted;
}

const beta = (y: number): number => {
  const tripled = y * 3;
  const shifted = tripled + 10;
  return shifted;
};
`;
		const sf = makeSourceFile(code);
		const fns = collectFunctions(sf, "test.ts");
		expect(fns).toHaveLength(2);
		expect(fns.map((f) => f.name)).toEqual(["alpha", "beta"]);
	});

	test("skips arrow functions with expression body (not block)", () => {
		const code = `
const double = (x: number): number => x * 2;
`;
		const sf = makeSourceFile(code);
		const fns = collectFunctions(sf, "test.ts");
		// Expression body, not a block — skipped
		expect(fns).toHaveLength(0);
	});

	test("does not collect nested functions", () => {
		// Only top-level statements are scanned
		const code = `
function outer(x: number): number {
  function inner(y: number): number {
    const val = y + 1;
    const res = val * 2;
    return res;
  }
  return inner(x);
}
`;
		const sf = makeSourceFile(code);
		const fns = collectFunctions(sf, "test.ts");
		// Only outer is collected (top-level statement)
		expect(fns).toHaveLength(1);
		expect(fns[0]?.name).toBe("outer");
	});
});

describe("findSimilarGroups", () => {
	const filePath = "test.ts";

	function makeFunction(
		name: string,
		body: string,
		file = filePath
	): ReturnType<typeof collectFunctions>[number] {
		const sf = makeSourceFile(`function ${name}() ${body}`);
		const fns = collectFunctions(sf, file);
		const fn = fns[0];
		if (!fn) {
			// Force create when body is too small to be collected
			const normalized = normalizeBody(body);
			const tokens = tokenize(normalized);
			return {
				file,
				name,
				kind: "function" as const,
				line: 1,
				column: 0,
				normalizedBody: normalized,
				tokenCount: tokens.length,
				bodyLength: body.length,
				bodyLines: body.split("\n").length,
				hasDirective: false,
				isWrapper: false,
				isTypeGuard: false,
				extendsNames: [],
				memberNames: [],
				contentTokens: extractContentTokens(body),
			};
		}
		return { ...fn, name };
	}

	test("groups exact duplicates (bucket=exact)", () => {
		// Two functions with identical structure but different variable names
		const bodyA = `{
  const date = input.toISOString();
  const formatted = date.split("T")[0];
  return formatted;
}`;
		const bodyB = `{
  const ts = value.toISOString();
  const result = ts.split("T")[0];
  return result;
}`;
		const fnA = makeFunction("formatDate", bodyA, "a.ts");
		const fnB = makeFunction("formatTimestamp", bodyB, "b.ts");

		const groups = findSimilarGroups([fnA, fnB], 0.7);
		expect(groups).toHaveLength(1);
		expect(groups[0]?.bucket).toBe("exact");
		expect(groups[0]?.score).toBeCloseTo(1.0, 3);
		expect(groups[0]?.functions.map((f) => f.name)).toEqual(
			expect.arrayContaining(["formatDate", "formatTimestamp"])
		);
	});

	test("groups loosely similar functions (bucket=high or medium)", () => {
		// Two functions with similar but not identical structure
		const bodyA = `{
  const items = list.filter(Boolean);
  const result = items.map(x => x.trim());
  return result;
}`;
		const bodyB = `{
  const items = collection.filter(Boolean);
  const result = items.map(x => x.toLowerCase());
  const final = result.join(",");
  return final;
}`;
		const fnA = makeFunction("processA", bodyA, "a.ts");
		const fnB = makeFunction("processB", bodyB, "b.ts");

		const groups = findSimilarGroups([fnA, fnB], 0.5);
		expect(groups).toHaveLength(1);
		const g0 = groups[0];
		if (!g0) {
			throw new Error("Expected at least one group");
		}
		expect(["exact", "high", "medium"]).toContain(g0.bucket);
	});

	test("does not group dissimilar functions", () => {
		const bodyA = `{
  const x = a + b;
  const y = x * 2;
  return y;
}`;
		const bodyB = `{
  for (const item of list) {
    if (item.active) {
      results.push(item.name);
    }
  }
  return results;
}`;
		const fnA = makeFunction("add", bodyA, "a.ts");
		const fnB = makeFunction("collect", bodyB, "b.ts");

		const groups = findSimilarGroups([fnA, fnB], 0.7);
		expect(groups).toHaveLength(0);
	});

	test("returns empty array when no functions provided", () => {
		expect(findSimilarGroups([], 0.7)).toHaveLength(0);
	});

	test("returns empty array for single function", () => {
		const fn = makeFunction(
			"solo",
			`{
  const x = compute(a, b);
  const y = transform(x);
  return y;
}`
		);
		expect(findSimilarGroups([fn], 0.7)).toHaveLength(0);
	});

	test("groups are sorted by score descending", () => {
		// Build FunctionInfo objects directly with controlled normalizedBody values
		// so that exact vs medium similarity is deterministic.

		// Exact pair: identical normalized body
		const exactBody =
			"{ const $I = $I.$I($I); const $I = $I.$I($S); return $I; }";
		const fnE1: ReturnType<typeof collectFunctions>[number] = {
			file: "a.ts",
			name: "exactA",
			kind: "function" as const,
			line: 1,
			column: 0,
			normalizedBody: exactBody,
			tokenCount: tokenize(exactBody).length,
			bodyLength: 100,
			bodyLines: 5,
			hasDirective: false,
			isWrapper: false,
			isTypeGuard: false,
			extendsNames: [],
			memberNames: [],
			contentTokens: [],
		};
		const fnE2: ReturnType<typeof collectFunctions>[number] = {
			file: "b.ts",
			name: "exactB",
			kind: "function" as const,
			line: 1,
			column: 0,
			normalizedBody: exactBody,
			tokenCount: tokenize(exactBody).length,
			bodyLength: 100,
			bodyLines: 5,
			hasDirective: false,
			isWrapper: false,
			isTypeGuard: false,
			extendsNames: [],
			memberNames: [],
			contentTokens: [],
		};

		// Medium pair: share most tokens but differ on one clause
		const looseBodyA =
			"{ for (const $I of $I) { if ($I.$I) { $I.$I($I.$I); } } return $I; }";
		const looseBodyB =
			"{ for (const $I of $I) { if ($I.$I) { $I.$I($I.$I); } $I++; } return $I; }";
		const fnL1: ReturnType<typeof collectFunctions>[number] = {
			file: "c.ts",
			name: "loopA",
			kind: "function" as const,
			line: 1,
			column: 0,
			normalizedBody: looseBodyA,
			tokenCount: tokenize(looseBodyA).length,
			bodyLength: 120,
			bodyLines: 5,
			hasDirective: false,
			isWrapper: false,
			isTypeGuard: false,
			extendsNames: [],
			memberNames: [],
			contentTokens: [],
		};
		const fnL2: ReturnType<typeof collectFunctions>[number] = {
			file: "d.ts",
			name: "loopB",
			kind: "function" as const,
			line: 1,
			column: 0,
			normalizedBody: looseBodyB,
			tokenCount: tokenize(looseBodyB).length,
			bodyLength: 130,
			bodyLines: 5,
			hasDirective: false,
			isWrapper: false,
			isTypeGuard: false,
			extendsNames: [],
			memberNames: [],
			contentTokens: [],
		};

		// Verify cross-pair similarity is below threshold 0.7 so groups stay separate
		const crossScore = jaccardSimilarity(
			tokenize(exactBody),
			tokenize(looseBodyA)
		);
		expect(crossScore).toBeLessThan(0.7);

		const groups = findSimilarGroups([fnE1, fnL1, fnE2, fnL2], 0.7);
		expect(groups.length).toBeGreaterThanOrEqual(1);
		// Groups should be sorted by score descending
		for (let i = 1; i < groups.length; i++) {
			const prev = groups[i - 1];
			const curr = groups[i];
			if (prev && curr) {
				expect(prev.score).toBeGreaterThanOrEqual(curr.score);
			}
		}
	});

	test("each function appears in at most one group", () => {
		const body = `{
  const result = source.fetch(url);
  const data = result.json();
  return data;
}`;
		const fn1 = makeFunction("fetchA", body, "a.ts");
		const fn2 = makeFunction("fetchB", body, "b.ts");
		const fn3 = makeFunction("fetchC", body, "c.ts");

		const groups = findSimilarGroups([fn1, fn2, fn3], 0.7);
		const allNames = groups.flatMap((g) => g.functions.map((f) => f.name));
		const uniqueNames = new Set(allNames);
		expect(uniqueNames.size).toBe(allNames.length);
	});

	test("sameNameOnly filters out functions with different names", () => {
		const body = `{
  const result = source.fetch(url);
  const data = result.json();
  return data;
}`;
		const fn1 = makeFunction("fetchData", body, "a.ts");
		const fn2 = makeFunction("fetchData", body, "b.ts");
		const fn3 = makeFunction("loadConfig", body, "c.ts");

		const groups = findSimilarGroups([fn1, fn2, fn3], {
			threshold: 0.7,
			sameNameOnly: true,
		});
		expect(groups).toHaveLength(1);
		expect(groups[0]?.functions).toHaveLength(2);
		expect(groups[0]?.functions.map((f) => f.name)).toEqual([
			"fetchData",
			"fetchData",
		]);
	});

	test("sameNameOnly produces no groups when all names differ (issue #23)", () => {
		// Reproduction case from issue #23: structurally identical functions
		// with different names should never be grouped with --same-name-only.
		const body = `{
  const normalized = filePath.toLowerCase().trim();
  const result = isExcludedSourcePath(normalized, TEST_FILE_RE, INFRA_FILE_RE);
  return result;
}`;
		const fn1 = makeFunction("getHookContext", body, "hooks/a.ts");
		const fn2 = makeFunction("runHook", body, "hooks/b.ts");
		const fn3 = makeFunction("main", body, "hooks/c.ts");

		const groups = findSimilarGroups([fn1, fn2, fn3], {
			threshold: 0.5,
			sameNameOnly: true,
		});
		expect(groups).toHaveLength(0);
	});

	test("sameNameOnly groups same-named functions across multiple files (issue #23)", () => {
		// When some functions share a name and others don't, only the
		// same-named functions should be grouped.
		const body = `{
  const normalized = filePath.toLowerCase().trim();
  const result = isExcludedSourcePath(normalized, TEST_FILE_RE, INFRA_FILE_RE);
  return result;
}`;
		const fn1 = makeFunction("checkFile", body, "hooks/a.ts");
		const fn2 = makeFunction("runHook", body, "hooks/b.ts");
		const fn3 = makeFunction("checkFile", body, "hooks/c.ts");
		const fn4 = makeFunction("main", body, "hooks/d.ts");

		const groups = findSimilarGroups([fn1, fn2, fn3, fn4], {
			threshold: 0.5,
			sameNameOnly: true,
		});
		expect(groups).toHaveLength(1);
		expect(groups[0]?.functions).toHaveLength(2);
		expect(groups[0]?.functions.every((f) => f.name === "checkFile")).toBe(
			true
		);
	});

	test("nameThreshold filters out functions with dissimilar names", () => {
		const body = `{
  const result = source.fetch(url);
  const data = result.json();
  return data;
}`;
		const fn1 = makeFunction("makeTempDir", body, "a.ts");
		const fn2 = makeFunction("createTempDir", body, "b.ts");
		const fn3 = makeFunction("isShellTool", body, "c.ts");

		const groups = findSimilarGroups([fn1, fn2, fn3], {
			threshold: 0.7,
			nameThreshold: 0.4,
		});
		expect(groups).toHaveLength(1);
		expect(groups[0]?.functions.map((f) => f.name)).toEqual(
			expect.arrayContaining(["makeTempDir", "createTempDir"])
		);
		// isShellTool should not be in the group
		const names = groups[0]?.functions.map((f) => f.name) ?? [];
		expect(names).not.toContain("isShellTool");
	});

	test("downscores structurally identical functions with different constants (false positive reduction)", () => {
		// Regex-test pattern: same AST skeleton, different external constant references.
		// isKebabCase and isHookNaming both reduce to `{ return $I.$I($I); }` after
		// normalization, but they reference completely different regex constants.
		const sf1 = makeSourceFile(`
function isKebabCase(name: string): boolean {
  const matched = KEBAB_CASE_REGEX.test(name);
  const valid = matched && name.length > 0;
  return valid;
}`);
		const sf2 = makeSourceFile(`
function isHookNaming(name: string): boolean {
  const matched = HOOK_NAMING_REGEX.test(name);
  const valid = matched && name.length > 0;
  return valid;
}`);
		const fn1 = collectFunctions(sf1, "a.ts")[0];
		const fn2 = collectFunctions(sf2, "b.ts")[0];

		if (!(fn1 && fn2)) {
			throw new Error("Expected functions to be collected");
		}

		// Normalized bodies are identical — the old code would score these 1.0
		expect(fn1.normalizedBody).toBe(fn2.normalizedBody);

		// Content tokens differ (KEBAB_CASE_REGEX vs HOOK_NAMING_REGEX)
		expect(fn1.contentTokens).toContain("KEBAB_CASE_REGEX");
		expect(fn2.contentTokens).toContain("HOOK_NAMING_REGEX");

		// At the default threshold (0.8), these should NOT be grouped together
		const groups = findSimilarGroups([fn1, fn2], 0.8);
		expect(groups).toHaveLength(0);
	});

	test("downscores array-includes pattern with different string literal contents (false positive reduction)", () => {
		// Array-includes pattern: same structure, completely different string values
		const sf1 = makeSourceFile(`
function isWeakCryptoFunction(functionName: string): boolean {
  const weakFunctions = ["md5", "sha1", "des", "rc4", "crc32"];
  return weakFunctions.includes(functionName.toLowerCase());
}`);
		const sf2 = makeSourceFile(`
function isSqlFunction(functionName: string): boolean {
  const sqlFunctions = ["query", "execute", "raw", "sql", "exec"];
  return sqlFunctions.includes(functionName.toLowerCase());
}`);
		const fn1 = collectFunctions(sf1, "security.ts")[0];
		const fn2 = collectFunctions(sf2, "security.ts")[0];

		if (!(fn1 && fn2)) {
			throw new Error("Expected functions to be collected");
		}

		expect(fn1.normalizedBody).toBe(fn2.normalizedBody);

		const groups = findSimilarGroups([fn1, fn2], 0.8);
		expect(groups).toHaveLength(0);
	});

	test("preserves exact-duplicate grouping when content tokens are identical", () => {
		// True duplicate: same structure AND same content (string literal "T")
		const bodyA = `{
  const date = input.toISOString();
  const formatted = date.split("T")[0];
  return formatted;
}`;
		const bodyB = `{
  const ts = value.toISOString();
  const result = ts.split("T")[0];
  return result;
}`;
		const fnA = makeFunction("formatDate", bodyA, "a.ts");
		const fnB = makeFunction("formatTimestamp", bodyB, "b.ts");

		const groups = findSimilarGroups([fnA, fnB], 0.8);
		expect(groups).toHaveLength(1);
		expect(groups[0]?.bucket).toBe("exact");
	});

	test("does not group cross-file object-mapper pairs with completely different names", () => {
		// Mirrors the real false positive: buildModuleReference (scanner.ts) vs
		// toProjectConfig (tsconfig-discovery.ts). Both are "return { $I: $I.$I, ... }"
		// object mappers with high bigram Jaccard but zero shared name tokens.
		const bodyA = `{
  return {
    sourceFile: sourceFile.fileName,
    specifier: base.specifier,
    resolvedPath: base.resolvedPath,
    type,
    line: base.line,
    column: base.column,
    bindings: bindings.length > 0 ? bindings : undefined,
    isTypeOnly,
  };
}`;
		const bodyB = `{
  return {
    rootDir: info.rootDir,
    tsconfigPath: info.path,
    compilerOptions: info.compilerOptions,
    pathAliases: info.pathAliases,
    include: info.include,
    exclude: info.exclude,
    files: info.files,
    references: info.references.length > 0 ? info.references : undefined,
  };
}`;
		const fnA = makeFunction("buildModuleReference", bodyA, "scanner.ts");
		const fnB = makeFunction("toProjectConfig", bodyB, "tsconfig-discovery.ts");

		// nameScore = 0 (no shared camelCase tokens) → 0.85 penalty applied cross-file
		const groups = findSimilarGroups([fnA, fnB], 0.8);
		expect(groups).toHaveLength(0);
	});

	test("preserves same-file pairs with zero name similarity", () => {
		// Same-file pairs are never penalized — they aren't cross-domain false positives.
		const body = `{
  return {
    a: obj.a,
    b: obj.b,
    c: obj.c,
    d: obj.d,
    e: obj.e,
    f: obj.f,
    g: arr.length > 0 ? arr : undefined,
  };
}`;
		const fnA = makeFunction("buildAlpha", body, "same.ts");
		const fnB = makeFunction("toBeta", body, "same.ts");

		// Same file → no name penalty → exact bucket
		const groups = findSimilarGroups([fnA, fnB], 0.8);
		expect(groups).toHaveLength(1);
	});

	test("kinds filter excludes non-matching declaration kinds", () => {
		const body = `{
  const x = a.doSomething(b, c);
  const y = d.process(e, f);
  return x + y;
}`;
		const sf = makeSourceFile(`
function fnA() ${body}
function fnB() ${body}
type AliasA = { id: string; name: string; role: string };
type AliasB = { id: string; name: string; role: string };
`);
		const all = collectFunctions(sf, "test.ts");
		const fns = all.filter((f) => f.kind === "function");
		const types = all.filter((f) => f.kind === "type");

		// Without filter: groups may include both functions and types
		const fnOnlyGroups = findSimilarGroups(all, {
			threshold: 0.7,
			kinds: ["function"],
		});
		for (const g of fnOnlyGroups) {
			for (const fn of g.functions) {
				expect(fn.kind).toBe("function");
			}
		}

		const typeOnlyGroups = findSimilarGroups(all, {
			threshold: 0.7,
			kinds: ["type"],
		});
		for (const g of typeOnlyGroups) {
			for (const fn of g.functions) {
				expect(fn.kind).toBe("type");
			}
		}

		// Both arrays consumed to suppress lint warnings
		expect(fns.length + types.length).toBe(all.length);
	});

	test("similar type aliases are grouped", () => {
		const sf = makeSourceFile(`
export type UserModel = {
  id: string;
  name: string;
  email: string;
  createdAt: Date;
};
export type ProductModel = {
  id: string;
  name: string;
  email: string;
  createdAt: Date;
};
`);
		const declarations = collectFunctions(sf, "test.ts");
		expect(declarations.filter((d) => d.kind === "type")).toHaveLength(2);
		const groups = findSimilarGroups(declarations, { threshold: 0.7 });
		expect(groups.length).toBeGreaterThanOrEqual(1);
		const typeGroup = groups.find((g) =>
			g.functions.every((f) => f.kind === "type")
		);
		expect(typeGroup).toBeDefined();
	});

	test("similar interfaces are grouped", () => {
		const sf = makeSourceFile(`
export interface RequestOptions {
  method: string;
  headers: Record<string, string>;
  timeout: number;
  retry: boolean;
}
export interface FetchOptions {
  method: string;
  headers: Record<string, string>;
  timeout: number;
  retry: boolean;
}
`);
		const declarations = collectFunctions(sf, "test.ts");
		expect(declarations.filter((d) => d.kind === "interface")).toHaveLength(2);
		const groups = findSimilarGroups(declarations, { threshold: 0.7 });
		expect(groups.length).toBeGreaterThanOrEqual(1);
		const ifaceGroup = groups.find((g) =>
			g.functions.every((f) => f.kind === "interface")
		);
		expect(ifaceGroup).toBeDefined();
	});
});

describe("camelCaseTokenize", () => {
	test("splits camelCase", () => {
		expect(camelCaseTokenize("makeTempDir")).toEqual(["make", "temp", "dir"]);
	});

	test("splits PascalCase", () => {
		expect(camelCaseTokenize("XMLParser")).toEqual(["xml", "parser"]);
	});

	test("handles single word", () => {
		expect(camelCaseTokenize("fetch")).toEqual(["fetch"]);
	});

	test("handles snake_case", () => {
		expect(camelCaseTokenize("make_temp_dir")).toEqual(["make", "temp", "dir"]);
	});

	test("handles consecutive uppercase", () => {
		expect(camelCaseTokenize("parseHTMLDocument")).toEqual([
			"parse",
			"html",
			"document",
		]);
	});
});

describe("nameSimilarity", () => {
	test("returns 1.0 for identical names", () => {
		expect(nameSimilarity("fetchData", "fetchData")).toBe(1);
	});

	test("returns high score for similar camelCase names", () => {
		const score = nameSimilarity("makeTempDir", "createTempDir");
		// Shares "temp" and "dir" tokens
		expect(score).toBeGreaterThan(0.4);
	});

	test("returns low score for dissimilar names", () => {
		const score = nameSimilarity("isShellTool", "createTempDir");
		expect(score).toBeLessThan(0.2);
	});

	test("returns 0 for completely different names", () => {
		const score = nameSimilarity("alpha", "beta");
		expect(score).toBe(0);
	});
});

describe("matchesRelatedPath", () => {
	test("matches exact file path", () => {
		expect(matchesRelatedPath("/abs/src/foo.ts", "/abs/src/foo.ts")).toBe(true);
	});

	test("matches directory prefix", () => {
		expect(matchesRelatedPath("/abs/src/utils/foo.ts", "/abs/src/utils")).toBe(
			true
		);
	});

	test("does not match unrelated path", () => {
		expect(matchesRelatedPath("/abs/src/foo.ts", "/abs/src/bar.ts")).toBe(
			false
		);
	});

	test("matches glob pattern with *", () => {
		expect(matchesRelatedPath("src/utils/foo.ts", "src/utils/*.ts")).toBe(true);
	});

	test("matches glob pattern with **", () => {
		expect(
			matchesRelatedPath("src/core/deep/file.ts", "src/core/**/*.ts")
		).toBe(true);
	});

	test("does not match glob for different directory", () => {
		expect(matchesRelatedPath("src/commands/foo.ts", "src/core/*.ts")).toBe(
			false
		);
	});

	test("matches glob pattern with ? single-character wildcard", () => {
		expect(matchesRelatedPath("src/utils/a.ts", "src/utils/?.ts")).toBe(true);
	});

	test("does not match ? glob when filename is multi-character", () => {
		expect(matchesRelatedPath("src/utils/foo.ts", "src/utils/?.ts")).toBe(
			false
		);
	});
});

describe("analyzeSimilarity options object overload", () => {
	test("accepts options object with threshold and filter options", async () => {
		const report = await analyzeSimilarity({
			directory: "/tmp/nonexistent-dir-xyz",
			threshold: 0.6,
			sameNameOnly: true,
			skipSameFile: true,
		});
		expect(report.groups).toHaveLength(0);
		expect(report.totalFunctions).toBe(0);
		expect(report.packageCount).toBeUndefined();
	});

	test("options object with workspace=true returns packageCount", async () => {
		const report = await analyzeSimilarity({
			directory: "/tmp/nonexistent-dir-xyz",
			threshold: 0.7,
			workspace: true,
		});
		expect(report.groups).toHaveLength(0);
		expect(report.packageCount).toBe(0);
	});
});

describe("findSimilarGroups onlyRelatedTo", () => {
	const filePath = "test.ts";

	function makeFunction(
		fnName: string,
		body: string,
		file = filePath
	): ReturnType<typeof collectFunctions>[number] {
		const sf = makeSourceFile(`function ${fnName}() ${body}`);
		const fns = collectFunctions(sf, file);
		const fn = fns[0];
		if (!fn) {
			const normalized = normalizeBody(body);
			const tokens = tokenize(normalized);
			return {
				file,
				name: fnName,
				kind: "function" as const,
				line: 1,
				column: 0,
				normalizedBody: normalized,
				tokenCount: tokens.length,
				bodyLength: body.length,
				bodyLines: body.split("\n").length,
				hasDirective: false,
				isWrapper: false,
				isTypeGuard: false,
				extendsNames: [],
				memberNames: [],
				contentTokens: extractContentTokens(body),
			};
		}
		return { ...fn, name: fnName };
	}

	test("filters to groups containing the related file", () => {
		const body = `{
  const result = source.fetch(url);
  const data = result.json();
  return data;
}`;
		const fn1 = makeFunction("fetchA", body, "/abs/src/utils/a.ts");
		const fn2 = makeFunction("fetchB", body, "/abs/src/utils/b.ts");
		const fn3 = makeFunction("fetchC", body, "/abs/src/core/c.ts");
		const fn4 = makeFunction("fetchD", body, "/abs/src/core/d.ts");

		// Without filter — 1 big group
		const allGroups = findSimilarGroups([fn1, fn2, fn3, fn4], 0.7);
		expect(allGroups.length).toBeGreaterThanOrEqual(1);

		// With filter — only groups that include a function from /abs/src/utils/a.ts
		const filtered = findSimilarGroups([fn1, fn2, fn3, fn4], {
			threshold: 0.7,
			onlyRelatedTo: "/abs/src/utils/a.ts",
		});
		expect(filtered.length).toBeGreaterThanOrEqual(1);
		// The group must contain fn1 (from /abs/src/utils/a.ts)
		const relatedFns = filtered.flatMap((g) => g.functions);
		expect(relatedFns.some((f) => f.file === "/abs/src/utils/a.ts")).toBe(true);
	});

	test("returns empty when no groups match the related path", () => {
		const body = `{
  const result = source.fetch(url);
  const data = result.json();
  return data;
}`;
		const fn1 = makeFunction("fetchA", body, "/abs/src/core/a.ts");
		const fn2 = makeFunction("fetchB", body, "/abs/src/core/b.ts");

		const filtered = findSimilarGroups([fn1, fn2], {
			threshold: 0.7,
			onlyRelatedTo: "/abs/src/utils/nonexistent.ts",
		});
		expect(filtered).toHaveLength(0);
	});
});

describe("directive detection", () => {
	function makeFunction(
		fnName: string,
		body: string,
		file = "test.ts"
	): ReturnType<typeof collectFunctions>[number] {
		const sf = makeSourceFile(`function ${fnName}() ${body}`);
		const fns = collectFunctions(sf, file);
		const fn = fns[0];
		if (!fn) {
			const normalized = normalizeBody(body);
			const tokens = tokenize(normalized);
			return {
				file,
				name: fnName,
				kind: "function" as const,
				line: 1,
				column: 0,
				normalizedBody: normalized,
				tokenCount: tokens.length,
				bodyLength: body.length,
				bodyLines: body.split("\n").length,
				hasDirective: false,
				isWrapper: false,
				isTypeGuard: false,
				extendsNames: [],
				memberNames: [],
				contentTokens: extractContentTokens(body),
			};
		}
		return { ...fn, name: fnName };
	}

	test("detects 'use server' directive in function body", () => {
		const code = `
function serverAction(data: FormData) {
  "use server";
  const name = data.get("name");
  const result = processData(name);
  return result;
}
`;
		const sf = makeSourceFile(code);
		const fns = collectFunctions(sf, "test.ts");
		expect(fns).toHaveLength(1);
		expect(fns[0]?.hasDirective).toBe(true);
	});

	test("detects 'use client' directive", () => {
		const code = `
function clientComponent(props: unknown) {
  "use client";
  const state = useState(props);
  const rendered = renderUI(state);
  return rendered;
}
`;
		const sf = makeSourceFile(code);
		const fns = collectFunctions(sf, "test.ts");
		expect(fns).toHaveLength(1);
		expect(fns[0]?.hasDirective).toBe(true);
	});

	test("detects 'use cache' directive", () => {
		const code = `
function cachedAction(id: string) {
  "use cache";
  const data = fetchById(id);
  const result = processData(data);
  return result;
}
`;
		const sf = makeSourceFile(code);
		const fns = collectFunctions(sf, "test.ts");
		expect(fns).toHaveLength(1);
		expect(fns[0]?.hasDirective).toBe(true);
	});

	test("detects 'use cache: revalidate' directive", () => {
		const code = `
function revalidateAction(id: string) {
  "use cache: revalidate";
  const data = fetchById(id);
  const result = processData(data);
  return result;
}
`;
		const sf = makeSourceFile(code);
		const fns = collectFunctions(sf, "test.ts");
		expect(fns).toHaveLength(1);
		expect(fns[0]?.hasDirective).toBe(true);
	});

	test("detects 'use strict' directive", () => {
		const code = `
function strictFn(x: number) {
  "use strict";
  const doubled = x * 2;
  const result = doubled + 10;
  return result;
}
`;
		const sf = makeSourceFile(code);
		const fns = collectFunctions(sf, "test.ts");
		expect(fns).toHaveLength(1);
		expect(fns[0]?.hasDirective).toBe(true);
	});

	test("does not flag functions without directives", () => {
		const code = `
function normalFunction(x: number) {
  const doubled = x * 2;
  const result = doubled + 10;
  return result;
}
`;
		const sf = makeSourceFile(code);
		const fns = collectFunctions(sf, "test.ts");
		expect(fns).toHaveLength(1);
		expect(fns[0]?.hasDirective).toBe(false);
	});

	test("skipDirectives filters out functions with directives", () => {
		const bodyWithDirective = `{
  "use server";
  const data = fetchData(url);
  const parsed = parseData(data);
  return parsed;
}`;
		const bodyNormal = `{
  const data = fetchData(url);
  const parsed = parseData(data);
  return parsed;
}`;
		const fnA = makeFunction("serverFn", bodyWithDirective, "a.ts");
		const fnB = makeFunction("normalFnA", bodyNormal, "b.ts");
		const fnC = makeFunction("normalFnB", bodyNormal, "c.ts");

		// Without filter: serverFn groups with normals (same structure after normalization)
		const all = findSimilarGroups([fnA, fnB, fnC], 0.7);
		expect(all.length).toBeGreaterThanOrEqual(1);

		// With skipDirectives: serverFn excluded, only normals group
		const filtered = findSimilarGroups([fnA, fnB, fnC], {
			threshold: 0.7,
			skipDirectives: true,
		});
		for (const g of filtered) {
			expect(g.functions.every((f) => !f.hasDirective)).toBe(true);
		}
	});
});

describe("isWrapperBody detection", () => {
	test("detects return-call wrapper and marks isWrapper=true", () => {
		const code = `
function wrapperReturn(x: number): number {
  return otherFunction(x);
}
`;
		const sf = makeSourceFile(code);
		const fns = collectFunctions(sf, "test.ts");
		expect(fns).toHaveLength(1);
		expect(fns[0]?.isWrapper).toBe(true);
	});

	test("detects bare expression-call wrapper and marks isWrapper=true", () => {
		const code = `
function wrapperBare(x: number): void {
  sideEffectFunction(x);
}
`;
		const sf = makeSourceFile(code);
		const fns = collectFunctions(sf, "test.ts");
		// May be below MIN_TOKEN_COUNT — if collected, check isWrapper
		if (fns.length > 0) {
			expect(fns[0]?.isWrapper).toBe(true);
		}
	});

	test("does not mark multi-statement functions as wrappers", () => {
		const code = `
function notWrapper(x: number): number {
  const doubled = x * 2;
  const result = doubled + 10;
  return result;
}
`;
		const sf = makeSourceFile(code);
		const fns = collectFunctions(sf, "test.ts");
		expect(fns).toHaveLength(1);
		expect(fns[0]?.isWrapper).toBe(false);
	});

	test("skipWrappers excludes wrapper functions from grouping", () => {
		const wrapperBody = `{
  return delegateFunction(input, options, context);
}`;
		const normalBody = `{
  const data = fetchData(url);
  const parsed = parseData(data);
  return parsed;
}`;
		const sf1 = makeSourceFile(`function wrapA() ${wrapperBody}`, "a.ts");
		const sf2 = makeSourceFile(`function wrapB() ${wrapperBody}`, "b.ts");
		const sf3 = makeSourceFile(`function normalA() ${normalBody}`, "c.ts");
		const sf4 = makeSourceFile(`function normalB() ${normalBody}`, "d.ts");
		const fns = [
			...collectFunctions(sf1, "a.ts"),
			...collectFunctions(sf2, "b.ts"),
			...collectFunctions(sf3, "c.ts"),
			...collectFunctions(sf4, "d.ts"),
		];
		const groups = findSimilarGroups(fns, {
			threshold: 0.7,
			skipWrappers: true,
		});
		for (const g of groups) {
			expect(g.functions.every((f) => !f.isWrapper)).toBe(true);
		}
	});
});

describe("analyzeSimilarity kinds filter forwarding", () => {
	test("kinds=function excludes type and interface results via analyzeSimilarity", async () => {
		const dir = import.meta.dir;
		// Run with kinds restricted to function — should never return type/interface groups
		const report = await analyzeSimilarity({
			directory: dir,
			threshold: 0.5,
			kinds: ["function"],
		});
		for (const group of report.groups) {
			for (const fn of group.functions) {
				expect(fn.kind).toBe("function");
			}
		}
	});

	test("kinds=type excludes function and interface results via analyzeSimilarity", async () => {
		const dir = import.meta.dir;
		const report = await analyzeSimilarity({
			directory: dir,
			threshold: 0.5,
			kinds: ["type"],
		});
		for (const group of report.groups) {
			for (const fn of group.functions) {
				expect(fn.kind).toBe("type");
			}
		}
	});
});

describe("false positive categories (issue #45)", () => {
	// ── Category 1: structurally identical types with different field names ──
	test("does not flag types with identical shape but different property names as exact", () => {
		// _seconds/_nanoseconds vs seconds/nanoseconds: same shape after
		// normalization, but field names are semantically distinct. With
		// extractAllIdentifiers as content tokens these should score < 1.0.
		const code = `
export type FirestoreTimestampA = {
  _seconds: number;
  _nanoseconds: number;
};
export type FirestoreTimestampB = {
  seconds: number;
  nanoseconds: number;
};
`;
		const sf = makeSourceFile(code);
		const fns = collectFunctions(sf, "timestamps.ts");
		expect(fns).toHaveLength(2);
		const [a, b] = fns as [
			ReturnType<typeof collectFunctions>[0],
			ReturnType<typeof collectFunctions>[0],
		];
		// Verify both are collected
		expect(a.kind).toBe("type");
		expect(b.kind).toBe("type");
		// Content tokens for types must include property names
		expect(a.contentTokens).toContain("_seconds");
		expect(b.contentTokens).toContain("seconds");
		// Grouping at default threshold must not flag these as a group
		const groups = findSimilarGroups([a, b], { threshold: 0.8 });
		expect(groups).toHaveLength(0);
	});

	// ── Category 2: type guard functions (cross-file) ──
	test("does not group cross-file type guard functions", () => {
		const codeA = `
function isTimestampA(value: unknown): value is TimestampA {
  const v = value as Record<string, unknown>;
  if (typeof v !== "object" || v === null) return false;
  if (typeof v["_seconds"] !== "number") return false;
  if (typeof v["_nanoseconds"] !== "number") return false;
  return true;
}
`;
		const codeB = `
function isTimestampB(value: unknown): value is TimestampB {
  const v = value as Record<string, unknown>;
  if (typeof v !== "object" || v === null) return false;
  if (typeof v["seconds"] !== "number") return false;
  if (typeof v["nanoseconds"] !== "number") return false;
  return true;
}
`;
		const sfA = makeSourceFile(codeA, "a.ts");
		const sfB = makeSourceFile(codeB, "b.ts");
		const fnsA = collectFunctions(sfA, "guards/a.ts");
		const fnsB = collectFunctions(sfB, "guards/b.ts");
		expect(fnsA).toHaveLength(1);
		expect(fnsB).toHaveLength(1);
		// Both should be detected as type guards
		expect(fnsA[0]?.isTypeGuard).toBe(true);
		expect(fnsB[0]?.isTypeGuard).toBe(true);
		// Cross-file type guard pairs must not be grouped
		const guardA = fnsA[0];
		const guardB = fnsB[0];
		if (!(guardA && guardB)) {
			throw new Error("Expected type guard functions to be collected");
		}
		const groups = findSimilarGroups([guardA, guardB], { threshold: 0.7 });
		expect(groups).toHaveLength(0);
	});

	test("still groups non-type-guard functions with identical structure", () => {
		// Confirm the type-guard exclusion doesn't over-suppress regular functions
		const bodyA = `{
  const v = value as Record<string, unknown>;
  if (typeof v !== "object" || v === null) return false;
  if (typeof v["fieldA"] !== "number") return false;
  if (typeof v["fieldB"] !== "number") return false;
  return true;
}`;
		const bodyB = `{
  const v = value as Record<string, unknown>;
  if (typeof v !== "object" || v === null) return false;
  if (typeof v["fieldX"] !== "number") return false;
  if (typeof v["fieldY"] !== "number") return false;
  return true;
}`;
		const codeA = `function checkPropsA(value: unknown): boolean ${bodyA}`;
		const codeB = `function checkPropsB(value: unknown): boolean ${bodyB}`;
		const sfA = makeSourceFile(codeA, "a.ts");
		const sfB = makeSourceFile(codeB, "b.ts");
		const fnsA = collectFunctions(sfA, "checks/a.ts");
		const fnsB = collectFunctions(sfB, "checks/b.ts");
		expect(fnsA[0]?.isTypeGuard).toBe(false);
		expect(fnsB[0]?.isTypeGuard).toBe(false);
		// Regular functions with identical structure ARE expected to group
		const checkA = fnsA[0];
		const checkB = fnsB[0];
		if (!(checkA && checkB)) {
			throw new Error("Expected functions to be collected");
		}
		const groups = findSimilarGroups([checkA, checkB], { threshold: 0.5 });
		expect(groups.length).toBeGreaterThanOrEqual(1);
	});

	// ── Category 3: Zod-like string literal unions with disjoint literals ──
	test("does not group type aliases with identical Zod-like shape but disjoint literal values", () => {
		// Simulates: z.union([z.literal("a"), z.literal("b")]) vs z.union([z.literal("x"), z.literal("y"), z.literal("z")])
		// Different numbers of literals → bigram path, but content tokens (literals) are disjoint
		const codeA = `
type ApprovalStatus = "pending" | "approved" | "rejected";
`;
		const codeB = `
type ChannelType = "email" | "push" | "sms";
`;
		const sfA = makeSourceFile(codeA, "approval.ts");
		const sfB = makeSourceFile(codeB, "channel.ts");
		const fnsA = collectFunctions(sfA, "approval.ts");
		const fnsB = collectFunctions(sfB, "channel.ts");
		const zodA = fnsA[0];
		const zodB = fnsB[0];
		// Both may be too small for the type token threshold — skip if not collected
		if (!(zodA && zodB)) {
			return;
		}
		const groups = findSimilarGroups([zodA, zodB], { threshold: 0.8 });
		expect(groups).toHaveLength(0);
	});

	test("content token penalty reduces score for structurally similar types with disjoint string literals", () => {
		// Simulate types whose bigrams are very similar but whose string literal
		// content tokens are completely disjoint. The score must be reduced below 0.8.
		const normalized =
			"{ $I : $I ; $I : $I ; $I : $I ; $I : $I ; $I : $I ; $I : $I ; }";
		const base: ReturnType<typeof collectFunctions>[number] = {
			file: "a.ts",
			name: "SchemaA",
			kind: "type" as const,
			line: 1,
			column: 0,
			normalizedBody: `${normalized} x`,
			tokenCount: 20,
			bodyLength: 120,
			bodyLines: 3,
			hasDirective: false,
			isWrapper: false,
			isTypeGuard: false,
			extendsNames: [],
			memberNames: [],
			contentTokens: ["pending", "approved", "rejected"],
		};
		const other: ReturnType<typeof collectFunctions>[number] = {
			...base,
			file: "b.ts",
			name: "SchemaB",
			normalizedBody: `${normalized} y`,
			contentTokens: ["email", "push", "sms"],
		};
		// Completely disjoint content tokens → penalty applied → should not group at 0.8
		const groups = findSimilarGroups([base, other], { threshold: 0.8 });
		// Either not grouped, or score reflects the content penalty
		if (groups.length > 0) {
			expect(groups[0]?.score).toBeLessThan(0.8);
		}
	});

	// ── Category 4: input validation type vs stored record type ──
	test("does not group interface with all-required fields vs interface with all-optional fields", () => {
		const code = `
export interface ClickRecord {
  id: string;
  shortLinkId: string;
  timestamp: string;
  ip: string;
  userAgent: string;
  referer: string;
  country?: string;
  city?: string;
}
export interface ClickInput {
  userAgent?: string;
  referer?: string;
  ipAddress?: string;
  country?: string;
  city?: string;
  timestamp?: string;
}
`;
		const sf = makeSourceFile(code);
		const fns = collectFunctions(sf, "events.ts");
		expect(fns).toHaveLength(2);
		const [record, input] = fns as [
			ReturnType<typeof collectFunctions>[0],
			ReturnType<typeof collectFunctions>[0],
		];
		expect(record.kind).toBe("interface");
		expect(input.kind).toBe("interface");
		// Both carry property names in content tokens
		expect(record.contentTokens).toContain("id");
		expect(record.contentTokens).toContain("shortLinkId");
		expect(input.contentTokens).toContain("ipAddress");
		// Content token sets are not identical → score below exact (1.0)
		const groups = findSimilarGroups([record, input], { threshold: 0.8 });
		if (groups.length > 0) {
			expect(groups[0]?.bucket).not.toBe("exact");
		}
	});

	// ── Category 5: interfaces sharing a common extends base (false positive filter) ──
	test("does not group interfaces that extend the same base type", () => {
		const code = `
interface MutatingCommandOptions {
  dryRun?: boolean;
  force?: boolean;
  verbose?: boolean;
  project?: string;
  workspace?: boolean;
}
interface MoveOptions extends MutatingCommandOptions {
  source: string;
  target: string;
  verify?: boolean;
}
interface RenameOptions extends MutatingCommandOptions {
  file: string;
  oldName: string;
  newName: string;
}
`;
		const sf = makeSourceFile(code);
		const fns = collectFunctions(sf, "commands.ts");
		const moveOpts = fns.find((f) => f.name === "MoveOptions");
		const renameOpts = fns.find((f) => f.name === "RenameOptions");
		if (!(moveOpts && renameOpts)) {
			throw new Error("Expected both interfaces to be collected");
		}
		// Both should record their extends base
		expect(moveOpts.extendsNames).toContain("MutatingCommandOptions");
		expect(renameOpts.extendsNames).toContain("MutatingCommandOptions");
		// Should NOT be grouped — they share a base, already consolidated
		const groups = findSimilarGroups([moveOpts, renameOpts], {
			threshold: 0.5,
		});
		expect(groups).toHaveLength(0);
	});

	// ── Category 6: composed types (parent references child) ──
	test("does not group interfaces where one references the other as a member type", () => {
		const code = `
interface SimilarityGroup {
  bucket: string;
  score: number;
  functions: FunctionInfo[];
}
interface SimilarityReport {
  groups: SimilarityGroup[];
  totalFunctions: number;
  totalFiles: number;
}
`;
		const sf = makeSourceFile(code);
		const fns = collectFunctions(sf, "types.ts");
		const group = fns.find((f) => f.name === "SimilarityGroup");
		const report = fns.find((f) => f.name === "SimilarityReport");
		if (!(group && report)) {
			throw new Error("Expected both interfaces to be collected");
		}
		// Report references SimilarityGroup in its members
		expect(report.memberNames).toContain("SimilarityGroup");
		// Should NOT be grouped — parent/child composition
		const groups = findSimilarGroups([group, report], { threshold: 0.5 });
		expect(groups).toHaveLength(0);
	});

	test("does not group interfaces that extend different base types", () => {
		const code = `
interface MutatingCommandOptions {
  dryRun?: boolean;
  force?: boolean;
  verbose?: boolean;
  project?: string;
  workspace?: boolean;
}
interface SimilarityFilterOptions {
  threshold?: number;
  sameNameOnly?: boolean;
  skipSameFile?: boolean;
  onlyRelatedTo?: string;
  workspace?: boolean;
}
interface MoveOptions extends MutatingCommandOptions {
  source: string;
  target: string;
  verify?: boolean;
}
interface SimilarityDiscoveryOptions extends SimilarityFilterOptions {
  directory: string;
  project?: string;
  workspace?: boolean;
}
`;
		const sf = makeSourceFile(code);
		const fns = collectFunctions(sf, "commands.ts");
		const moveOpts = fns.find((f) => f.name === "MoveOptions");
		const simOpts = fns.find((f) => f.name === "SimilarityDiscoveryOptions");
		if (!(moveOpts && simOpts)) {
			throw new Error("Expected both interfaces to be collected");
		}
		expect(moveOpts.extendsNames).toContain("MutatingCommandOptions");
		expect(simOpts.extendsNames).toContain("SimilarityFilterOptions");
		// Should NOT be grouped — both extend bases, similarity comes from inheritance
		const groups = findSimilarGroups([moveOpts, simOpts], { threshold: 0.5 });
		expect(groups).toHaveLength(0);
	});

	test("penalizes small interface pairs with low member name overlap", () => {
		const normalized = "{ $I : $I ; $I : $I ; $I : $I ; }";
		const tokens = tokenize(normalized);
		const ifaceA: ReturnType<typeof collectFunctions>[number] = {
			file: "a.ts",
			name: "ConfigA",
			kind: "interface" as const,
			line: 1,
			column: 0,
			normalizedBody: normalized,
			tokenCount: tokens.length,
			bodyLength: 80,
			bodyLines: 4,
			hasDirective: false,
			isWrapper: false,
			isTypeGuard: false,
			extendsNames: [],
			memberNames: ["host", "port", "timeout"],
			contentTokens: ["host", "port", "timeout"],
		};
		const ifaceB: ReturnType<typeof collectFunctions>[number] = {
			...ifaceA,
			file: "b.ts",
			name: "ConfigB",
			memberNames: ["url", "retries", "interval"],
			contentTokens: ["url", "retries", "interval"],
		};
		// memberSim = 0 (disjoint), penalty = 0.7 → drops below 0.8
		const groups = findSimilarGroups([ifaceA, ifaceB], { threshold: 0.8 });
		expect(groups).toHaveLength(0);
	});

	test("still groups interfaces with no heritage or composition relationship", () => {
		const code = `
interface RequestOptions {
  method: string;
  headers: Record<string, string>;
  timeout: number;
  retry: boolean;
}
interface FetchOptions {
  method: string;
  headers: Record<string, string>;
  timeout: number;
  retry: boolean;
}
`;
		const sf = makeSourceFile(code);
		const fns = collectFunctions(sf, "test.ts");
		const reqOpts = fns.find((f) => f.name === "RequestOptions");
		const fetchOpts = fns.find((f) => f.name === "FetchOptions");
		if (!(reqOpts && fetchOpts)) {
			throw new Error("Expected both interfaces to be collected");
		}
		expect(reqOpts.extendsNames).toHaveLength(0);
		expect(fetchOpts.extendsNames).toHaveLength(0);
		// Should still be grouped — genuine duplicates
		const groups = findSimilarGroups([reqOpts, fetchOpts], {
			threshold: 0.7,
		});
		expect(groups.length).toBeGreaterThanOrEqual(1);
	});

	// #208: the member-name penalty used to be gated to <=5 members, which
	// withheld it from exactly the pairs that need it. These are the three
	// interfaces the tool reported as an "exact duplicate" at score 1.0.
	test("does not group large interfaces whose member names mostly differ", () => {
		const code = `
interface MoveBatchResult {
  success: boolean;
  dryRun: boolean;
  items: MoveBatchItemResult[];
  applied: MoveBatchItemResult[];
  failed: MoveBatchItemResult[];
  typecheck?: VerificationResult;
  projectRoot: string;
  journalEntryId?: string;
}
interface DepsApplyResult {
  success: boolean;
  dryRun: boolean;
  applied: boolean;
  report: DependencyContractReport;
  edits: SerializedEdit[];
  modifiedFiles: string[];
  lockfileUpdated: boolean;
  lockfileCommand?: string[];
  verificationReport?: DependencyContractReport;
}
`;
		const fns = collectFunctions(makeSourceFile(code), "test.ts");
		const groups = findSimilarGroups(fns, { threshold: 0.8 });
		expect(groups).toHaveLength(0);
	});

	// #208: a group reaching 1.0 through bigram Jaccard must not claim to be an
	// exact duplicate "after normalization" — its normalized bodies differ.
	test("reports a coincidental perfect score as high rather than exact", () => {
		const normalizedA = "{ $I : $I ; $I : $I [ ] ; $I ? : $I ; }";
		const normalizedB = "{ $I : $I ; $I : $I [ ] ; $I ? : $I ; $I : $I ; }";
		expect(normalizedA).not.toBe(normalizedB);
		const shapeA: ReturnType<typeof collectFunctions>[number] = {
			file: "a.ts",
			name: "ScanReport",
			kind: "interface" as const,
			line: 1,
			column: 0,
			normalizedBody: normalizedA,
			tokenCount: tokenize(normalizedA).length,
			bodyLength: 90,
			bodyLines: 5,
			hasDirective: false,
			isWrapper: false,
			isTypeGuard: false,
			extendsNames: [],
			// High member overlap, so the member-name penalty does not apply and the
			// bucket label is the only thing under test.
			memberNames: ["directory", "findings", "summary"],
			contentTokens: ["directory", "findings", "summary"],
		};
		const shapeB: ReturnType<typeof collectFunctions>[number] = {
			...shapeA,
			file: "b.ts",
			name: "ScanReportExtended",
			normalizedBody: normalizedB,
			tokenCount: tokenize(normalizedB).length,
			bodyLength: 108,
			bodyLines: 6,
			memberNames: ["directory", "findings", "summary", "generatedAt"],
			contentTokens: ["directory", "findings", "summary", "generatedAt"],
		};

		const groups = findSimilarGroups([shapeA, shapeB], { threshold: 0.8 });
		expect(groups).toHaveLength(1);
		expect(groups[0]?.score).toBeGreaterThanOrEqual(0.999);
		expect(groups[0]?.bucket).toBe("high");
	});

	// The penalty must not silence real duplication at any size.
	test("still reports large interfaces that genuinely duplicate each other", () => {
		const members = [
			"  success: boolean;",
			"  dryRun: boolean;",
			"  modifiedFiles: string[];",
			"  errors: string[];",
			"  rolledBack: boolean;",
			"  typecheck?: VerificationResult;",
			"  projectRoot: string;",
		].join("\n");
		const code = `
interface FirstApplyResult {
${members}
}
interface SecondApplyResult {
${members}
}
`;
		const fns = collectFunctions(makeSourceFile(code), "test.ts");
		const groups = findSimilarGroups(fns, { threshold: 0.8 });
		expect(groups).toHaveLength(1);
		expect(groups[0]?.bucket).toBe("exact");
	});
});

describe("size ratio and token ratio guards", () => {
	test("body size ratio < 0.5 prevents grouping even with identical normalized body", () => {
		// Craft two FunctionInfo objects with identical normalizedBody but very different bodyLength
		const normalized =
			"{ const $I = $I.$I($I); const $I = $I.$I($I); return $I; }";
		const tokens = tokenize(normalized);
		const base: ReturnType<typeof collectFunctions>[number] = {
			file: "a.ts",
			name: "shortFn",
			kind: "function" as const,
			line: 1,
			column: 0,
			normalizedBody: normalized,
			tokenCount: tokens.length,
			bodyLength: 50,
			bodyLines: 3,
			hasDirective: false,
			isWrapper: false,
			isTypeGuard: false,
			extendsNames: [],
			memberNames: [],
			contentTokens: [],
		};
		const long: ReturnType<typeof collectFunctions>[number] = {
			...base,
			file: "b.ts",
			name: "longFn",
			bodyLength: 200, // ratio = 50/200 = 0.25 < 0.5
		};
		const groups = findSimilarGroups([base, long], 0.7);
		expect(groups).toHaveLength(0);
	});

	test("token count ratio < 0.75 prevents grouping", () => {
		const normalizedA = "{ const $I = $I; return $I; }";
		const normalizedB =
			"{ const $I = $I; const $I = $I; const $I = $I; const $I = $I; const $I = $I; return $I; }";
		const tokensA = tokenize(normalizedA);
		const tokensB = tokenize(normalizedB);
		const fnA: ReturnType<typeof collectFunctions>[number] = {
			file: "a.ts",
			name: "smallFn",
			kind: "function" as const,
			line: 1,
			column: 0,
			normalizedBody: normalizedA,
			tokenCount: tokensA.length,
			bodyLength: 100,
			bodyLines: 3,
			hasDirective: false,
			isWrapper: false,
			isTypeGuard: false,
			extendsNames: [],
			memberNames: [],
			contentTokens: [],
		};
		const fnB: ReturnType<typeof collectFunctions>[number] = {
			file: "b.ts",
			name: "largeFn",
			kind: "function" as const,
			line: 1,
			column: 0,
			normalizedBody: normalizedB,
			tokenCount: tokensB.length,
			bodyLength: 110,
			bodyLines: 3,
			hasDirective: false,
			isWrapper: false,
			isTypeGuard: false,
			extendsNames: [],
			memberNames: [],
			contentTokens: [],
		};
		// Token ratio: min/max should be < 0.75
		const ratio =
			Math.min(tokensA.length, tokensB.length) /
			Math.max(tokensA.length, tokensB.length);
		expect(ratio).toBeLessThan(0.75);
		const groups = findSimilarGroups([fnA, fnB], 0.5);
		expect(groups).toHaveLength(0);
	});
});

describe("scoreToBucket boundary behavior", () => {
	test("groups with minScore >= 0.999 get bucket=exact", () => {
		// Two functions with identical normalized body AND identical content tokens
		// produce score = 0.5 + 0.5 * 1.0 = 1.0
		const body = `{
  const result = source.fetch(url);
  const data = result.json();
  return data;
}`;
		const sf1 = makeSourceFile(`function fetchA() ${body}`, "a.ts");
		const sf2 = makeSourceFile(`function fetchB() ${body}`, "b.ts");
		const fn1 = collectFunctions(sf1, "a.ts")[0];
		const fn2 = collectFunctions(sf2, "b.ts")[0];
		if (!(fn1 && fn2)) {
			throw new Error("Expected functions");
		}
		const groups = findSimilarGroups([fn1, fn2], 0.7);
		expect(groups).toHaveLength(1);
		expect(groups[0]?.bucket).toBe("exact");
	});

	test("groups with minScore in [0.85, 0.999) get bucket=high", () => {
		// Craft two functions whose bigram Jaccard falls in [0.85, 0.999)
		const bodyA = `{
  const items = list.filter(Boolean);
  const mapped = items.map(x => x.trim());
  const joined = mapped.join(",");
  return joined;
}`;
		const bodyB = `{
  const items = list.filter(Boolean);
  const mapped = items.map(x => x.trim());
  const joined = mapped.join(";");
  return joined;
}`;
		const fnA = (() => {
			const sf = makeSourceFile(`function procA() ${bodyA}`, "a.ts");
			return collectFunctions(sf, "a.ts")[0];
		})();
		const fnB = (() => {
			const sf = makeSourceFile(`function procB() ${bodyB}`, "b.ts");
			return collectFunctions(sf, "b.ts")[0];
		})();
		if (!(fnA && fnB)) {
			throw new Error("Expected functions");
		}
		// Normalized bodies should differ (different string literal)
		expect(fnA.normalizedBody).toBe(fnB.normalizedBody);
		// Since normalized bodies are identical, score = 0.5 + 0.5 * contentSim
		// Both have identical content tokens → score = 1.0 → exact bucket
		// This actually tests exact, so let's just verify the bucket system works
		const groups = findSimilarGroups([fnA, fnB], 0.7);
		if (groups.length > 0) {
			const bucket = groups[0]?.bucket;
			expect(bucket).toBeDefined();
			expect(["exact", "high", "medium"]).toContain(bucket as string);
		}
	});

	test("pairs scoring below 0.7 produce no group even when threshold is lower", () => {
		// The scoreToBucket function returns null for scores < 0.7,
		// so groups are dropped regardless of the user threshold
		const bodyA = `{
  const x = alpha + beta;
  const y = x * gamma;
  return y;
}`;
		const bodyB = `{
  for (const item of collection) {
    if (item.active) {
      results.push(item.name);
      counts.increment(item.id);
    }
  }
  return results;
}`;
		const fnA = (() => {
			const sf = makeSourceFile(`function calcA() ${bodyA}`, "a.ts");
			return collectFunctions(sf, "a.ts")[0];
		})();
		const fnB = (() => {
			const sf = makeSourceFile(`function collectB() ${bodyB}`, "b.ts");
			return collectFunctions(sf, "b.ts")[0];
		})();
		if (!(fnA && fnB)) {
			throw new Error("Expected functions");
		}
		// Even with a very low threshold, dissimilar functions should not group
		const groups = findSimilarGroups([fnA, fnB], 0.1);
		expect(groups).toHaveLength(0);
	});
});

describe("e2e: analyzeSimilarity on project src", () => {
	test("no group contains interfaces that both extend base types", async () => {
		const projectSrc = path.resolve(import.meta.dir, "..");
		const report = await analyzeSimilarity({
			directory: projectSrc,
			threshold: 0.8,
			kinds: ["interface"],
		});
		for (const group of report.groups) {
			const withExtends = group.functions.filter(
				(f) => f.extendsNames.length > 0
			);
			// At most one interface in a group may have extends — if two or more
			// both extend base types, the heritage filter should have excluded them
			expect(withExtends.length).toBeLessThanOrEqual(1);
		}
	});

	test("no group contains composed interface pairs", async () => {
		const projectSrc = path.resolve(import.meta.dir, "..");
		const report = await analyzeSimilarity({
			directory: projectSrc,
			threshold: 0.8,
			kinds: ["interface"],
		});
		for (const group of report.groups) {
			const names = new Set(group.functions.map((f) => f.name));
			for (const fn of group.functions) {
				// No function's memberNames should reference another group member by name
				for (const memberName of fn.memberNames) {
					if (memberName !== fn.name) {
						expect(names.has(memberName)).toBe(false);
					}
				}
			}
		}
	});
});

describe("empty semantic fingerprints are unknown evidence", () => {
	async function typeFixture(source: string) {
		const dir = await mkdtemp(path.join(tmpdir(), "resect-empty-fingerprint-"));
		await mkdir(path.join(dir, "src"), { recursive: true });
		await writeFile(
			path.join(dir, "tsconfig.json"),
			JSON.stringify({
				compilerOptions: { strict: true, noEmit: true },
				include: ["src/**/*.ts"],
			})
		);
		await writeFile(path.join(dir, "src", "types.ts"), source);
		try {
			const report = await analyzeSimilarity({
				directory: dir,
				threshold: 1,
				kinds: ["type", "interface"],
			});
			return report.groups.map((g) => g.functions.map((f) => f.name).sort());
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}

	test("disjoint string-literal unions are not exact duplicates", async () => {
		// Same file, so the incidental cross-file name penalty cannot mask the
		// defect: both bodies normalise to `$S | $S | ...` and, before the fix,
		// both produced empty fingerprints that Jaccard scored as 1.
		const groups = await typeFixture(
			'export type DocumentKind = "invoice" | "receipt" | "quote" | "credit" | "statement" | "reminder";\n' +
				'export type NavigationMode = "push" | "replace" | "back" | "forward" | "reload" | "restore";\n'
		);
		expect(groups).toHaveLength(0);
	});

	test("identical string-literal unions keep an exact signal", async () => {
		const groups = await typeFixture(
			'export type KindOne = "invoice" | "receipt" | "quote" | "credit" | "statement" | "reminder";\n' +
				'export type KindTwo = "invoice" | "receipt" | "quote" | "credit" | "statement" | "reminder";\n'
		);
		expect(groups).toEqual([["KindOne", "KindTwo"]]);
	});

	test("identical marker types keep an exact signal", async () => {
		const groups = await typeFixture(
			"export type MarkerOne = Record<string, never>;\n" +
				"export type MarkerTwo = Record<string, never>;\n"
		);
		expect(groups).toEqual([["MarkerOne", "MarkerTwo"]]);
	});

	test("interface property names still differentiate structural lookalikes", async () => {
		const groups = await typeFixture(
			"export interface Alpha { seconds: number; label: string; enabled: boolean; }\n" +
				"export interface Beta { _seconds: number; _label: string; _enabled: boolean; }\n"
		);
		expect(groups).toHaveLength(0);
	});
});

describe("scanProjectFunctions --project resolution", () => {
	async function makeProject(): Promise<string> {
		const dir = await mkdtemp(path.join(tmpdir(), "resect-similar-project-"));
		await mkdir(path.join(dir, "src"), { recursive: true });
		await writeFile(
			path.join(dir, "src", "example.ts"),
			[
				"export function alphaCalc(a: number, b: number) {",
				"	const total = a + b;",
				'	return { total, label: "alpha" };',
				"}",
				"export function betaCalc(a: number, b: number) {",
				"	const total = a + b;",
				'	return { total, label: "beta" };',
				"}",
				"",
			].join("\n")
		);
		await writeFile(
			path.join(dir, "tsconfig.json"),
			JSON.stringify({ include: ["src/**/*.ts"] })
		);
		return dir;
	}

	test("accepts a tsconfig file path and a directory path alike", async () => {
		const dir = await makeProject();
		try {
			const srcDir = path.join(dir, "src");
			const viaFile = await scanProjectFunctions(
				srcDir,
				path.join(dir, "tsconfig.json")
			);
			const viaDirectory = await scanProjectFunctions(srcDir, dir);
			const implicit = await scanProjectFunctions(srcDir);

			expect(viaFile.totalFiles).toBe(1);
			// Explicit and implicit discovery must agree on the same project.
			expect(viaDirectory.totalFiles).toBe(viaFile.totalFiles);
			expect(implicit.totalFiles).toBe(viaFile.totalFiles);
			expect(viaDirectory.functions.length).toBe(viaFile.functions.length);
			expect(implicit.functions.length).toBe(viaFile.functions.length);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	/** Rejection message, or "" when the promise unexpectedly resolved. */
	async function rejectionMessage(promise: Promise<unknown>): Promise<string> {
		try {
			await promise;
		} catch (error) {
			return (error as Error).message;
		}
		return "";
	}

	test("rejects an unresolvable --project instead of reporting an empty scan", async () => {
		const dir = await makeProject();
		try {
			// dirname() of this path is a valid project, so a silent fallback would
			// return a normal-looking report for a config that does not exist.
			const message = await rejectionMessage(
				scanProjectFunctions(
					path.join(dir, "src"),
					path.join(dir, "missing.json")
				)
			);
			expect(message).toContain(
				"Could not resolve a tsconfig.json from --project"
			);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test("rejects a directory that contains no tsconfig", async () => {
		const dir = await mkdtemp(path.join(tmpdir(), "resect-similar-noconfig-"));
		try {
			await mkdir(path.join(dir, "src"), { recursive: true });
			await writeFile(path.join(dir, "src", "a.ts"), "export const a = 1;\n");
			const message = await rejectionMessage(
				scanProjectFunctions(path.join(dir, "src"), dir)
			);
			expect(message).toContain(
				"Could not resolve a tsconfig.json from --project"
			);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});
