import { afterAll, describe, expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { readOperationJournal } from "../core/journal.ts";
import { CLI, cleanup, makeTempDir, runGitCommand } from "./__test-helpers.ts";

const tempDirs: string[] = [];

afterAll(async () => {
	for (const dir of tempDirs) {
		await cleanup(dir);
	}
});

async function makeRepository(
	name: string,
	files: Record<string, string>,
	tsconfig: Record<string, unknown> = {
		compilerOptions: { noEmit: true, strict: true },
		include: ["src/**/*.ts"],
	}
): Promise<string> {
	const dir = await makeTempDir(name);
	tempDirs.push(dir);
	await Bun.write(path.join(dir, "tsconfig.json"), JSON.stringify(tsconfig));
	for (const [relativePath, content] of Object.entries(files)) {
		const file = path.join(dir, relativePath);
		await mkdir(path.dirname(file), { recursive: true });
		await Bun.write(file, content);
	}
	await runGitCommand(dir, ["init", "--template="]);
	await runGitCommand(dir, ["add", "."]);
	await runGitCommand(dir, [
		"-c",
		"user.name=Resect Test",
		"-c",
		"user.email=resect@example.invalid",
		"commit",
		"-m",
		"initial",
	]);
	return dir;
}

async function runCli(
	dir: string,
	...args: string[]
): Promise<{ exitCode: number | null; stderr: string; stdout: string }> {
	const process = Bun.spawn([...CLI, ...args], {
		cwd: dir,
		env: {
			...globalThis.process.env,
			PATH: `${path.resolve(import.meta.dir, "../../node_modules/.bin")}${path.delimiter}${globalThis.process.env.PATH ?? ""}`,
		},
		stderr: "pipe",
		stdout: "pipe",
	});
	const [stdout, stderr] = await Promise.all([
		new Response(process.stdout).text(),
		new Response(process.stderr).text(),
	]);
	await process.exited;
	return { exitCode: process.exitCode, stderr, stdout };
}

async function readJournalSummary(
	dir: string
): Promise<{ command: string | undefined; entryCount: number }> {
	const journal = await readOperationJournal(dir);
	return {
		command: journal.entries[0]?.command,
		entryCount: journal.entries.length,
	};
}

describe("journaled CLI mutations", () => {
	test("move records an entry that the undo command restores", async () => {
		const dir = await makeRepository("journal-move", {
			"src/a.ts": "export const value = 1;\n",
			"src/use.ts": 'import { value } from "./a";\nexport { value };\n',
		});
		const project = path.join(dir, "tsconfig.json");
		const source = path.join(dir, "src/a.ts");
		const target = path.join(dir, "src/moved/a.ts");
		const move = await runCli(
			dir,
			"move",
			source,
			target,
			"--project",
			project,
			"--journal",
			"--no-verify",
			"--json"
		);

		expect(move.exitCode, move.stderr).toBe(0);
		expect(await readJournalSummary(dir)).toEqual({
			command: "move",
			entryCount: 1,
		});
		expect(await Bun.file(target).exists()).toBe(true);

		const undo = await runCli(
			dir,
			"undo",
			"--project",
			project,
			"--no-verify",
			"--json"
		);
		expect(undo.exitCode, undo.stderr).toBe(0);
		expect(await Bun.file(source).exists()).toBe(true);
		expect(await Bun.file(target).exists()).toBe(false);
	});

	test("rename records an entry when journaling is enabled", async () => {
		const dir = await makeRepository("journal-rename", {
			"src/a.ts": "export const before = 1;\n",
			"src/use.ts": 'import { before } from "./a";\nexport { before };\n',
		});
		const result = await runCli(
			dir,
			"rename",
			path.join(dir, "src/a.ts"),
			"before",
			"after",
			"--project",
			path.join(dir, "tsconfig.json"),
			"--journal",
			"--no-verify",
			"--json"
		);

		expect(result.exitCode, result.stderr).toBe(0);
		expect(await readJournalSummary(dir)).toEqual({
			command: "rename",
			entryCount: 1,
		});
	});

	test("alias records an entry when journaling is enabled", async () => {
		const dir = await makeRepository(
			"journal-alias",
			{
				"src/a.ts": "export const value = 1;\n",
				"src/use.ts": 'import { value } from "./a";\nexport { value };\n',
			},
			{
				compilerOptions: {
					baseUrl: ".",
					noEmit: true,
					paths: { "@/*": ["src/*"] },
					strict: true,
				},
				include: ["src/**/*.ts"],
			}
		);
		const result = await runCli(
			dir,
			"alias",
			path.join(dir, "src/use.ts"),
			"--prefer",
			"alias",
			"--project",
			path.join(dir, "tsconfig.json"),
			"--journal",
			"--no-verify",
			"--json"
		);

		expect(result.exitCode, result.stderr).toBe(0);
		expect(await readJournalSummary(dir)).toEqual({
			command: "alias",
			entryCount: 1,
		});
	});

	test("tidy --fix records its successful fix batch", async () => {
		const dir = await makeRepository("journal-tidy", {
			"src/util.ts": `
export function helper() {
	return 1;
}

export function usedInternal() {
	return helper();
}
`,
		});
		const result = await runCli(
			dir,
			"tidy",
			path.join(dir, "src"),
			"--experimental",
			"--fix=dead-exports",
			"--journal",
			"--json"
		);

		expect(result.exitCode, result.stderr).toBe(0);
		expect(await readJournalSummary(dir)).toEqual({
			command: "tidy",
			entryCount: 1,
		});
	});
});
