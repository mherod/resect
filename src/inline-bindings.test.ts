import { expect, test } from "bun:test";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { makeProject, parseMcpTextPayload } from "./commands/__test-helpers.ts";
import { applyChanges } from "./commands/alias.ts";
import { inlineBarrel } from "./commands/inline.ts";
import { loadProject } from "./core/project.ts";
import {
	applyStructuredEdits,
	applyTextChanges,
	type SerializedEdit,
} from "./core/text-changes.ts";
import { runTypeCheckDetailed } from "./core/verify.ts";
import { inlineTool } from "./mcp-tools/mutating.ts";

interface VerificationPayload {
	typecheck: {
		success: boolean;
		errorsBefore: string[];
		errorsAfter: string[];
	};
}

async function readValue(file: string): Promise<number> {
	const child = Bun.spawn(
		[
			process.execPath,
			"--eval",
			`const { value } = await import(${JSON.stringify(pathToFileURL(file).href)}); process.stdout.write(JSON.stringify(value));`,
		],
		{ stdout: "pipe", stderr: "pipe" }
	);
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	if (exitCode !== 0) {
		throw new Error(stderr);
	}
	return JSON.parse(stdout) as number;
}

test.each([
	"cli",
	"mcp",
] as const)("%s inline preserves an aliased export's runtime identity with default verification", async (surface) => {
	const fixture = await makeProject({
		name: `inline-binding-${surface}`,
		outsideRepo: true,
		git: true,
		tsconfig: "bundler",
		files: {
			"real.ts": "export const a = 1;\nexport const b = 2;\n",
			"barrel.ts": 'export { a as b } from "./real";\n',
			"consumer.ts": 'import { b } from "./barrel";\nexport const value = b;\n',
		},
	});
	expect(await readValue(fixture.path("consumer.ts"))).toBe(1);
	if (surface === "cli") {
		const response = await fixture.run(["inline", "barrel.ts", "--json"], {
			env: {
				PATH: `${path.resolve(import.meta.dir, "../node_modules/.bin")}${path.delimiter}${process.env.PATH ?? ""}`,
			},
		});
		expect(response.exitCode, response.stderr).toBe(0);
		const payload = JSON.parse(response.stdout) as VerificationPayload;
		expect(payload.typecheck.success).toBe(true);
		expect(payload.typecheck.errorsBefore).toEqual([]);
		expect(payload.typecheck.errorsAfter).toEqual([]);
	} else {
		const response = await inlineTool({
			barrelFile: fixture.path("barrel.ts"),
			dryRun: false,
			force: false,
			verify: true,
		});
		const payload = parseMcpTextPayload<VerificationPayload>(response);
		expect(payload.typecheck.success).toBe(true);
		expect(payload.typecheck.errorsBefore).toEqual([]);
		expect(payload.typecheck.errorsAfter).toEqual([]);
	}
	expect(await readValue(fixture.path("consumer.ts"))).toBe(1);
	expect(await Bun.file(fixture.path("consumer.ts")).text()).toBe(
		'import { a as b } from "./real";\nexport const value = b;\n'
	);
});

