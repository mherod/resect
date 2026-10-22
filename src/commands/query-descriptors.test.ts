import { expect, test } from "bun:test";
import { captureOutput, makeProject, runCli } from "./__test-helpers.ts";
import { type AffectedOptions, affected } from "./affected.ts";
import { type AnalyzeOptions, analyzeCommand } from "./analyze.ts";
import { type AnalyzeImpactOptions, analyzeImpact } from "./analyze-impact.ts";
import { toFlagSpec, toRegistryOptions } from "./command-descriptor.ts";
import { COMMAND_SPECS } from "./command-spec.ts";
import { type FindOptions, findCommand } from "./find.ts";
import { OPTION_FLAGS } from "./option-flags.ts";
import {
	AFFECTED_OPTION_DESCRIPTORS,
	ANALYZE_IMPACT_OPTION_DESCRIPTORS,
	ANALYZE_OPTION_DESCRIPTORS,
	FIND_OPTION_DESCRIPTORS,
} from "./query-descriptors.ts";

test("query descriptors retain global flag shapes and attach to their command specs", () => {
	for (const [name, descriptors] of [
		["find", FIND_OPTION_DESCRIPTORS],
		["analyze", ANALYZE_OPTION_DESCRIPTORS],
		["analyze-impact", ANALYZE_IMPACT_OPTION_DESCRIPTORS],
		["affected", AFFECTED_OPTION_DESCRIPTORS],
	] as const) {
		expect(COMMAND_SPECS.find((spec) => spec.name === name)?.options).toBe(
			descriptors
		);
		for (const descriptor of descriptors) {
			expect(toFlagSpec(descriptor)).toEqual(OPTION_FLAGS[descriptor.name]);
		}
	}
});

test("find validates the required project before the enum and preserves absent options", () => {
	for (const project of [undefined, ""]) {
		expect(
			toRegistryOptions(FIND_OPTION_DESCRIPTORS, { project, type: "invalid" })
		).toEqual({
			ok: false,
			message: "Error: find requires -p <project> option",
			usageCommand: "find",
		});
	}
	for (const type of ["", "invalid"]) {
		expect(
			toRegistryOptions(FIND_OPTION_DESCRIPTORS, { project: ".", type })
		).toEqual({
			ok: false,
			message: "Error: --type must be 'file', 'export', or 'all'",
		});
	}
	expect(toRegistryOptions(FIND_OPTION_DESCRIPTORS, { project: "." })).toEqual({
		ok: true,
		value: {
			project: ".",
			type: undefined,
			verbose: undefined,
			workspace: undefined,
			onlyRelatedTo: undefined,
			json: undefined,
		},
	});
});

test("query parsing preserves boolean values and repeatable CLI globs", () => {
	expect(
		toRegistryOptions(ANALYZE_OPTION_DESCRIPTORS, {
			project: "",
			verbose: false,
			workspace: true,
			json: true,
			"only-related-to": "src/**",
			"entrypoint-globs": ["hooks/**", "scripts/**"],
		})
	).toEqual({
		ok: true,
		value: {
			project: "",
			verbose: false,
			workspace: true,
			json: true,
			onlyRelatedTo: "src/**",
			entrypointGlobs: ["hooks/**", "scripts/**"],
		},
	});
	expect(toRegistryOptions(ANALYZE_OPTION_DESCRIPTORS, {}).ok).toBeTrue();
	expect(
		toRegistryOptions(ANALYZE_OPTION_DESCRIPTORS, {
			"entrypoint-globs": "hooks/**",
		}).ok
	).toBeFalse();
	expect(
		toRegistryOptions(ANALYZE_OPTION_DESCRIPTORS, { project: false }).ok
	).toBeFalse();
	for (const descriptors of [
		ANALYZE_IMPACT_OPTION_DESCRIPTORS,
		AFFECTED_OPTION_DESCRIPTORS,
	]) {
		expect(toRegistryOptions(descriptors, {})).toEqual({
			ok: true,
			value: {
				verbose: undefined,
				project: undefined,
				workspace: undefined,
				json: undefined,
			},
		});
	}
});

