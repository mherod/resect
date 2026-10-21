import { mkdir, rename, unlink } from "node:fs/promises";
import path from "node:path";
import type { GraphScanJob } from "../../src/core/analysis-worker.ts";
import { runAnalysisJobs } from "../../src/core/analysis-workers.ts";
import {
	buildDependencyGraph,
	type DependencyGraph,
} from "../../src/core/graph.ts";
import { loadProject } from "../../src/core/project.ts";
import { MEMORY_LIMIT_BYTES, measureProcess } from "./process.ts";
import { gitOutput, VSCODE_REVISION, validateFixture } from "./vscode.ts";

function graphHash(graph: DependencyGraph, fixture: string): string {
	const hasher = new Bun.CryptoHasher("sha256");
	const append = (value: unknown) => {
		hasher.update(
			`${JSON.stringify(value).replaceAll(fixture, "<fixture>")}\n`
		);
	};
	for (const [name, records] of [
		["imports", graph.imports],
		["importedBy", graph.importedBy],
		["barrels", graph.barrelReExports],
		["barrelFiles", graph.barrelFiles],
		["skipped", graph.skippedFiles],
	] as const) {
		append(name);
		for (const record of records) {
			append(record);
		}
	}
	append("exports");
	for (const [file, metadata] of graph.sourceMetadata ?? []) {
		append([file, metadata.exports]);
	}
	return hasher.digest("hex");
}

async function scenario(fixture: string): Promise<void> {
	const owner = await Bun.file(
		path.join(fixture, "../fixture-owner.json")
	).json();
	if (owner.fixture !== fixture || owner.source === fixture) {
		throw new Error("Expected a disposable fixture created by this benchmark");
	}
	await validateFixture(fixture);
	const config = path.join(fixture, "src/tsconfig.json");
	const source = path.join(fixture, "src/vs/base/common/lifecycle.ts");
	const added = path.join(fixture, "src/vs/base/common/resectBenchmark.ts");
	const moved = path.join(
		fixture,
		"src/vs/base/common/resectBenchmarkMoved.ts"
	);
	const original = await Bun.file(source).text();
	for (const file of [added, moved]) {
		if (await Bun.file(file).exists()) {
			throw new Error(`Benchmark path already exists: ${file}`);
		}
	}
	let previous: DependencyGraph | undefined;
	const check = async (label: string) => {
		const project = loadProject(config);
		const start = performance.now();
		const graph = await buildDependencyGraph(project, { retainProgram: false });
		const elapsedMs = performance.now() - start;
		const cacheHit = graph === previous;
		previous = graph;
		const [fresh] = await runAnalysisJobs<GraphScanJob, DependencyGraph>([
			{ kind: "graph", project },
		]);
		const hash = graphHash(graph, fixture);
		if (!fresh || hash !== graphHash(fresh, fixture)) {
			throw new Error(`${label}: fresh graph differs`);
		}
		console.log(
			JSON.stringify({
				label,
				elapsedMs,
				files: graph.imports.size,
				cacheHit,
				parsedFiles: cacheHit ? 0 : graph.inputs?.parsedFiles,
				hash,
				freshParity: true,
			})
		);
	};
	try {
		await check("cold");
		await check("warm");
		await Bun.write(
			source,
			`${original}\nexport const resectBenchmarkValue = 1;\n`
		);
		await check("edit");
		await Bun.write(
			added,
			"export { resectBenchmarkValue } from './lifecycle.js';\n"
		);
		await check("add");
		await rename(added, moved);
		await check("rename");
		await unlink(moved);
		await check("delete");
		await Bun.write(source, original);
		await Bun.write(added, "export const resectBenchmarkMixed = 1;\n");
		await check("mixed");
	} finally {
		await Bun.write(source, original);
		for (const file of [added, moved]) {
			if (await Bun.file(file).exists()) {
				await unlink(file);
			}
		}
	}
	await validateFixture(fixture);
}

const fixture = path.resolve(Bun.argv[2] ?? "");
if (Bun.argv[3] === "--child") {
	await scenario(fixture);
} else {
	const output = path.resolve(Bun.argv[3] ?? "");
	await validateFixture(fixture);
	if (output === fixture || output.startsWith(`${fixture}${path.sep}`)) {
		throw new Error("Output must be outside fixture");
	}
	await mkdir(output);
	const copy = path.join(output, "fixture");
	await gitOutput(fixture, [
		"clone",
		"--shared",
		"--no-hardlinks",
		fixture,
		copy,
	]);
	await validateFixture(copy);
	await Bun.write(
		path.join(output, "fixture-owner.json"),
		JSON.stringify({ source: fixture, fixture: copy })
	);
	const receipts: Array<
		Awaited<ReturnType<typeof measureProcess>> & { run: number }
	> = [];
	for (let run = 1; run <= 3; run++) {
		const result = await measureProcess(
			[process.execPath, import.meta.filename, copy, "--child"],
			copy,
			path.join(output, `edits-${run}`),
			300_000
		);
		receipts.push({ run, ...result });
		await Bun.write(
			path.join(output, "receipt.json"),
			JSON.stringify(
				{
					fixtureRevision: VSCODE_REVISION,
					resectRevision: await gitOutput(import.meta.dir, [
						"rev-parse",
						"HEAD",
					]),
					resectStatus: await gitOutput(import.meta.dir, [
						"status",
						"--porcelain",
					]),
					bun: Bun.version,
					memoryScope:
						"Whole process including independent fresh-reference workers and comparison serialization",
					receipts,
				},
				null,
				2
			)
		);
		console.log(JSON.stringify(receipts.at(-1)));
		if (
			result.exitCode !== 0 ||
			result.timedOut ||
			result.peakRssBytes === null ||
			result.peakRssBytes > MEMORY_LIMIT_BYTES
		) {
			throw new Error(
				"Graph edit scenario failed or exceeded its memory budget"
			);
		}
	}
	await validateFixture(fixture);
	await validateFixture(copy);
}
