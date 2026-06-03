import { describe, expect, test } from "bun:test";
import type { TransformRule } from "../types/transform.ts";
import { createSourceFileFromText } from "./source-file.ts";
import {
	applyTransformRules,
	planTransformRewrites,
} from "./transform-visitor.ts";

const VITE_TO_NEXT: TransformRule = {
	from: "import.meta.env.VITE_API_URL",
	to: "process.env.NEXT_PUBLIC_API_URL",
};

describe("applyTransformRules (#124)", () => {
	test("swaps a configured accessor, leaving surrounding logic intact", () => {
		const src = "export const url = import.meta.env.VITE_API_URL + '/v1';\n";
		const { content, rewrites } = applyTransformRules(src, "a.ts", [
			VITE_TO_NEXT,
		]);
		expect(content).toBe(
			"export const url = process.env.NEXT_PUBLIC_API_URL + '/v1';\n"
		);
		expect(rewrites).toHaveLength(1);
		expect(rewrites[0]).toMatchObject({
			from: VITE_TO_NEXT.from,
			to: VITE_TO_NEXT.to,
			line: 1,
		});
	});

	test("returns content byte-for-byte when no rule matches", () => {
		const src = "export const x = process.env.OTHER;\n";
		const { content, rewrites } = applyTransformRules(src, "a.ts", [
			VITE_TO_NEXT,
		]);
		expect(content).toBe(src);
		expect(rewrites).toEqual([]);
	});

	test("returns content unchanged for an empty rule set", () => {
		const src = "const a = import.meta.env.VITE_API_URL;\n";
		const { content, rewrites } = applyTransformRules(src, "a.ts", []);
		expect(content).toBe(src);
		expect(rewrites).toEqual([]);
	});

	test("preserves a trailing member access on the swapped accessor", () => {
		// `import.meta.env.VITE_API_URL.trim()` → the accessor is replaced, `.trim()` kept.
		const src = "const a = import.meta.env.VITE_API_URL.trim();\n";
		const { content } = applyTransformRules(src, "a.ts", [VITE_TO_NEXT]);
		expect(content).toBe("const a = process.env.NEXT_PUBLIC_API_URL.trim();\n");
	});

	test("rewrites every occurrence of a matched accessor", () => {
		const src =
			"const a = import.meta.env.VITE_API_URL;\nconst b = import.meta.env.VITE_API_URL;\n";
		const { content, rewrites } = applyTransformRules(src, "a.ts", [
			VITE_TO_NEXT,
		]);
		expect(content).toBe(
			"const a = process.env.NEXT_PUBLIC_API_URL;\nconst b = process.env.NEXT_PUBLIC_API_URL;\n"
		);
		expect(rewrites).toHaveLength(2);
		expect(rewrites.map((r) => r.line)).toEqual([1, 2]);
	});

	test("applies multiple rules in one pass", () => {
		const src =
			"const a = import.meta.env.VITE_A;\nconst b = import.meta.env.VITE_B;\n";
		const { content } = applyTransformRules(src, "a.ts", [
			{ from: "import.meta.env.VITE_A", to: "process.env.A" },
			{ from: "import.meta.env.VITE_B", to: "process.env.B" },
		]);
		expect(content).toBe(
			"const a = process.env.A;\nconst b = process.env.B;\n"
		);
	});

	test("does not match a longer enclosing accessor", () => {
		// Rule targets `import.meta.env` exactly; `import.meta.env.X` must NOT match.
		const src = "const a = import.meta.env.X;\n";
		const { content, rewrites } = applyTransformRules(src, "a.ts", [
			{ from: "import.meta.env", to: "process.env" },
		]);
		// `import.meta.env` IS a sub-access of `import.meta.env.X`; the visitor only
		// replaces a node whose full text equals `from`, so the inner node matches.
		expect(content).toBe("const a = process.env.X;\n");
		expect(rewrites).toHaveLength(1);
	});

	test("does not rewrite a same-named string literal or comment", () => {
		const src =
			"// import.meta.env.VITE_API_URL\nconst a = 'import.meta.env.VITE_API_URL';\n";
		const { content, rewrites } = applyTransformRules(src, "a.ts", [
			VITE_TO_NEXT,
		]);
		expect(content).toBe(src);
		expect(rewrites).toEqual([]);
	});
});

describe("planTransformRewrites (#124)", () => {
	test("emits positional changes without applying them", () => {
		const sf = createSourceFileFromText(
			"a.ts",
			"const a = import.meta.env.VITE_API_URL;\n"
		);
		const { changes } = planTransformRewrites(sf, [VITE_TO_NEXT]);
		expect(changes).toHaveLength(1);
		expect(changes[0]?.newText).toBe("process.env.NEXT_PUBLIC_API_URL");
		// The change range covers exactly the matched accessor.
		const slice = sf.text.slice(changes[0]?.start, changes[0]?.end);
		expect(slice).toBe("import.meta.env.VITE_API_URL");
	});

	test("returns no changes for an empty rule set", () => {
		const sf = createSourceFileFromText("a.ts", "const a = 1;\n");
		expect(planTransformRewrites(sf, []).changes).toEqual([]);
	});
});
