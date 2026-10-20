import { expect, test } from "bun:test";
import type { FunctionInfo } from "../types/similar.ts";
import type { SimilarityFilterOptions } from "./similarity.ts";
import { collectFunctions, findSimilarGroups } from "./similarity.ts";
import { createSourceFileFromText } from "./source-file.ts";

function declarations(
	code: string,
	file = "/project/input.ts"
): FunctionInfo[] {
	return collectFunctions(createSourceFileFromText(file, code), file);
}

function mixedCorpus(): FunctionInfo[] {
	const result: FunctionInfo[] = [];
	for (let index = 0; index < 12; index++) {
		const source = `
export function loadItems(input) {
  const rows = input.load("kind${index % 3}");
  if (!rows) { return []; }
  return rows.map(row => row.id);
}
export function load_items(input) {
  const rows = input.load("kind${index % 4}");
  return rows.filter(row => row.enabled);
}
export function parseValue(input) { try { return JSON.parse(input); } catch { return null; } }
export function saveItems(input) { "use server"; return input.save(); }
export function isRecord(input): input is Record<string, unknown> { return typeof input === "object" && input !== null; }
export interface RecordInfo { id: string; name: string; value: number; }
export type RecordAlias = { id: string; name: string; value: number; };
export interface ChildInfo extends RecordInfo { extra: string; count: number; }
export interface Container { items: RecordInfo[]; total: number; }
export type Label = "kind${index % 3}" | "other${index % 4}";
`;
		result.push(...declarations(source, `/project/part${index}/input.ts`));
	}
	return result;
}

const FILTER_CASES: SimilarityFilterOptions[] = [
	{},
	{ sameNameOnly: true },
	{ nameThreshold: 0.5 },
	{ nameThreshold: 1 },
	{ sameNameOnly: true, nameThreshold: 1, skipSameFile: true },
	{
		kinds: ["function"],
		minLines: 3,
		skipWrappers: true,
		skipDirectives: true,
	},
	{ kinds: ["type", "interface"], onlyRelatedTo: "/project/part4" },
];

for (const threshold of [0, 0.02, 0.15, 0.2, 0.7, 0.8, 0.85, 0.999, 1]) {
	test(`sifting preserves mixed declarations and filters at threshold ${threshold}`, () => {
		const corpus = mixedCorpus();
		for (const options of FILTER_CASES) {
			expect(findSimilarGroups(corpus, { ...options, threshold })).toEqual(
				findSimilarGroups(corpus, {
					...options,
					threshold,
					exhaustiveScan: true,
				})
			);
		}
	});
}

test("same-name sifting avoids comparing unrelated names with identical syntax", () => {
	const corpus: FunctionInfo[] = [];
	for (let index = 0; index < 200; index++) {
		corpus.push(
			...declarations(`function unique${index}(x) { return x + x + 1; }`)
		);
	}
	corpus.push(
		...declarations(
			"function repeated(x) { return x + x + 1; }",
			"/project/a.ts"
		),
		...declarations(
			"function repeated(x) { return x + x + 1; }",
			"/project/b.ts"
		)
	);
	const stats = { candidatePairs: 0, scoredPairs: 0 };
	const groups = findSimilarGroups(corpus, { sameNameOnly: true, stats });
	expect(groups).toEqual(
		findSimilarGroups(corpus, { sameNameOnly: true, exhaustiveScan: true })
	);
	expect(groups).toHaveLength(1);
	expect(stats.candidatePairs).toBeLessThan(10);
});

test("prepared comparisons do not survive edits, additions, or removals between calls", () => {
	const corpus = declarations(`
function first(x) { return x + x + 1; }
function second(x) { return x + x + 1; }
`);
	expect(findSimilarGroups(corpus)).toHaveLength(1);
	const first = corpus[0];
	if (!first) {
		throw new Error("Missing test declaration");
	}
	first.normalizedBody = "while (true) { throw new Error($S); }";
	first.contentTokens = ["Error", "different"];
	expect(findSimilarGroups(corpus)).toEqual(
		findSimilarGroups(corpus, { exhaustiveScan: true })
	);
	expect(findSimilarGroups(corpus)).toHaveLength(0);
	corpus.push(...declarations("function third(x) { return x + x + 1; }"));
	expect(findSimilarGroups(corpus)).toHaveLength(1);
	corpus.splice(1, 1);
	expect(findSimilarGroups(corpus)).toHaveLength(0);
});

test("empty bigram sets and exact overlap boundaries agree with exhaustive scoring", () => {
	const seed = declarations("function seed(x) { return x + x + 1; }")[0];
	if (!seed) {
		throw new Error("Missing test declaration");
	}
	const bodies = [
		"",
		"a",
		"b",
		"a b c d e",
		"a b c d f",
		"a b c d e f",
		"a b c d e f g",
	];
	const corpus = bodies.flatMap((normalizedBody, index) => [
		{ ...seed, name: `item${index}`, normalizedBody, contentTokens: [] },
		{
			...seed,
			name: `item${index}`,
			normalizedBody,
			contentTokens: ["VALUE", "VALUE"],
		},
	]);
	for (const boundary of [0.2, 0.5, 2 / 3, 0.8, 1]) {
		for (const threshold of [
			boundary - Number.EPSILON,
			boundary,
			boundary + Number.EPSILON,
		]) {
			expect(findSimilarGroups(corpus, { threshold })).toEqual(
				findSimilarGroups(corpus, { threshold, exhaustiveScan: true })
			);
		}
	}
});
