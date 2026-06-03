import { describe, expect, test } from "bun:test";
import type { CliValues } from "./option-flags.ts";
import { OPTION_FLAGS, PARSE_ARGS_OPTIONS } from "./option-flags.ts";

/**
 * Drift guard: ensures the OPTION_FLAGS table always contains exactly the
 * expected flag set with correct shapes, and that CliValues is derivable from it.
 */

const EXPECTED_FLAGS = [
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
	"include-tests",
	"convention-threshold",
	"ignore",
	"entrypoint-globs",
	"transform",
] as const;

describe("option-flags", () => {
	test("PARSE_ARGS_OPTIONS has exactly the expected flag set", () => {
		const keys = Object.keys(PARSE_ARGS_OPTIONS);
		expect(keys).toEqual([...EXPECTED_FLAGS]);
	});

	test("OPTION_FLAGS flag count matches expected list", () => {
		expect(Object.keys(OPTION_FLAGS).length).toBe(EXPECTED_FLAGS.length);
	});

	test("boolean flags have correct type", () => {
		const booleanFlags = [
			"help",
			"version",
			"verbose",
			"dry-run",
			"force",
			"no-verify",
			"fix",
			"json",
			"strict",
			"same-name-only",
			"skip-same-file",
			"skip-directives",
			"skip-wrappers",
			"workspace",
			"experimental",
			"include-tests",
		] as const;

		for (const flag of booleanFlags) {
			expect(OPTION_FLAGS[flag].type).toBe("boolean");
		}
	});

	test("string flags have correct type", () => {
		const stringFlags = [
			"project",
			"type",
			"prefer",
			"alias-prefer",
			"threshold",
			"max-groups",
			"max-changes",
			"name-threshold",
			"only-related-to",
			"min-lines",
			"kinds",
			"group",
			"output",
			"scope",
			"out",
			"bucket",
			"format",
			"fan-out-threshold",
			"fan-in-threshold",
			"export-threshold",
			"min-siblings",
			"majority-threshold",
			"convention-threshold",
			"ignore",
			"transform",
		] as const;

		for (const flag of stringFlags) {
			expect(OPTION_FLAGS[flag].type).toBe("string");
		}
	});

	test("multiple string flags have multiple:true", () => {
		const multipleFlags = [
			"rename-specifier",
			"fix-category",
			"entrypoint-globs",
		] as const;

		for (const flag of multipleFlags) {
			expect(OPTION_FLAGS[flag].type).toBe("string");
			expect((OPTION_FLAGS[flag] as { multiple?: boolean }).multiple).toBe(
				true
			);
		}
	});

	test("short aliases are correct", () => {
		expect((OPTION_FLAGS.help as { short?: string }).short).toBe("h");
		expect((OPTION_FLAGS.version as { short?: string }).short).toBe("v");
		expect((OPTION_FLAGS["dry-run"] as { short?: string }).short).toBe("n");
		expect((OPTION_FLAGS.project as { short?: string }).short).toBe("p");
		expect((OPTION_FLAGS.type as { short?: string }).short).toBe("t");
		expect((OPTION_FLAGS.output as { short?: string }).short).toBe("o");
	});

	test("CliValues type-level smoke check", () => {
		// This is a compile-time check: if CliValues derivation is wrong, tsc
		// will reject this assignment. The test itself is trivially true at runtime.
		const _fixture: CliValues = {
			help: true,
			version: false,
			verbose: true,
			"dry-run": true,
			project: "/path/to/project",
			type: "file",
			prefer: "alias",
			"alias-prefer": "relative",
			"rename-specifier": ["@old/pkg=@new/pkg"],
			force: false,
			"no-verify": false,
			fix: false,
			"fix-category": ["dead-exports"],
			json: false,
			threshold: "0.8",
			"max-groups": "10",
			"max-changes": "50",
			strict: false,
			"name-threshold": "0.5",
			"same-name-only": false,
			"skip-same-file": false,
			"only-related-to": "src/",
			"min-lines": "5",
			"skip-directives": false,
			"skip-wrappers": false,
			kinds: "function,type",
			group: "group-name",
			output: "src/shared.ts",
			workspace: false,
			experimental: false,
			scope: "src/",
			out: "report.json",
			bucket: "high",
			format: "compact",
			"fan-out-threshold": "10",
			"fan-in-threshold": "5",
			"export-threshold": "20",
			"min-siblings": "3",
			"majority-threshold": "0.6",
			"include-tests": false,
			"convention-threshold": "0.8",
			ignore: "**/*.test.ts",
			"entrypoint-globs": ["src/**/*.ts"],
			transform: ".resect/transforms.js",
		};
		expect(_fixture.help).toBe(true);
	});

	test("entrypoint-globs accepts string | string[] (asymmetry preserved)", () => {
		// entrypoint-globs is typed string | string[] (widened union), while
		// rename-specifier and fix-category are string[] (array-only). This
		// asymmetry is intentional and must not be corrected.
		const _withString: CliValues = { "entrypoint-globs": "src/**/*.ts" };
		const _withArray: CliValues = { "entrypoint-globs": ["src/**/*.ts"] };
		expect(_withString["entrypoint-globs"]).toBe("src/**/*.ts");
		expect(_withArray["entrypoint-globs"]).toEqual(["src/**/*.ts"]);
	});
});
