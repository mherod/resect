import { describe, expect, test } from "bun:test";
import { parseArgs } from "node:util";
import type { CliValues } from "./option-flags.ts";
import {
	findUnsupportedOptions,
	OPTION_FLAGS,
	PARSE_ARGS_OPTIONS,
	preprocessArgs,
} from "./option-flags.ts";

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
			"journal",
			"verify",
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
			"case",
			"convention-threshold",
			"ignore",
			"transform",
			"batch",
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
			verify: true,
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
			case: "kebab-case",
			"include-tests": false,
			"convention-threshold": "0.8",
			ignore: "**/*.test.ts",
			"entrypoint-globs": ["src/**/*.ts"],
			transform: ".resect/transforms.js",
			batch: "moves.json",
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

describe("preprocessArgs (#173)", () => {
	test("drops a boolean flag given a falsy equals value", () => {
		expect(preprocessArgs(["move", "a.ts", "b.ts", "--dry-run=false"])).toEqual(
			["move", "a.ts", "b.ts"]
		);
		expect(preprocessArgs(["move", "a.ts", "b.ts", "-n=false"])).toEqual([
			"move",
			"a.ts",
			"b.ts",
		]);
	});

	test("treats every falsy spelling as off", () => {
		for (const value of ["false", "FALSE", "0", "no", "off"]) {
			expect(preprocessArgs(["move", `--dry-run=${value}`])).toEqual(["move"]);
		}
	});

	test("normalizes a truthy equals value to the bare flag", () => {
		expect(preprocessArgs(["move", "-n=true"])).toEqual(["move", "-n"]);
		expect(preprocessArgs(["move", "--dry-run=true"])).toEqual([
			"move",
			"--dry-run",
		]);
		expect(preprocessArgs(["move", "--force=1"])).toEqual(["move", "--force"]);
	});

	test("leaves bare boolean flags and string flags untouched", () => {
		expect(
			preprocessArgs(["move", "-n", "--project=/tmp/x", "--prefer=relative"])
		).toEqual(["move", "-n", "--project=/tmp/x", "--prefer=relative"]);
	});

	test("still expands the tidy --fix=<category> shorthand", () => {
		expect(preprocessArgs(["tidy", "src", "--fix=dead-exports"])).toEqual([
			"tidy",
			"src",
			"--fix",
			"--fix-category",
			"dead-exports",
		]);
	});

	test("parseArgs accepts -n=false once preprocessed (regression #173)", () => {
		// Raw `-n=false` makes parseArgs throw `Unknown option '='`.
		expect(() =>
			parseArgs({
				args: ["move", "a.ts", "b.ts", "-n=false"],
				options: PARSE_ARGS_OPTIONS,
				allowPositionals: true,
				strict: true,
			})
		).toThrow();

		const { values, positionals } = parseArgs({
			args: preprocessArgs(["move", "a.ts", "b.ts", "-n=false"]),
			options: PARSE_ARGS_OPTIONS,
			allowPositionals: true,
			strict: true,
		});
		expect(values["dry-run"]).toBeUndefined();
		expect(positionals).toEqual(["move", "a.ts", "b.ts"]);
	});

	test("parseArgs sees -n=true as dry-run enabled", () => {
		const { values } = parseArgs({
			args: preprocessArgs(["move", "a.ts", "b.ts", "-n=true"]),
			options: PARSE_ARGS_OPTIONS,
			allowPositionals: true,
			strict: true,
		});
		expect(values["dry-run"]).toBe(true);
	});

	// PR #174 review (P2): an unrecognised value must not silently enable the
	// flag — `--force=fales` would otherwise bypass the dirty-worktree guard.
	test("leaves an unrecognised boolean value untouched so parseArgs rejects it", () => {
		expect(preprocessArgs(["move", "--force=fales"])).toEqual([
			"move",
			"--force=fales",
		]);
		expect(preprocessArgs(["move", "--force="])).toEqual(["move", "--force="]);
		expect(preprocessArgs(["move", "-n=maybe"])).toEqual(["move", "-n=maybe"]);
	});

	test("a typo'd boolean value is a parse error, not an enabled flag", () => {
		expect(() =>
			parseArgs({
				args: preprocessArgs(["move", "a.ts", "b.ts", "--force=fales"]),
				options: PARSE_ARGS_OPTIONS,
				allowPositionals: true,
				strict: true,
			})
		).toThrow();
	});

	// PR #174 review (P2): parseArgs treats everything after `--` as positional.
	test("stops normalizing after the -- separator", () => {
		expect(
			preprocessArgs(["move", "--", "--dry-run=false", "target.ts"])
		).toEqual(["move", "--", "--dry-run=false", "target.ts"]);
		expect(preprocessArgs(["move", "--", "-n=false"])).toEqual([
			"move",
			"--",
			"-n=false",
		]);
	});

	test("a dash-prefixed path after -- survives as a positional", () => {
		const { positionals } = parseArgs({
			args: preprocessArgs(["move", "--", "--dry-run=false", "target.ts"]),
			options: PARSE_ARGS_OPTIONS,
			allowPositionals: true,
			strict: true,
		});
		expect(positionals).toEqual(["move", "--dry-run=false", "target.ts"]);
	});

	test("still normalizes flags before the separator", () => {
		expect(preprocessArgs(["move", "-n=false", "--", "-n=false"])).toEqual([
			"move",
			"--",
			"-n=false",
		]);
	});
});

describe("command option validation (#191)", () => {
	test("accepts supported long, canonicalized short, and repeatable values", () => {
		const { values } = parseArgs({
			args: [
				"-p",
				"tsconfig.json",
				"--rename-specifier=a=b",
				"--rename-specifier=c=d",
			],
			options: PARSE_ARGS_OPTIONS,
		});

		expect(
			findUnsupportedOptions(values as CliValues, [
				"project",
				"rename-specifier",
			])
		).toEqual([]);
	});

	test("reports every unsupported canonical option name", () => {
		expect(
			findUnsupportedOptions({ force: true, out: "report.json" }, ["verbose"])
		).toEqual(["force", "out"]);
	});

	// #149: `json` is declared globally in OPTION_FLAGS, so parseArgs accepts it
	// before the command is known. The capability check at the command boundary
	// is what stops a command without a serializer from printing a human report
	// under --json. Every command currently advertises `json`, so this guard is
	// dormant — assert it directly, or a future command that omits `json` would
	// silently reintroduce the defect.
	test("flags --json for a command that does not advertise it", () => {
		expect(
			findUnsupportedOptions({ json: true }, ["project", "verbose"])
		).toEqual(["json"]);
	});

	test("accepts --json for a command that advertises it", () => {
		expect(findUnsupportedOptions({ json: true }, ["project", "json"])).toEqual(
			[]
		);
	});
});
