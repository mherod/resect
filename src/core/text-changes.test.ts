import { describe, expect, test } from "bun:test";
import {
	applyStructuredEdits,
	applyTextChanges,
	createStructuredEdit,
	deduplicateChanges,
	formatUnifiedDiff,
	type StructuredEdit,
	serializeStructuredEdits,
	type TextChange,
} from "./text-changes.ts";

describe("applyTextChanges", () => {
	test("returns content unchanged when changes array is empty", () => {
		expect(applyTextChanges("hello world", [])).toBe("hello world");
	});

	test("applies a single replacement", () => {
		// "hello world" → replace "world" (positions 6-11) with "there"
		const changes: TextChange[] = [{ start: 6, end: 11, newText: "there" }];
		expect(applyTextChanges("hello world", changes)).toBe("hello there");
	});

	test("applies a single deletion (empty newText)", () => {
		// "hello world" → delete " world" (positions 5-11)
		const changes: TextChange[] = [{ start: 5, end: 11, newText: "" }];
		expect(applyTextChanges("hello world", changes)).toBe("hello");
	});

	test("applies a single insertion (start === end)", () => {
		// "helloworld" → insert " " at position 5
		const changes: TextChange[] = [{ start: 5, end: 5, newText: " " }];
		expect(applyTextChanges("helloworld", changes)).toBe("hello world");
	});

	test("applies multiple non-overlapping changes in correct order", () => {
		// Replace "foo" and "baz" in "foo bar baz"
		const content = "foo bar baz";
		const changes: TextChange[] = [
			{ start: 0, end: 3, newText: "one" }, // foo -> one
			{ start: 8, end: 11, newText: "three" }, // baz -> three
		];
		expect(applyTextChanges(content, changes)).toBe("one bar three");
	});

	test("applies changes regardless of input order (sorts descending)", () => {
		const content = "foo bar baz";
		// Provide changes in ascending order — function should still apply correctly
		const changes: TextChange[] = [
			{ start: 8, end: 11, newText: "three" }, // baz -> three
			{ start: 0, end: 3, newText: "one" }, // foo -> one
		];
		expect(applyTextChanges(content, changes)).toBe("one bar three");
	});

	test("replaces an entire import specifier", () => {
		const content = `import { Foo } from "../old/path";`;
		// Replace "../old/path" (positions 20-32)
		const specifierStart = content.indexOf('"');
		const specifierEnd = content.lastIndexOf('"') + 1;
		const changes: TextChange[] = [
			{
				start: specifierStart,
				end: specifierEnd,
				newText: '"@/new/path"',
			},
		];
		const result = applyTextChanges(content, changes);
		expect(result).toBe(`import { Foo } from "@/new/path";`);
	});

	test("handles changes at the start of the string", () => {
		const changes: TextChange[] = [{ start: 0, end: 0, newText: "// " }];
		expect(applyTextChanges("const x = 1;", changes)).toBe("// const x = 1;");
	});

	test("handles changes at the end of the string", () => {
		const content = "const x = 1;";
		const changes: TextChange[] = [
			{ start: content.length, end: content.length, newText: "\n" },
		];
		expect(applyTextChanges(content, changes)).toBe("const x = 1;\n");
	});

	test("does not mutate the original changes array", () => {
		const changes: TextChange[] = [
			{ start: 6, end: 11, newText: "there" },
			{ start: 0, end: 5, newText: "goodbye" },
		];
		const originalOrder = changes.map((c) => c.start);
		applyTextChanges("hello world", changes);
		// The function sorts a copy; original array order should be unchanged
		expect(changes.map((c) => c.start)).toEqual(originalOrder);
	});
});

