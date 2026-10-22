import { afterEach, expect, test } from "bun:test";
import path from "node:path";
import {
	CLI,
	makeProject,
	type ProjectFixture,
	parseMcpTextPayload,
} from "./commands/__test-helpers.ts";
import { JOURNAL_RELATIVE_PATH, readOperationJournal } from "./core/journal.ts";
import { inlineTool } from "./mcp-tools/mutating.ts";
import { bunRuntime, setRuntime } from "./runtime/index.ts";

const namedConsumer =
	'import { a } from "./barrel";\nexport const value = a;\n';
const namespaceConsumer =
	'import * as ns from "./barrel";\nexport const value = ns.a;\n';
const cliEnv = {
	PATH: `${path.resolve(import.meta.dir, "../node_modules/.bin")}${path.delimiter}${process.env.PATH ?? ""}`,
};

interface InlinePayload {
	success: boolean;
	filesChanged: number;
	rolledBack: boolean;
	plannedFiles: number;
	partial: boolean;
	dryRun: boolean;
	conflicts: Array<{ file: string; reason: string }>;
	rewrites: Array<{ file: string; newSpecifier: string }>;
	journalEntryId?: string;
	error?: string;
	typecheck?: { success: boolean };
}

async function makeInlineProject(
	kind: "mixed" | "named" | "namespace",
	files: Record<string, string> = {}
) {
	const fixture = await makeProject({
		name: `mcp-inline-${kind}`,
		outsideRepo: true,
		git: true,
		tsconfig: "bundler",
		files: {
			"real.ts": "export const a = 1;\n",
			"barrel.ts": 'export { a } from "./real";\n',
			...(kind === "namespace" ? {} : { "consumer.ts": namedConsumer }),
			...(kind === "named" ? {} : { "namespace.ts": namespaceConsumer }),
			...files,
		},
	});
	return fixture;
}

async function runInline(fixture: ProjectFixture, args: string[]) {
	const result = await fixture.run(["inline", "barrel.ts", ...args], {
		env: cliEnv,
	});
	return result;
}

afterEach(() => {
	setRuntime(bunRuntime);
});

test("MCP inline refuses a mixed unforced plan before any writes or journal completion", async () => {
	const fixture = await makeInlineProject("mixed");
	const response = await inlineTool({
		barrelFile: fixture.path("barrel.ts"),
		dryRun: false,
		force: false,
		verify: true,
		journal: true,
	});
	const payload = parseMcpTextPayload<InlinePayload>(response);
	expect({
		named: await Bun.file(fixture.path("consumer.ts")).text(),
		namespace: await Bun.file(fixture.path("namespace.ts")).text(),
		filesChanged: payload.filesChanged,
		success: payload.success,
		isError: response.isError,
		entries: (await readOperationJournal(fixture.dir)).entries.length,
	}).toEqual({
		named: namedConsumer,
		namespace: namespaceConsumer,
		filesChanged: 0,
		success: false,
		isError: true,
		entries: 0,
	});
	expect(payload.conflicts).toHaveLength(1);
	expect(payload.conflicts[0]?.reason).toContain("namespace");
	expect(payload.rewrites).toHaveLength(1);
	expect(payload.typecheck).toBeUndefined();
	expect(payload.journalEntryId).toBeUndefined();
});

test("inline JSON applies the same bytes as human output and emits one verified report", async () => {
	const fixture = await makeInlineProject("named");
	const response = await runInline(fixture, ["--json", "--journal"]);
	expect(response.exitCode, `${response.stdout}\n${response.stderr}`).toBe(0);
	expect(await Bun.file(fixture.path("consumer.ts")).text()).toBe(
		namedConsumer.replace("./barrel", "./real")
	);
	const payload = JSON.parse(response.stdout) as InlinePayload;
	expect(response.exitCode).toBe(0);
	expect(response.stderr).toBe("");
	expect(payload.success).toBe(true);
	expect(payload.filesChanged).toBe(1);
	expect(payload.typecheck?.success).toBe(true);
	expect(payload.journalEntryId).toBeDefined();
	expect((await readOperationJournal(fixture.dir)).entries).toHaveLength(1);
	const humanFixture = await makeInlineProject("named");
	const human = await runInline(humanFixture, []);
	expect(human.exitCode, human.stderr).toBe(0);
	expect(human.stdout).toContain("Type checking passed");
	expect(await Bun.file(humanFixture.path("consumer.ts")).text()).toBe(
		await Bun.file(fixture.path("consumer.ts")).text()
	);
});

