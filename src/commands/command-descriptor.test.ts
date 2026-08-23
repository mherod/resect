import { describe, expect, test } from "bun:test";
import {
	AUDIT_OPTION_DEFAULTS,
	AUDIT_OPTION_DESCRIPTORS,
	type OptionDescriptor,
	toFlagSpec,
	toRegistryOptions,
} from "./command-descriptor.ts";
import { COMMAND_SPECS } from "./command-spec.ts";
import { PREFER_STRATEGIES } from "./option-domains.ts";
import { type CliValues, OPTION_FLAGS } from "./option-flags.ts";

const CONTRACT_DESCRIPTORS = [
	{ name: "help", key: "enabled", type: "boolean" },
	{ name: "project", key: "rootDir", type: "string", short: "p" },
	{
		name: "rename-specifier",
		key: "renames",
		type: "string",
		multiple: true,
	},
	{
		name: "prefer",
		key: "strategy",
		type: "enum",
		domain: PREFER_STRATEGIES,
	},
	{
		name: "threshold",
		key: "threshold",
		type: "number",
		min: 0,
		max: 1,
	},
	{
		name: "group",
		key: "group",
		type: "number",
		min: 1,
		integer: true,
	},
] as const satisfies readonly OptionDescriptor[];

describe("command option descriptors", () => {
	test("toFlagSpec preserves parseArgs-compatible flag shapes", () => {
		const projectFlag: { type: "string"; short: "p" } = toFlagSpec(
			CONTRACT_DESCRIPTORS[1]
		);
		const repeatableFlag: { type: "string"; multiple: true } = toFlagSpec(
			CONTRACT_DESCRIPTORS[2]
		);
		expect(projectFlag.short).toBe("p");
		expect(repeatableFlag.multiple).toBeTrue();
		expect(CONTRACT_DESCRIPTORS.map(toFlagSpec)).toEqual([
			{ type: "boolean" },
			{ type: "string", short: "p" },
			{ type: "string", multiple: true },
			{ type: "string" },
			{ type: "string" },
			{ type: "string" },
		]);
	});

	test("toRegistryOptions maps flag names to typed command keys", () => {
		const result = toRegistryOptions(CONTRACT_DESCRIPTORS, {
			help: true,
			project: "src",
			"rename-specifier": ["@old/pkg=@new/pkg"],
			prefer: "relative",
			threshold: "0",
			group: "2",
		});

		expect(result).toEqual({
			ok: true,
			value: {
				enabled: true,
				rootDir: "src",
				renames: ["@old/pkg=@new/pkg"],
				strategy: "relative",
				threshold: 0,
				group: 2,
			},
		});
	});

	test("absent flags remain undefined so command defaults apply", () => {
		const result = toRegistryOptions(CONTRACT_DESCRIPTORS, {});
		expect(result.ok).toBeTrue();
		if (result.ok) {
			expect(result.value).toEqual({
				enabled: undefined,
				rootDir: undefined,
				renames: undefined,
				strategy: undefined,
				threshold: undefined,
				group: undefined,
			});
		}
	});

	for (const [label, values, message] of [
		["non-numeric", { threshold: "abc" }, "--threshold must be"],
		["non-finite", { threshold: "Infinity" }, "--threshold must be"],
		["below-minimum", { threshold: "-1" }, "--threshold must be"],
		["above-maximum", { threshold: "2" }, "--threshold must be"],
		["non-integer", { group: "1.5" }, "--group must be"],
		["out-of-domain", { prefer: "fastest" }, "--prefer must be one of"],
	] as const) {
		test(`rejects ${label} values with a structured failure`, () => {
			const result = toRegistryOptions(CONTRACT_DESCRIPTORS, values);
			expect(result.ok).toBeFalse();
			if (!result.ok) {
				expect(result.message).toContain(message);
			}
		});
	}

	test("audit descriptors preserve flags, order, and executable defaults", () => {
		const cliValues: CliValues = {};
		const threshold: string | undefined = cliValues["fan-out-threshold"];
		expect(threshold).toBeUndefined();
		expect(AUDIT_OPTION_DESCRIPTORS.map(({ name }) => name)).toEqual([
			"project",
			"json",
			"workspace",
			"fan-out-threshold",
			"fan-in-threshold",
			"export-threshold",
			"include-ignored",
		]);
		expect(AUDIT_OPTION_DESCRIPTORS.slice(3, 6).map(toFlagSpec)).toEqual([
			{ type: "string" },
			{ type: "string" },
			{ type: "string" },
		]);
		expect(AUDIT_OPTION_DEFAULTS).toEqual({
			fanOutThreshold: 10,
			fanInThreshold: 10,
			exportThreshold: 8,
		});
		expect(COMMAND_SPECS.find(({ name }) => name === "audit")?.options).toBe(
			AUDIT_OPTION_DESCRIPTORS
		);
		expect(Object.keys(OPTION_FLAGS)).toEqual([
			"help",
			"version",
			"verbose",
			"dry-run",
			"project",
			"type",
			"prefer",
			"alias-prefer",
			"rename-specifier",
			"force",
			"journal",
			"verify",
			"no-verify",
			"fix",
			"fix-category",
			"json",
			"threshold",
			"max-groups",
			"max-changes",
			"strict",
			"name-threshold",
			"same-name-only",
			"skip-same-file",
			"only-related-to",
			"min-lines",
			"skip-directives",
			"skip-wrappers",
			"kinds",
			"group",
			"output",
			"workspace",
			"experimental",
			"scope",
			"out",
			"bucket",
			"format",
			"fan-out-threshold",
			"fan-in-threshold",
			"export-threshold",
			"min-siblings",
			"majority-threshold",
			"case",
			"include-tests",
			"convention-threshold",
			"ignore",
			"entrypoint-globs",
			"transform",
			"batch",
			"extensions",
			"include-ignored",
		]);
	});
});