const bindingCases = [
	{
		name: "transparent wildcard re-export",
		real: "export const value = 1;",
		barrel: 'export * from "./real";',
		before: 'export * from "./barrel";',
		after: 'export * from "./real";',
	},
	{
		name: "type-only default-to-named export",
		real: "export default class Source { x = 1; }",
		barrel: 'export type { default as Alias } from "./real";',
		before:
			'import { Alias } from "./barrel"; const item: Alias = { x: 1 }; export const value = item.x;',
		after:
			'import { type default as Alias } from "./real"; const item: Alias = { x: 1 }; export const value = item.x;',
	},
	{
		name: "type-only named-to-default export",
		real: "export class Source { x = 1; }",
		barrel: 'export type { Source as default } from "./real";',
		before:
			'import Local from "./barrel"; const item: Local = { x: 1 }; export const value = item.x;',
		after:
			'import type { Source as Local } from "./real"; const item: Local = { x: 1 }; export const value = item.x;',
	},
	{
		name: "consumer alias without capturing an existing local",
		real: "export const a = 1; export const b = 2;",
		barrel: 'export { a as b } from "./real";',
		before:
			'import { b as local } from "./barrel"; const a = 99; export const value = local;',
		after:
			'import { a as local } from "./real"; const a = 99; export const value = local;',
	},
	{
		name: "default-to-named export",
		real: "export default 1; export const b = 2;",
		barrel: 'export { default as b } from "./real";',
		before: 'import { b } from "./barrel"; export const value = b;',
		after: 'import { default as b } from "./real"; export const value = b;',
	},
	{
		name: "named-to-default export",
		real: "export const a = 1; export default 2;",
		barrel: 'export { a as default } from "./real";',
		before: 'import chosen from "./barrel"; export const value = chosen;',
		after: 'import { a as chosen } from "./real"; export const value = chosen;',
	},
	{
		name: "mixed default and named import",
		real: "export default 7; export const a = 1; export const b = 2; export const c = 3;",
		barrel: 'export { default, a as b, c } from "./real";',
		before:
			'import chosen, { b, c as other } from "./barrel"; export const value = chosen + b + other;',
		after:
			'import chosen, { a as b, c as other } from "./real"; export const value = chosen + b + other;',
		value: 11,
	},
	{
		name: "multiple imports on one line and unrelated strings",
		real: "export const a = 1; export const b = 2;",
		barrel: 'export { a as b } from "./real";',
		before:
			'import { b as one } from "./barrel"; import { b as two } from "./barrel"; const marker = "b ./barrel"; export const value = one + two;',
		after:
			'import { a as one } from "./real"; import { a as two } from "./real"; const marker = "b ./barrel"; export const value = one + two;',
		value: 2,
	},
	{
		name: "downstream named re-export",
		real: "export const a = 1; export const b = 2;",
		barrel: 'export { a as b } from "./real";',
		before: 'export { b as value } from "./barrel";',
		after: 'export { a as value } from "./real";',
	},
	{
		name: "multiline comments and quote style",
		real: "export const a = 1; export const b = 2;",
		barrel: 'export { a as b } from "./real";',
		before:
			"import {\n  /* keep */ b /* alias */ as local,\n} from './barrel';\nexport const value = local;",
		after:
			"import {\n  /* keep */ a /* alias */ as local,\n} from './real';\nexport const value = local;",
	},
	{
		name: "quoted canonical export name",
		real: 'const a = 1; export { a as "value-name" }; export const b = 2;',
		barrel: 'export { "value-name" as b } from "./real";',
		before: 'import { b } from "./barrel"; export const value = b;',
		after:
			'import { "value-name" as b } from "./real"; export const value = b;',
	},
	{
		name: "type-only re-export provenance",
		real: "export class Source { x = 1; }",
		barrel: 'export type { Source as Alias } from "./real";',
		before:
			'import { Alias as Local } from "./barrel"; const item: Local = { x: 1 }; export const value = item.x;',
		after:
			'import { type Source as Local } from "./real"; const item: Local = { x: 1 }; export const value = item.x;',
	},
	{
		name: "type-only import clause",
		real: "export class Source { x = 1; }",
		barrel: 'export { Source as Alias } from "./real";',
		before:
			'import type { Alias } from "./barrel"; const item: Alias = { x: 1 }; export const value = item.x;',
		after:
			'import type { Source as Alias } from "./real"; const item: Alias = { x: 1 }; export const value = item.x;',
	},
	{
		name: "type-only import specifier",
		real: "export class Source { x = 1; }",
		barrel: 'export type { Source as Alias } from "./real";',
		before:
			'import { type Alias as Local } from "./barrel"; const item: Local = { x: 1 }; export const value = item.x;',
		after:
			'import { type Source as Local } from "./real"; const item: Local = { x: 1 }; export const value = item.x;',
	},
	{
		name: "downstream type-only export",
		real: "export class Source { x = 1; }",
		barrel: 'export type { Source as Alias } from "./real";',
		before:
			'export { Alias as Public } from "./barrel"; export const value = 1;',
		after:
			'export { type Source as Public } from "./real"; export const value = 1;',
	},
	{
		name: "type-only wildcard provenance",
		real: "export class Source { x = 1; }",
		barrel: 'export type * from "./real";',
		before:
			'import { Source } from "./barrel"; const item: Source = { x: 1 }; export const value = item.x;',
		after:
			'import { type Source } from "./real"; const item: Source = { x: 1 }; export const value = item.x;',
	},
];

test.each(
	bindingCases
)("inline preserves $name in preview, apply, compilation and runtime", async ({
	real,
	barrel,
	before,
	after,
	value,
}) => {
	const fixture = await makeProject({
		name: "inline-binding-plan",
		outsideRepo: true,
		tsconfig: "bundler",
		files: { "real.ts": real, "barrel.ts": barrel, "consumer.ts": before },
	});
	const project = loadProject(fixture.path("tsconfig.json"));
	const { result, changes } = await inlineBarrel(
		fixture.path("barrel.ts"),
		project,
		{ dryRun: true }
	);
	expect(result.conflicts).toEqual([]);
	expect(result.edits).toHaveLength(1);
	expect(await Bun.file(fixture.path("consumer.ts")).text()).toBe(before);
	expect(applyStructuredEdits(before, result.edits ?? [])).toBe(after);
	await applyChanges(changes);
	expect(await Bun.file(fixture.path("consumer.ts")).text()).toBe(after);
	expect(await Bun.file(fixture.path("barrel.ts")).text()).toBe(barrel);
	expect(await runTypeCheckDetailed(project)).toEqual({
		errors: [],
		incomplete: false,
	});
	expect(await readValue(fixture.path("consumer.ts"))).toBe(value ?? 1);
});