test.each([
	"namespace",
	"mixed",
] as const)("MCP inline previews %s conflicts without writes and refuses apply", async (kind) => {
	const fixture = await makeInlineProject(kind);
	for (const dryRun of [false, true]) {
		const response = await inlineTool({
			barrelFile: fixture.path("barrel.ts"),
			dryRun,
			force: false,
			verify: true,
			journal: true,
		});
		const payload = parseMcpTextPayload<InlinePayload>(response);
		expect(response.isError).toBe(dryRun ? undefined : true);
		expect(payload.filesChanged).toBe(0);
		expect(payload.plannedFiles).toBe(kind === "mixed" ? 1 : 0);
		expect(payload.conflicts).toHaveLength(1);
		expect(payload.typecheck).toBeUndefined();
		expect(payload.journalEntryId).toBeUndefined();
	}
	expect(await Bun.file(fixture.path("namespace.ts")).text()).toBe(
		namespaceConsumer
	);
	if (kind === "mixed") {
		expect(await Bun.file(fixture.path("consumer.ts")).text()).toBe(
			namedConsumer
		);
	}
	expect((await readOperationJournal(fixture.dir)).entries).toHaveLength(0);
});

test.each([
	false,
	true,
])("MCP inline force=%s applies only supported imports and verifies the actual changes", async (force) => {
	const fixture = await makeInlineProject(force ? "mixed" : "named");
	const response = await inlineTool({
		barrelFile: fixture.path("barrel.ts"),
		dryRun: false,
		force,
		verify: true,
		journal: true,
	});
	const payload = parseMcpTextPayload<InlinePayload>(response);
	expect(response.isError).toBeUndefined();
	expect(payload.success).toBe(!force);
	expect(payload.partial).toBe(force);
	expect(payload.filesChanged).toBe(1);
	expect(payload.typecheck?.success).toBe(true);
	expect(payload.journalEntryId).toBeDefined();
	expect(await Bun.file(fixture.path("consumer.ts")).text()).toBe(
		namedConsumer.replace("./barrel", "./real")
	);
	if (force) {
		expect(payload.conflicts).toHaveLength(1);
		expect(await Bun.file(fixture.path("namespace.ts")).text()).toBe(
			namespaceConsumer
		);
	}
	expect((await readOperationJournal(fixture.dir)).entries).toHaveLength(1);
});

test.each([
	{ dryRun: false, force: false },
	{ dryRun: true, force: false },
	{ dryRun: true, force: true },
	{ dryRun: false, force: true },
])("CLI human and JSON share mixed-plan policy %j", async ({
	dryRun,
	force,
}) => {
	for (const json of [false, true]) {
		const fixture = await makeInlineProject("mixed");
		const args = [
			"--journal",
			...(json ? ["--json"] : []),
			...(dryRun ? ["--dry-run"] : []),
			...(force ? ["--force"] : []),
		];
		const response = await runInline(fixture, args);
		const applied = force && !dryRun;
		expect(response.exitCode).toBe(dryRun ? 0 : 1);
		expect(await Bun.file(fixture.path("consumer.ts")).text()).toBe(
			applied ? namedConsumer.replace("./barrel", "./real") : namedConsumer
		);
		expect(await Bun.file(fixture.path("namespace.ts")).text()).toBe(
			namespaceConsumer
		);
		expect((await readOperationJournal(fixture.dir)).entries).toHaveLength(
			applied ? 1 : 0
		);
		if (json) {
			const payload = JSON.parse(response.stdout) as InlinePayload;
			expect(payload.filesChanged).toBe(applied ? 1 : 0);
			expect(payload.plannedFiles).toBe(1);
			expect(payload.partial).toBe(applied);
			expect(payload.conflicts).toHaveLength(1);
			expect(payload.rewrites).toHaveLength(1);
		} else if (!applied) {
			expect(response.stdout).not.toContain("Rewrote");
		}
	}
});

