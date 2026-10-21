import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setAnalysisProcessObserver } from "../core/analysis-process.ts";
import {
	type ReadOnlyWorkerJob,
	runIsolatedReadOnlyTool,
	setIsolatedReadOnlyTools,
} from "./isolated-read-only.ts";
import { runProcessJob } from "./read-only-worker.ts";

test("standalone read-only isolation preserves every tool report and error result", async () => {
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
		setAnalysisProcessObserver(undefined);
		await rm(directory, { recursive: true, force: true });
	}
});