test.each([
	{
		name: "duplicate explicit aliases",
		barrel: 'export { a as b, c as b } from "./real";',
		consumer: 'import { b } from "./barrel"; export const value = b;',
	},
	{
		name: "multiple wildcard sources",
		barrel: 'export * from "./real"; export * from "./other";',
		consumer: 'import { a } from "./barrel"; export const value = a;',
	},
	{
		name: "namespace export with wildcard fallback",
		barrel: 'export * as b from "./real"; export * from "./real";',
		consumer: 'import { b } from "./barrel"; export const value = b;',
	},
	{
		name: "unresolved alias with wildcard fallback",
		barrel: 'export { a as b } from "./missing"; export * from "./real";',
		consumer: 'import { b } from "./barrel"; export const value = b;',
	},
	{
		name: "wildcard consumer of a renamed export",
		barrel: 'export { a as b } from "./real";',
		consumer: 'export * from "./barrel";',
	},
	{
		name: "default import through export star",
		barrel: 'export * from "./real";',
		consumer: 'import value from "./barrel"; export { value };',
	},
	{
		name: "mixed import requiring a default binding split",
		barrel: 'export { a as default, c } from "./real";',
		consumer: 'import value, { c } from "./barrel"; export { value, c };',
	},
])("inline refuses $name before mutation even with force", async ({
	barrel,
	consumer,
}) => {
	const fixture = await makeProject({
		name: "inline-binding-refusal",
		outsideRepo: true,
		tsconfig: "bundler",
		files: {
			"real.ts":
				"export const a = 1; export const b = 2; export const c = 3; export default 4;",
			"other.ts": "export const a = 5;",
			"barrel.ts": barrel,
			"consumer.ts": consumer,
		},
	});
	const response = await inlineTool({
		barrelFile: fixture.path("barrel.ts"),
		dryRun: false,
		force: true,
		verify: false,
	});
	const payload = parseMcpTextPayload<{
		success: boolean;
		filesChanged: number;
		conflicts: unknown[];
	}>(response);
	expect(payload.success).toBe(false);
	expect(payload.filesChanged).toBe(0);
	expect(payload.conflicts).toHaveLength(1);
	expect(await Bun.file(fixture.path("consumer.ts")).text()).toBe(consumer);
});

test("inline preserves the existing canonical-import conflict policy and local bindings", async () => {
	const consumer =
		'import { a } from "./real"; import { b } from "./barrel"; export const value = a + b;';
	const fixture = await makeProject({
		name: "inline-binding-collision",
		outsideRepo: true,
		tsconfig: "bundler",
		files: {
			"real.ts": "export const a = 1; export const b = 2;",
			"barrel.ts": 'export { a as b } from "./real";',
			"consumer.ts": consumer,
		},
	});
	const blocked = await inlineTool({
		barrelFile: fixture.path("barrel.ts"),
		dryRun: false,
		force: false,
		verify: true,
	});
	expect(blocked.isError).toBe(true);
	expect(await Bun.file(fixture.path("consumer.ts")).text()).toBe(consumer);
	const applied = await inlineTool({
		barrelFile: fixture.path("barrel.ts"),
		dryRun: false,
		force: true,
		verify: true,
	});
	expect(parseMcpTextPayload<{ success: boolean }>(applied).success).toBe(true);
	expect(await readValue(fixture.path("consumer.ts"))).toBe(2);
});

test("MCP preview exposes the actual binding edit and stale plans refuse changed tokens", async () => {
	const before = 'import { b } from "./barrel"; export const value = b;';
	const after = 'import { a as b } from "./real"; export const value = b;';
	const fixture = await makeProject({
		name: "inline-binding-preview",
		outsideRepo: true,
		tsconfig: "bundler",
		files: {
			"real.ts": "export const a = 1; export const b = 2;",
			"barrel.ts": 'export { a as b } from "./real";',
			"consumer.ts": before,
		},
	});
	const response = await inlineTool({
		barrelFile: fixture.path("barrel.ts"),
		dryRun: true,
		force: false,
		verify: true,
	});
	const payload = parseMcpTextPayload<{ edits: SerializedEdit[] }>(response);
	expect(payload.edits[0]?.file).toBe("consumer.ts");
	expect(applyTextChanges(before, payload.edits)).toBe(after);
	const cli = await fixture.run(["inline", "barrel.ts", "--json", "--dry-run"]);
	expect(cli.exitCode, cli.stderr).toBe(0);
	const cliPayload = JSON.parse(cli.stdout) as { edits: SerializedEdit[] };
	expect(cliPayload.edits).toEqual(payload.edits);
	expect(await Bun.file(fixture.path("consumer.ts")).text()).toBe(before);
	const { changes } = await inlineBarrel(
		fixture.path("barrel.ts"),
		loadProject(fixture.path("tsconfig.json")),
		{ dryRun: true }
	);
	const edited = before.replace("{ b }", "{ b as local }");
	await Bun.write(fixture.path("consumer.ts"), edited);
	const failure: unknown = await applyChanges(changes).catch(
		(error: unknown) => error
	);
	expect(failure).toBeInstanceOf(Error);
	expect(failure instanceof Error && failure.message).toContain(
		"does not match the original content"
	);
	expect(await Bun.file(fixture.path("consumer.ts")).text()).toBe(edited);
});