const CLI_FAILURE_CASES = [
	{
		label: "query before flags",
		args: ["find", "--type=wrong"],
		message:
			"Error: find requires a <query> argument\nRun 'resect find --help' for usage\n",
	},
	{
		label: "missing project before enum",
		args: ["find", "Widget", "--type=wrong"],
		message:
			"Error: find requires -p <project> option\nRun 'resect find --help' for usage\n",
	},
	{
		label: "empty project before enum",
		args: ["find", "Widget", "--project=", "--type=wrong"],
		message:
			"Error: find requires -p <project> option\nRun 'resect find --help' for usage\n",
	},
	{
		label: "invalid enum",
		args: ["find", "Widget", "-p", ".", "--type=wrong"],
		message: "Error: --type must be 'file', 'export', or 'all'\n",
	},
	{
		label: "empty enum",
		args: ["find", "Widget", "-p", ".", "--type="],
		message: "Error: --type must be 'file', 'export', or 'all'\n",
	},
	{
		label: "missing analyze file",
		args: ["analyze"],
		message:
			"Error: analyze requires a <file> argument\nRun 'resect analyze --help' for usage\n",
	},
	{
		label: "missing impact source",
		args: ["analyze-impact"],
		message:
			"Error: analyze-impact requires a <source> argument\nRun 'resect analyze-impact --help' for usage\n",
	},
	{
		label: "missing impact target",
		args: ["analyze-impact", "source.ts"],
		message:
			"Error: analyze-impact requires a <target> argument\nRun 'resect analyze-impact --help' for usage\n",
	},
	{
		label: "zero affected files",
		args: ["affected"],
		message:
			"Error: affected requires at least one <file> argument\nRun 'resect affected --help' for usage\n",
	},
];

for (const { label, args, message } of CLI_FAILURE_CASES) {
	test(`query CLI retains exact failure output for ${label}`, async () => {
		const result = await runCli(args);
		expect(result.exitCode).toBe(1);
		expect(result.stdout).toBe("");
		expect(result.stderr).toBe(message);
	});
}

test("query CLI and library preserve filenames, filters, imports and glob cardinalities", async () => {
	const fixture = await makeProject({
		name: "query-descriptors",
		outsideRepo: true,
		tsconfig: "bundler",
		files: {
			"src/model.ts": "export const Widget = 1;\n",
			"src/consumer.ts":
				'import { Widget } from "./model"; export const value = Widget;\n',
			"src/hooks/dispatch.ts": "export function dispatch() { return 1; }\n",
		},
	});
	const findOptions: FindOptions = {
		query: "Widget",
		project: fixture.dir,
		type: "export",
		json: true,
	};
	const requiredProject: string = findOptions.project;
	const found = await captureOutput(async () => findCommand(findOptions));
	const cliFind = await fixture.run([
		"find",
		"Widget",
		"-p",
		requiredProject,
		"-t",
		"export",
		"--json",
	]);
	expect(cliFind.exitCode).toBe(0);
	expect(JSON.parse(cliFind.stdout)).toEqual(JSON.parse(found.stdout));
	expect(JSON.parse(found.stdout).exports).toHaveLength(1);
	const globArrays = [
		["src/hooks/**"],
		["src/hooks/**", "src/scripts/**"],
	] as const;
	for (const globs of globArrays) {
		const analyzeOptions: AnalyzeOptions = {
			file: fixture.path("src/hooks/dispatch.ts"),
			project: fixture.dir,
			entrypointGlobs: globs,
			json: true,
		};
		const analyzed = await captureOutput(async () =>
			analyzeCommand(analyzeOptions)
		);
		const args = ["analyze", analyzeOptions.file, "-p", fixture.dir, "--json"];
		for (const glob of globs) {
			args.push("--entrypoint-globs", glob);
		}
		const cliAnalyze = await fixture.run(args);
		expect(cliAnalyze.exitCode).toBe(0);
		expect(JSON.parse(cliAnalyze.stdout)).toEqual(JSON.parse(analyzed.stdout));
		expect(JSON.parse(analyzed.stdout).externalUsageAssumed).toBeTrue();
	}
	const impactOptions: AnalyzeImpactOptions = {
		source: fixture.path("src/model.ts"),
		target: fixture.path("src/renamed.ts"),
		project: fixture.dir,
	};
	const impact = await analyzeImpact(impactOptions);
	const cliImpact = await fixture.run([
		"analyze-impact",
		impactOptions.source,
		impactOptions.target,
		"-p",
		fixture.dir,
		"--json",
	]);
	expect(cliImpact.exitCode).toBe(0);
	expect(JSON.parse(cliImpact.stdout)).toEqual(impact);
	for (const files of [
		[fixture.path("src/model.ts")],
		[fixture.path("src/model.ts"), fixture.path("src/consumer.ts")],
	]) {
		const options: AffectedOptions = { files, project: fixture.dir };
		const cliAffected = await fixture.run(
			["affected", ...files, "-p", fixture.dir, "--json"],
			{ cwd: process.cwd() }
		);
		expect(cliAffected.exitCode).toBe(0);
		expect(JSON.parse(cliAffected.stdout)).toEqual(await affected(options));
	}
});
