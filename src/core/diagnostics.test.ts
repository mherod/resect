import { describe, expect, test } from "bun:test";
import { diffDiagnostics, parseDiagnosticLine } from "./diagnostics.ts";

describe("parseDiagnosticLine", () => {
	test("parses a per-file diagnostic", () => {
		const result = parseDiagnosticLine(
			'src/foo.ts(12,5): error TS2307: Cannot find module "./bar".'
		);
		expect(result).toEqual({
			file: "src/foo.ts",
			code: "TS2307",
			message: 'Cannot find module "./bar".',
		});
	});

	test("parses a global diagnostic with no file", () => {
		const result = parseDiagnosticLine(
			"error TS2688: Cannot find type definition file for 'jest'."
		);
		expect(result).toEqual({
			file: null,
			code: "TS2688",
			message: "Cannot find type definition file for 'jest'.",
		});
	});

	test("returns null for unparseable lines", () => {
		expect(
			parseDiagnosticLine("VERIFY_INCOMPLETE: tsc exited with code 1")
		).toBe(null);
	});
});

describe("diffDiagnostics", () => {
	test("does not report a shifted-coordinate pre-existing error as new (#128)", () => {
		const before = [
			'src/foo.ts(10,5): error TS2307: Cannot find module "./bar".',
		];
		const after = [
			// Same file, code, and message — only the line/column shifted because
			// an unrelated edit inserted lines above it.
			'src/foo.ts(14,5): error TS2307: Cannot find module "./bar".',
		];

		const { newErrors, fixedErrors } = diffDiagnostics(before, after);

		expect(newErrors).toEqual([]);
		expect(fixedErrors).toEqual([]);
	});

	test("reports a genuinely new error", () => {
		const before: string[] = [];
		const after = ['src/foo.ts(1,1): error TS2304: Cannot find name "Foo".'];

		const { newErrors, fixedErrors } = diffDiagnostics(before, after);

		expect(newErrors).toEqual(after);
		expect(fixedErrors).toEqual([]);
	});

	test("reports a genuinely fixed error", () => {
		const before = ['src/foo.ts(1,1): error TS2304: Cannot find name "Foo".'];
		const after: string[] = [];

		const { newErrors, fixedErrors } = diffDiagnostics(before, after);

		expect(newErrors).toEqual([]);
		expect(fixedErrors).toEqual(before);
	});

	test("translates a moved file's pre-existing error to its destination path (#128)", () => {
		const before = [
			'src/old/foo.ts(10,5): error TS2307: Cannot find module "./bar".',
		];
		const after = [
			'src/new/foo.ts(10,5): error TS2307: Cannot find module "./bar".',
		];

		const { newErrors, fixedErrors } = diffDiagnostics(before, after, {
			translateBeforeFile: (file) =>
				file === "src/old/foo.ts" ? "src/new/foo.ts" : file,
		});

		expect(newErrors).toEqual([]);
		expect(fixedErrors).toEqual([]);
	});

	test("without translation, a moved file's pre-existing error is (still) treated as new", () => {
		const before = [
			'src/old/foo.ts(10,5): error TS2307: Cannot find module "./bar".',
		];
		const after = [
			'src/new/foo.ts(10,5): error TS2307: Cannot find module "./bar".',
		];

		const { newErrors, fixedErrors } = diffDiagnostics(before, after);

		expect(newErrors).toEqual(after);
		expect(fixedErrors).toEqual(before);
	});

	test("resolveFile normalizes relative paths before comparison", () => {
		const before = [
			'./foo.ts(10,5): error TS2307: Cannot find module "./bar".',
		];
		const after = ['foo.ts(10,5): error TS2307: Cannot find module "./bar".'];

		const { newErrors, fixedErrors } = diffDiagnostics(before, after, {
			resolveFile: (file) => file.replace(/^\.\//, ""),
		});

		expect(newErrors).toEqual([]);
		expect(fixedErrors).toEqual([]);
	});

	test("preserves unparseable lines (e.g. VERIFY_INCOMPLETE marker) via raw comparison", () => {
		const marker = "VERIFY_INCOMPLETE: tsc exited with code 1";
		const before: string[] = [];
		const after = [marker];

		const { newErrors } = diffDiagnostics(before, after);

		expect(newErrors).toEqual([marker]);
	});
});