test("MCP inline rolls back a failed closing check and completes no journal entry", async () => {
	const fixture = await makeInlineProject("named");
	let checks = 0;
	setRuntime({
		...bunRuntime,
		process: {
			exec: async (args, options) => {
				if (args[0] === "git") {
					return bunRuntime.process.exec(args, options);
				}
				checks++;
				const exitCode = checks === 1 ? 0 : 1;
				return {
					exitCode,
					stdout: exitCode
						? "consumer.ts(1,1): error TS2322: injected closing failure"
						: "",
					stderr: "",
					outputTruncated: false,
					termination: { kind: "exit", exitCode },
				};
			},
		},
	});
	const response = await inlineTool({
		barrelFile: fixture.path("barrel.ts"),
		dryRun: false,
		force: false,
		verify: true,
		journal: true,
	});
	const payload = parseMcpTextPayload<InlinePayload>(response);
	expect(checks).toBe(2);
	expect(payload.success).toBe(false);
	expect(payload.rolledBack).toBe(true);
	expect(payload.filesChanged).toBe(0);
	expect(payload.typecheck?.success).toBe(false);
	expect(await Bun.file(fixture.path("consumer.ts")).text()).toBe(
		namedConsumer
	);
	expect((await readOperationJournal(fixture.dir)).entries).toHaveLength(0);
});

test.each([
	"verification",
	"write",
	"journal",
] as const)("inline JSON reports actual effects after %s failure", async (failure) => {
	const runtimeModule = path.resolve(import.meta.dir, "runtime/index.ts");
	const preload = `import { bunRuntime, setRuntime } from ${JSON.stringify(runtimeModule)};
let checks = 0;
const failure = ${JSON.stringify(failure)};
setRuntime({ ...bunRuntime, fs: { ...bunRuntime.fs, writeFile: async (name, text) => {
  if (failure === "journal" && name.includes(${JSON.stringify(JOURNAL_RELATIVE_PATH)})) throw new Error("injected journal write failure");
  await bunRuntime.fs.writeFile(name, text);
  if (failure === "write" && name.endsWith("/consumer.ts")) throw new Error("injected inline write failure");
}}, process: { exec: async (args, options) => {
  if (args[0] === "git") return bunRuntime.process.exec(args, options);
  const exitCode = ++checks > 1 && failure === "verification" ? 1 : 0;
  return { exitCode, stdout: exitCode ? "consumer.ts(1,1): error TS2322: injected closing failure" : "", stderr: "", outputTruncated: false, termination: { kind: "exit", exitCode } };
}} });`;
	const fixture = await makeInlineProject("named", { "inject.js": preload });
	const child = Bun.spawn(
		[
			process.execPath,
			"--preload",
			fixture.path("inject.js"),
			...CLI.slice(1),
			"inline",
			"barrel.ts",
			"--json",
			"--journal",
		],
		{ cwd: fixture.dir, stdout: "pipe", stderr: "pipe" }
	);
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	const payload = JSON.parse(stdout) as InlinePayload;
	expect(exitCode, stderr).toBe(1);
	expect(payload.success).toBe(false);
	expect(payload.rolledBack).toBe(failure !== "journal");
	expect(payload.filesChanged).toBe(failure === "journal" ? 1 : 0);
	if (failure === "verification") {
		expect(payload.typecheck?.success).toBe(false);
	} else if (failure === "write") {
		expect(payload.error).toContain("injected inline write failure");
		expect(stderr).toContain("Changes were rolled back");
	} else {
		expect(payload.error).toContain("injected journal write failure");
	}
	expect(payload.journalEntryId).toBeUndefined();
	expect(await Bun.file(fixture.path("consumer.ts")).text()).toBe(
		failure === "journal"
			? namedConsumer.replace("./barrel", "./real")
			: namedConsumer
	);
	expect((await readOperationJournal(fixture.dir)).entries).toHaveLength(0);
});

test.each([
	"no-op",
	"impure",
	"dirty",
] as const)("inline JSON keeps a single document for %s outcomes", async (kind) => {
	const files: Record<string, string> = {};
	if (kind === "no-op") {
		files["consumer.ts"] = "export const value = 1;\n";
	} else if (kind === "impure") {
		files["barrel.ts"] = "export const a = 1;\n";
	}
	const fixture = await makeInlineProject("named", files);
	if (kind === "dirty") {
		await Bun.write(
			fixture.path("consumer.ts"),
			`${namedConsumer}// retained edit\n`
		);
	}
	const before = await Bun.file(fixture.path("consumer.ts")).text();
	const response = await runInline(fixture, ["--json", "--journal"]);
	const payload = JSON.parse(response.stdout) as InlinePayload;
	expect(response.exitCode).toBe(kind === "no-op" ? 0 : 1);
	expect(payload.filesChanged).toBe(0);
	expect(payload.typecheck).toBeUndefined();
	expect(payload.journalEntryId).toBeUndefined();
	expect(await Bun.file(fixture.path("consumer.ts")).text()).toBe(before);
	expect((await readOperationJournal(fixture.dir)).entries).toHaveLength(0);
});
