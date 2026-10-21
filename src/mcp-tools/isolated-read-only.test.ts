import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { cleanup, makeFixture } from "../commands/__test-helpers.ts";
import { setAnalysisProcessObserver } from "../core/analysis-process.ts";
import { setLargeProjectSourceFiles } from "../core/project-scale.ts";
import {
	type ReadOnlyWorkerJob,
	runIsolatedReadOnlyTool,
	setIsolatedReadOnlyTools,
	shouldIsolateReadOnlyTool,
} from "./isolated-read-only.ts";
import { runProcessJob } from "./read-only-worker.ts";

test("standalone read-only isolation keeps small projects warm and preserves every isolated report", async () => {
	const directory = await mkdtemp(
		path.join(tmpdir(), "resect-isolated-tools-")
	);
	try {
		await Bun.write(
			path.join(directory, "tsconfig.json"),
			JSON.stringify({ include: ["*.ts"] })
		);
		await Bun.write(
			path.join(directory, "package.json"),
			JSON.stringify({ name: "isolated-tool-fixture", private: true })
		);
		const source = path.join(directory, "source.ts");
		const code =
			"export function calculate(value: number) { const next = value + 2; return next * next; }";
		await Bun.write(source, code);
		await Bun.write(path.join(directory, "second.ts"), code);
		const jobs: ReadOnlyWorkerJob[] = [
			{ kind: "analyze", args: [source] },
			{ kind: "audit", args: [directory, {}] },
			{ kind: "find", args: ["calculate", directory] },
			{ kind: "similar", args: [directory, { maxGroups: 0 }] },
			{ kind: "unused", args: [directory, {}] },
			{ kind: "find", args: ["missing", path.join(directory, "missing")] },
		];
		let processes = 0;
		setAnalysisProcessObserver(() => {
			processes++;
		});
		setIsolatedReadOnlyTools(true);
		for (const job of jobs) {
			expect(await shouldIsolateReadOnlyTool(job)).toBe(false);
			expect(await runProcessJob(job)).toBeDefined();
		}
		expect(processes).toBe(0);
		setLargeProjectSourceFiles(0);
		for (const job of jobs) {
			setIsolatedReadOnlyTools(false);
			const expected = await runProcessJob(job);
			setIsolatedReadOnlyTools(true);
			expect(await runProcessJob(job)).toEqual(expected);
		}
		expect(processes).toBe(jobs.length);
		expect(
			runIsolatedReadOnlyTool({
				kind: "analyze",
				args: [path.join(directory, "missing.ts"), { project: directory }],
			})
		).rejects.toThrow("Could not parse");
	} finally {
		setIsolatedReadOnlyTools(false);
		setLargeProjectSourceFiles(undefined);
		setAnalysisProcessObserver(undefined);
		await rm(directory, { recursive: true, force: true });
	}
});

test("isolation sizes ancestor and explicit projects instead of the report directory", async () => {
	const directory = await makeFixture("isolation-scope", {
		"tsconfig.json": JSON.stringify({ include: ["src/*.ts"] }),
		"src/first.ts": "export const first = 1;",
		"src/second.ts": "export const second = 2;",
		"other/placeholder.txt": "",
	});
	try {
		const sourceDirectory = path.join(directory, "src");
		const source = path.join(sourceDirectory, "first.ts");
		setLargeProjectSourceFiles(2);
		setIsolatedReadOnlyTools(true);
		const jobs: ReadOnlyWorkerJob[] = [
			{ kind: "analyze", args: [source] },
			{ kind: "audit", args: [sourceDirectory, {}] },
			{ kind: "unused", args: [sourceDirectory, {}] },
			{ kind: "similar", args: [sourceDirectory, {}] },
		];
		for (const project of [directory, path.join(directory, "tsconfig.json")]) {
			const reportDirectory = path.join(directory, "other");
			jobs.push(
				{ kind: "analyze", args: [source, { project }] },
				{ kind: "audit", args: [reportDirectory, { project }] },
				{ kind: "unused", args: [reportDirectory, { project }] },
				{ kind: "similar", args: [sourceDirectory, { project }] }
			);
		}
		for (const job of jobs) {
			expect(await shouldIsolateReadOnlyTool(job)).toBe(true);
		}
		// find scans configs below its explicit directory; it does not walk up.
		expect(
			await shouldIsolateReadOnlyTool({
				kind: "find",
				args: ["first", sourceDirectory],
			})
		).toBe(false);
		expect(
			await shouldIsolateReadOnlyTool({
				kind: "find",
				args: ["first", directory],
			})
		).toBe(true);
		for (const job of jobs.slice(0, 4)) {
			setIsolatedReadOnlyTools(false);
			const expected = await runProcessJob(job);
			setIsolatedReadOnlyTools(true);
			expect(await runProcessJob(job)).toEqual(expected);
		}
	} finally {
		setIsolatedReadOnlyTools(false);
		setLargeProjectSourceFiles(undefined);
		await cleanup(directory);
	}
});

test("workspace isolation counts unique sources across sibling projects", async () => {
	const directory = await makeFixture("isolation-workspace", {
		"package.json": JSON.stringify({
			private: true,
			workspaces: ["packages/*"],
		}),
		"packages/a/package.json": JSON.stringify({ name: "a" }),
		"packages/a/tsconfig.json": JSON.stringify({
			include: ["src/*.ts", "../../shared/*.ts"],
		}),
		"packages/a/src/a.ts": "export const a = 1;",
		"packages/b/package.json": JSON.stringify({ name: "b" }),
		"packages/b/tsconfig.json": JSON.stringify({
			include: ["src/*.ts", "../../shared/*.ts"],
		}),
		"packages/b/src/b.ts": "export const b = 2;",
		"shared/value.ts": "export const value = 3;",
	});
	try {
		const projectDirectory = path.join(directory, "packages/a");
		const sourceDirectory = path.join(projectDirectory, "src");
		setIsolatedReadOnlyTools(true);
		for (const kind of ["audit", "unused"] as const) {
			for (const project of [
				undefined,
				projectDirectory,
				path.join(projectDirectory, "tsconfig.json"),
			]) {
				const job: ReadOnlyWorkerJob = {
					kind,
					args: [sourceDirectory, { project, workspace: true }],
				};
				setLargeProjectSourceFiles(3);
				expect(
					await shouldIsolateReadOnlyTool({
						kind,
						args: [sourceDirectory, { project }],
					})
				).toBe(false);
				expect(await shouldIsolateReadOnlyTool(job)).toBe(true);
				setLargeProjectSourceFiles(4);
				expect(await shouldIsolateReadOnlyTool(job)).toBe(false);
			}
			const job: ReadOnlyWorkerJob = {
				kind,
				args: [sourceDirectory, { workspace: true }],
			};
			setLargeProjectSourceFiles(3);
			setIsolatedReadOnlyTools(false);
			const expected = await runProcessJob(job);
			setIsolatedReadOnlyTools(true);
			expect(await runProcessJob(job)).toEqual(expected);
		}
	} finally {
		setIsolatedReadOnlyTools(false);
		setLargeProjectSourceFiles(undefined);
		await cleanup(directory);
	}
});