describe("deduplicateChanges", () => {
	test("returns empty array for empty input", () => {
		expect(deduplicateChanges([])).toEqual([]);
	});

	test("returns all changes when none are duplicates", () => {
		const changes: TextChange[] = [
			{ start: 0, end: 5, newText: "foo" },
			{ start: 6, end: 11, newText: "bar" },
		];
		expect(deduplicateChanges(changes)).toHaveLength(2);
	});

	test("removes exact duplicate positions", () => {
		const changes: TextChange[] = [
			{ start: 0, end: 5, newText: "first" },
			{ start: 0, end: 5, newText: "second" },
		];
		const result = deduplicateChanges(changes);
		expect(result).toHaveLength(1);
		expect(result[0]?.newText).toBe("first");
	});

	test("keeps changes that share start but differ on end", () => {
		const changes: TextChange[] = [
			{ start: 0, end: 5, newText: "foo" },
			{ start: 0, end: 10, newText: "bar" },
		];
		expect(deduplicateChanges(changes)).toHaveLength(2);
	});

	test("keeps changes that share end but differ on start", () => {
		const changes: TextChange[] = [
			{ start: 0, end: 10, newText: "foo" },
			{ start: 5, end: 10, newText: "bar" },
		];
		expect(deduplicateChanges(changes)).toHaveLength(2);
	});

	test("preserves order of non-duplicate changes", () => {
		const changes: TextChange[] = [
			{ start: 10, end: 15, newText: "c" },
			{ start: 0, end: 5, newText: "a" },
			{ start: 5, end: 10, newText: "b" },
		];
		const result = deduplicateChanges(changes);
		expect(result.map((c) => c.newText)).toEqual(["c", "a", "b"]);
	});

	test("handles multiple duplicates of the same position", () => {
		const changes: TextChange[] = [
			{ start: 0, end: 5, newText: "first" },
			{ start: 0, end: 5, newText: "second" },
			{ start: 0, end: 5, newText: "third" },
		];
		const result = deduplicateChanges(changes);
		expect(result).toHaveLength(1);
		expect(result[0]?.newText).toBe("first");
	});
});

describe("structured edit previews", () => {
	test("creates a line-aligned edit that reproduces the final content", () => {
		const before = "const first = 1;\nconst second = 2;\n";
		const after = "const first = 1;\nconst renamed = 2;\n";
		const edit = createStructuredEdit("src/example.ts", before, after);

		expect(edit as Omit<StructuredEdit, "line"> | undefined).toEqual({
			file: "src/example.ts",
			start: 17,
			end: 35,
			oldText: "const second = 2;\n",
			newText: "const renamed = 2;\n",
		});
		expect(edit?.line).toBe(2);
		expect(applyStructuredEdits(before, edit ? [edit] : [])).toBe(after);
	});

	test("returns no edit when the content is unchanged", () => {
		expect(
			createStructuredEdit("src/example.ts", "same", "same")
		).toBeUndefined();
	});

	test("rejects a structured edit when its old text is stale", () => {
		const edit: StructuredEdit = {
			file: "src/example.ts",
			start: 0,
			end: 3,
			line: 1,
			oldText: "old",
			newText: "new",
		};

		expect(() => applyStructuredEdits("different", [edit])).toThrow(
			"does not match the original content"
		);
	});

	test("formats replacements and missing final newlines as unified hunks", () => {
		const edit = createStructuredEdit(
			"src/example.ts",
			"const value = 1;",
			"const value = 2;"
		);

		expect(formatUnifiedDiff(edit ? [edit] : [])).toBe(
			[
				"--- a/src/example.ts",
				"+++ b/src/example.ts",
				"@@ -1,1 +1,1 @@",
				"-const value = 1;",
				"\\ No newline at end of file",
				"+const value = 2;",
				"\\ No newline at end of file",
			].join("\n")
		);
	});

	test("formats line insertions and deletions as unified hunks", () => {
		const insertion = createStructuredEdit(
			"src/example.ts",
			"first\n",
			"first\nsecond\n"
		);
		const deletion = createStructuredEdit(
			"src/example.ts",
			"first\nsecond\n",
			"first\n"
		);

		expect(formatUnifiedDiff(insertion ? [insertion] : [])).toBe(
			[
				"--- a/src/example.ts",
				"+++ b/src/example.ts",
				"@@ -2,0 +2,1 @@",
				"+second",
			].join("\n")
		);
		expect(formatUnifiedDiff(deletion ? [deletion] : [])).toBe(
			[
				"--- a/src/example.ts",
				"+++ b/src/example.ts",
				"@@ -2,1 +2,0 @@",
				"-second",
			].join("\n")
		);
	});

	test("handles a change at offset zero when the file starts with a newline", () => {
		const edit = createStructuredEdit("src/example.ts", "\nvalue\n", "value\n");

		expect(edit?.start).toBe(0);
		expect(edit?.line).toBe(1);
		expect(applyStructuredEdits("\nvalue\n", edit ? [edit] : [])).toBe(
			"value\n"
		);
	});

	test("serializes only the stable five-field public schema", () => {
		const edit = createStructuredEdit(
			"/project/src/example.ts",
			"const value = 1;\n",
			"const value = 2;\n"
		);

		expect(
			serializeStructuredEdits(edit ? [edit] : [], (file) =>
				file.replace("/project/", "")
			)
		).toEqual([
			{
				file: "src/example.ts",
				start: 0,
				end: 17,
				oldText: "const value = 1;\n",
				newText: "const value = 2;\n",
			},
		]);
	});
});
