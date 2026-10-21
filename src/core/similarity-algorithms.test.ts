import { describe, expect, test } from "bun:test";
import {
	camelCaseTokenize,
	countTokens,
	extractContentTokens,
	fingerprintTokens,
	jaccardSetSimilarity,
	jaccardSimilarity,
	jaccardSortedTokens,
	nameSimilarity,
	normalizeBody,
	tokenBigrams,
	tokenize,
} from "./similarity-algorithms";

test("streamed fingerprints match materialized tokens across repeated calls and large bodies", () => {
	const bodies = [
		"",
		" \n\t",
		"$I",
		"{ return $I.$I($S, $N); }",
		"foo_2 $$ $ISN 123.45 => === ?. é 😀",
		"{ const $I = $N; return $I + $I; }\n".repeat(20_000),
	];
	for (const body of [...bodies, ...bodies.toReversed()]) {
		const tokens = tokenize(body);
		expect(countTokens(body)).toBe(tokens.length);
		expect(fingerprintTokens(body)).toEqual({
			tokenCount: tokens.length,
			bigrams: new Set(tokenBigrams(tokens)),
		});
		expect(tokenize(body)).toEqual(tokens);
	}
});

describe("jaccardSimilarity", () => {
	test("compact sorted token IDs preserve exact set scores", () => {
		const inputs = [[], [0], [0, 1, 9], [1, 2], [0, 1, 2, 3], [4_294_967_295]];
		for (const a of inputs) {
			for (const b of inputs) {
				expect(
					jaccardSortedTokens(Uint32Array.from(a), Uint32Array.from(b))
				).toBe(jaccardSimilarity(a.map(String), b.map(String)));
			}
		}
	});
	test("prepared sets preserve exact scores for duplicates, empty inputs, and unequal sizes", () => {
		const inputs = [
			[],
			["a"],
			["a", "a", "b"],
			["b", "c"],
			["a", "b", "c", "d"],
		];
		for (const a of inputs) {
			for (const b of inputs) {
				const union = new Set([...a, ...b]);
				const intersection = [...new Set(a)].filter((token) =>
					b.includes(token)
				);
				const expected =
					union.size === 0 ? 1 : intersection.length / union.size;
				expect(jaccardSetSimilarity(new Set(a), new Set(b))).toBe(expected);
				expect(jaccardSimilarity(a, b)).toBe(expected);
			}
		}
	});

	test("identical sets return 1.0", () => {
		expect(jaccardSimilarity(["a", "b", "c"], ["a", "b", "c"])).toBe(1);
	});

	test("disjoint sets return 0.0", () => {
		expect(jaccardSimilarity(["a", "b"], ["c", "d"])).toBe(0);
	});

	test("partial overlap computes correct ratio", () => {
		// intersection={b}, union={a,b,c} → 1/3
		expect(jaccardSimilarity(["a", "b"], ["b", "c"])).toBeCloseTo(1 / 3, 5);
	});

	test("two empty arrays return 1.0", () => {
		expect(jaccardSimilarity([], [])).toBe(1);
	});

	test("one empty, one non-empty returns 0.0", () => {
		expect(jaccardSimilarity([], ["a"])).toBe(0);
	});

	test("treats array as set (duplicates do not inflate score)", () => {
		// ["a","a","b"] treated as {"a","b"} — same as ["a","b"]
		expect(jaccardSimilarity(["a", "a", "b"], ["a", "b"])).toBe(1);
	});
});

describe("tokenBigrams", () => {
	test("empty array yields no bigrams", () => {
		expect(tokenBigrams([])).toEqual([]);
	});

	test("single token yields no bigrams", () => {
		expect(tokenBigrams(["a"])).toEqual([]);
	});

	test("two tokens yield one bigram", () => {
		expect(tokenBigrams(["a", "b"])).toEqual(["a b"]);
	});

	test("three tokens yield two bigrams", () => {
		expect(tokenBigrams(["a", "b", "c"])).toEqual(["a b", "b c"]);
	});

	test("bigrams preserve order (not commutative)", () => {
		const fwd = tokenBigrams(["x", "y"]);
		const rev = tokenBigrams(["y", "x"]);
		expect(fwd).not.toEqual(rev);
	});
});

