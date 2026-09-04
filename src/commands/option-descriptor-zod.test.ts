import { expect, test } from "bun:test";
import { z } from "zod";
import type { OptionDescriptor } from "./command-descriptor.ts";
import { toZodShape } from "./option-descriptor-zod.ts";
import { FIND_TYPES } from "./option-domains.ts";

const INPUTS = [
	{
		name: "force",
		key: "force",
		type: "boolean",
		mcp: { description: "Force" },
	},
	{
		name: "project",
		key: "project",
		type: "string",
		mcp: { required: true, description: "Project" },
	},
	{
		name: "threshold",
		key: "threshold",
		type: "number",
		min: 0,
		max: 1,
		integer: true,
		default: 1,
		mcp: { description: (value) => `Threshold ${String(value)}` },
	},
	{
		name: "type",
		key: "kind",
		type: "enum",
		domain: FIND_TYPES,
		mcp: { description: "Kind" },
	},
	{
		name: "ignore",
		key: "ignore",
		type: "string",
		multiple: true,
		mcp: { description: "Ignored" },
	},
	{ name: "json", key: "json", type: "boolean" },
] as const satisfies readonly OptionDescriptor[];

test("zod generator preserves scalar types, enum domains and requiredness", () => {
	const shape = toZodShape(INPUTS);
	const schema = z.object(shape);
	const output: {
		project: string;
		force?: boolean;
		threshold?: number;
		kind?: (typeof FIND_TYPES)[number];
		ignore?: string[];
	} = schema.parse({
		project: ".",
		force: false,
		threshold: 0,
		kind: "file",
		ignore: ["test"],
	});
	expect(output).toEqual({
		project: ".",
		force: false,
		threshold: 0,
		kind: "file",
		ignore: ["test"],
	});
	expect(schema.safeParse({}).success).toBeFalse();
	expect(schema.parse({ project: "." })).toEqual({ project: "." });
	expect(Object.keys(shape)).toEqual([
		"force",
		"project",
		"threshold",
		"kind",
		"ignore",
	]);
	expect(shape.threshold.description).toBe("Threshold 1");
	expect(shape.project.description).toBe("Project");
});

test("zod generator rejects wrong scalar, repeated-value and enum inputs", () => {
	const schema = z.object(toZodShape(INPUTS));
	for (const invalid of [
		{ project: false },
		{ force: "true" },
		{ threshold: "0" },
		{ threshold: Number.NaN },
		{ threshold: Number.POSITIVE_INFINITY },
		{ kind: "unknown" },
		{ ignore: "test" },
		{ ignore: [1] },
	]) {
		expect(schema.safeParse({ project: ".", ...invalid }).success).toBeFalse();
	}
});

test("MCP does not silently inherit CLI numeric bounds or defaults", () => {
	const schema = z.object(toZodShape(INPUTS));
	expect(schema.parse({ project: "." })).not.toHaveProperty("threshold");
	expect(schema.parse({ project: ".", threshold: -2.5 }).threshold).toBe(-2.5);
	expect(schema.parse({ project: ".", threshold: 5 }).threshold).toBe(5);
});

test("zod generator supports repeated numbers and enums", () => {
	const schema = z.object(
		toZodShape([
			{
				name: "threshold",
				key: "numbers",
				type: "number",
				multiple: true,
				mcp: { required: true, description: "Numbers" },
			},
			{
				name: "type",
				key: "kinds",
				type: "enum",
				domain: FIND_TYPES,
				multiple: true,
				mcp: { description: "Kinds" },
			},
		])
	);
	expect(schema.parse({ numbers: [], kinds: ["file", "export"] })).toEqual({
		numbers: [],
		kinds: ["file", "export"],
	});
	expect(schema.safeParse({ numbers: ["1"] }).success).toBeFalse();
	expect(
		schema.safeParse({ numbers: [1], kinds: ["wrong"] }).success
	).toBeFalse();
});

test("zod generator handles empty input and refuses duplicate exposed keys", () => {
	expect(toZodShape([])).toEqual({});
	expect(toZodShape([{ name: "json", key: "json", type: "boolean" }])).toEqual(
		{}
	);
	expect(() => toZodShape([INPUTS[0], INPUTS[0]])).toThrow(
		"Duplicate MCP input key: force"
	);
});
