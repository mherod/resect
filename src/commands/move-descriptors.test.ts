import { expect, test } from "bun:test";
import { makeFixture, runCli } from "./__test-helpers.ts";
import { toFlagSpec } from "./command-descriptor.ts";
import {
	MOVE_OPTION_DESCRIPTORS,
	parseMoveCliOptions,
} from "./move-descriptors.ts";
import { EXTENSION_POLICIES, PREFER_STRATEGIES } from "./option-domains.ts";
import { type CliValues, OPTION_FLAGS } from "./option-flags.ts";

test("move descriptors retain global flag parsing and absent CLI defaults", () => {
	for (const descriptor of MOVE_OPTION_DESCRIPTORS) {
		expect(toFlagSpec(descriptor)).toEqual(OPTION_FLAGS[descriptor.name]);
	}
	expect(parseMoveCliOptions({})).toEqual({
		ok: true,
		value: {
			batch: undefined,
			dryRun: undefined,
			force: undefined,
			journal: undefined,
			json: undefined,
			verbose: undefined,
			verify: true,
			project: undefined,
			workspace: undefined,
			transform: undefined,
			prefer: undefined,
			extensions: undefined,
		},
	});
});

test("move keeps no-verify precedence for absent, false and competing flags", () => {
	for (const verify of [undefined, false, true]) {
		for (const noVerify of [undefined, false, true]) {
			const result = parseMoveCliOptions({ verify, "no-verify": noVerify });
			expect(result.ok).toBeTrue();
			if (result.ok) {
				expect(result.value.verify).toBe(!noVerify);
				expect(result.value).not.toHaveProperty("noVerify");
			}
		}
	}
});

test("move maps both modes' options without replacing false or empty values", () => {
	for (const prefer of PREFER_STRATEGIES) {
		for (const extensions of EXTENSION_POLICIES) {
			const values: CliValues = {
				batch: "moves.json",
				"dry-run": false,
				force: false,
				journal: false,
				json: true,
				verbose: true,
				project: "",
				workspace: true,
				transform: "",
				prefer,
				extensions,
			};
			expect(parseMoveCliOptions(values)).toEqual({
				ok: true,
				value: {
					batch: "moves.json",
					dryRun: false,
					force: false,
					journal: false,
					json: true,
					verbose: true,
					verify: true,
					project: "",
					workspace: true,
					transform: "",
					prefer,
					extensions,
				},
			});
		}
	}
});

test("move enum errors retain exact messages and preference validation order", () => {
	for (const invalid of ["", "unknown", "ALIAS", " relative "]) {
		expect(
			parseMoveCliOptions({ prefer: invalid, extensions: "invalid" })
		).toEqual({
			ok: false,
			message: "Error: --prefer must be 'alias', 'relative', or 'shortest'",
		});
		expect(parseMoveCliOptions({ extensions: invalid })).toEqual({
			ok: false,
			message: "Error: --extensions must be 'preserve' or 'explicit'",
		});
	}
});

test("move CLI keeps positional and batch failures ahead of option validation", async () => {
	const cases = [
		{
			args: ["--prefer=invalid"],
			error: "Error: move requires <source> and <target> arguments",
		},
		{
			args: ["a.ts", "--batch=moves.json", "--prefer=invalid"],
			error:
				"Error: move accepts either <source> <target> or --batch <moves.json>, not both",
		},
		{
			args: ["a.ts", "b.ts", "--prefer="],
			error: "Error: --prefer must be 'alias', 'relative', or 'shortest'",
		},
		{
			args: ["--batch=moves.json", "--extensions=invalid"],
			error: "Error: --extensions must be 'preserve' or 'explicit'",
		},
	];
	for (const { args, error } of cases) {
		const result = await runCli(["move", ...args]);
		expect(result.exitCode).toBe(1);
		expect(result.stderr.split("\n")[0]).toBe(error);
		expect(result.stdout).toBe("");
	}
});

test("move CLI forwards shared options through single and batch previews", async () => {
	const source = "export const value = 1;\n";
	const dir = await makeFixture(
		"move-descriptor-preview",
		{
			"tsconfig.json": JSON.stringify({
				compilerOptions: { module: "ESNext", moduleResolution: "Bundler" },
				include: ["src/**/*.ts"],
			}),
			"src/source.ts": source,
			"src/consumer.ts":
				'import { value } from "./source";\nexport const result = value;\n',
			"moves.json": JSON.stringify([
				{ source: "src/source.ts", target: "src/moved.ts" },
			]),
		},
		{ outsideRepo: true }
	);
	for (const args of [
		["src/source.ts", "src/moved.ts"],
		["--batch=moves.json"],
	]) {
		const result = await runCli(
			[
				"move",
				...args,
				"--dry-run",
				"--json",
				"--prefer=relative",
				"--extensions=explicit",
				"--no-verify",
			],
			{ cwd: dir }
		);
		expect(result.exitCode, result.stderr).toBe(0);
		expect(JSON.parse(result.stdout)).toMatchObject({ success: true });
		expect(result.stdout).toContain("./moved.ts");
		expect(await Bun.file(`${dir}/src/source.ts`).text()).toBe(source);
		expect(await Bun.file(`${dir}/src/moved.ts`).exists()).toBeFalse();
	}
});
