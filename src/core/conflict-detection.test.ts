import { describe, expect, test } from "bun:test";
import {
	checkAllConflicts,
	checkBindingConflicts,
	findLocalBinding,
} from "./conflict-detection.ts";
import { createSourceFileFromText } from "./source-file.ts";

test("moving an import preserves nested shadowing while rename still detects capture", () => {
	const sourceFile = createSourceFileFromText(
		"consumer.ts",
		[
			'import { dispose } from "./lifecycle";',
			"class Store { add() { const dispose = () => {}; dispose(); } }",
			"function another() { function dispose() {} dispose(); }",
			"{ const dispose = 1; console.log(dispose); }",
		].join("\n")
	);
	const importingFiles = [
		{ sourceFile, specifier: "./lifecycle", bindings: [{ name: "dispose" }] },
	];
	expect(checkBindingConflicts(importingFiles, new Set(["dispose"]))).toEqual({
		hasConflict: false,
		conflicts: [],
	});
	expect(
		checkAllConflicts({
			importingFiles,
			exportNames: ["dispose"],
			skipImportedName: "dispose",
		}).hasConflict
	).toBe(true);
});

describe("findLocalBinding", () => {
	test("returns accurate line and column for variable declaration", () => {
		const sf = createSourceFileFromText(
			"test.ts",
			["const foo = 1;", "const bar = 2;", "const baz = 3;"].join("\n")
		);
		const result = findLocalBinding(sf, "bar", "");
		expect(result).not.toBeNull();
		expect(result?.line).toBe(2);
		expect(result?.column).toBe(6);
	});

	test("returns accurate position for function declaration", () => {
		const sf = createSourceFileFromText(
			"test.ts",
			["const x = 1;", "function doWork() {}"].join("\n")
		);
		const result = findLocalBinding(sf, "doWork", "");
		expect(result).not.toBeNull();
		expect(result?.line).toBe(2);
	});

	test("returns null when binding does not exist", () => {
		const sf = createSourceFileFromText("test.ts", "const foo = 1;");
		const result = findLocalBinding(sf, "bar", "");
		expect(result).toBeNull();
	});
});

describe("checkBindingConflicts", () => {
	test("reports accurate line/column for binding conflicts", () => {
		const sf = createSourceFileFromText(
			"consumer.ts",
			[
				'import { other } from "./other";',
				"const existing = 1;",
				"export const unrelated = 2;",
			].join("\n")
		);

		const result = checkBindingConflicts(
			[
				{
					sourceFile: sf,
					specifier: "./source",
					bindings: [{ name: "existing" }],
				},
			],
			new Set(["existing"])
		);

		expect(result.hasConflict).toBe(true);
		expect(result.conflicts).toHaveLength(1);
		expect(result.conflicts[0]?.name).toBe("existing");
		expect(result.conflicts[0]?.line).toBe(2);
		expect(result.conflicts[0]?.line).toBeGreaterThan(0);
		expect(result.conflicts[0]?.file).toBe("consumer.ts");
	});
});