describe("nameSimilarity", () => {
	test("identical names return 1.0", () => {
		expect(nameSimilarity("formatDate", "formatDate")).toBe(1);
	});

	test("completely different names return 0.0", () => {
		expect(nameSimilarity("formatDate", "parseXml")).toBe(0);
	});

	test("partial overlap returns intermediate score", () => {
		// formatDate: [format, date], formatTime: [format, time] → 1/3
		const score = nameSimilarity("formatDate", "formatTime");
		expect(score).toBeGreaterThan(0);
		expect(score).toBeLessThan(1);
	});

	test("names sharing all tokens score 1.0 regardless of case convention", () => {
		// "make_temp_dir" and "makeTempDir" both tokenize to [make, temp, dir]
		expect(nameSimilarity("make_temp_dir", "makeTempDir")).toBe(1);
	});
});

describe("camelCaseTokenize", () => {
	test("splits camelCase correctly", () => {
		expect(camelCaseTokenize("makeTempDir")).toEqual(["make", "temp", "dir"]);
	});

	test("splits PascalCase with adjacent uppercase run", () => {
		expect(camelCaseTokenize("XMLParser")).toEqual(["xml", "parser"]);
	});

	test("single word returns single token", () => {
		expect(camelCaseTokenize("fetch")).toEqual(["fetch"]);
	});

	test("snake_case splits on underscores", () => {
		expect(camelCaseTokenize("make_temp_dir")).toEqual(["make", "temp", "dir"]);
	});
});

describe("normalizeBody", () => {
	test("replaces identifiers with $I", () => {
		const result = normalizeBody("{ return foo; }");
		expect(result).toContain("$I");
		expect(result).not.toContain("foo");
	});

	test("preserves keywords", () => {
		const result = normalizeBody("{ return foo; }");
		expect(result).toContain("return");
	});

	test("replaces string literals with $S", () => {
		const result = normalizeBody('{ return "hello"; }');
		expect(result).toContain("$S");
		expect(result).not.toContain("hello");
	});

	test("replaces numeric literals with $N", () => {
		const result = normalizeBody("{ return 42; }");
		expect(result).toContain("$N");
		expect(result).not.toContain("42");
	});

	test("strips line comments", () => {
		const result = normalizeBody("{ // comment\nreturn x; }");
		expect(result).not.toContain("comment");
	});

	test("two structurally identical functions normalize identically", () => {
		const a = normalizeBody("{ const x = a + b; return x; }");
		const b = normalizeBody("{ const y = p + q; return y; }");
		expect(a).toBe(b);
	});
});

describe("tokenize", () => {
	test("splits normalized body into tokens", () => {
		const tokens = tokenize("return $I ;");
		expect(tokens).toContain("return");
		expect(tokens).toContain("$I");
		expect(tokens).toContain(";");
	});

	test("handles placeholders as single tokens", () => {
		const tokens = tokenize("$I $S $N");
		expect(tokens).toEqual(["$I", "$S", "$N"]);
	});

	test("empty string returns empty array", () => {
		expect(tokenize("")).toEqual([]);
	});
});

describe("extractContentTokens", () => {
	test("extracts uppercase identifiers", () => {
		const tokens = extractContentTokens("{ return MY_CONST; }");
		expect(tokens).toContain("MY_CONST");
	});

	test("extracts string literal values", () => {
		const tokens = extractContentTokens('{ return "hello"; }');
		expect(tokens).toContain("hello");
	});

	test("does not extract lowercase identifiers", () => {
		const tokens = extractContentTokens("{ return myVar; }");
		expect(tokens).not.toContain("myVar");
	});

	test("strips comments before extracting", () => {
		const tokens = extractContentTokens(
			"{ /* COMMENTED_OUT */ return REAL_VALUE; }"
		);
		expect(tokens).not.toContain("COMMENTED_OUT");
		expect(tokens).toContain("REAL_VALUE");
	});
});
