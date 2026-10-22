import { mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { MoveSession } from "../../src/commands/move-session.ts";
import { mapConcurrent } from "../../src/core/concurrency.ts";
import { buildDependencyGraph } from "../../src/core/graph.ts";
import { loadProject } from "../../src/core/project.ts";
import type { MoveResult } from "../../src/types/move.ts";
import { MEMORY_LIMIT_BYTES, measureProcess } from "./process.ts";

const repository = path.resolve(import.meta.dir, "../..");
const moveCount = 20;
const lookups = 10_000;

function hash(value: unknown, fixture: string): string {
	return new Bun.CryptoHasher("sha256")
		.update(JSON.stringify(value).replaceAll(fixture, "<fixture>"))
		.digest("hex");
}

async function child(fixture: string, dryRun: boolean) {
	const project = loadProject(path.join(fixture, "tsconfig.json"));
	const buildStart = performance.now();
	const graph = await buildDependencyGraph(project, { retainProgram: false });
	const graphBuildMs = performance.now() - buildStart;
	const counters = {
		fullImportSweeps: 0,
		sweptEdges: 0,
		reverseRebuilds: 0,
		barrelSweeps: 0,
		fetchedReferenceRecords: 0,
	};
	const values = graph.imports.values.bind(graph.imports);
	graph.imports.values = function* () {
		counters.fullImportSweeps++;
		for (const references of values()) {
			counters.sweptEdges += references.length;
			yield references;
		}
		return undefined;
	};
	const clear = graph.importedBy.clear.bind(graph.importedBy);
	graph.importedBy.clear = () => {
		counters.reverseRebuilds++;
		clear();
	};
	const barrelEntries = graph.barrelReExports[Symbol.iterator].bind(
		graph.barrelReExports
	);
	graph.barrelReExports[Symbol.iterator] = function* () {
		counters.barrelSweeps++;
		yield* barrelEntries();
		return undefined;
	};
	for (const references of [graph.imports, graph.importedBy]) {
		const get = references.get.bind(references);
		references.get = (file) => {
			const result = get(file);
			counters.fetchedReferenceRecords += result?.length ?? 0;
			return result;
		};
	}
	const start = performance.now();
	const session = new MoveSession(project, graph, dryRun);
	const original = path.join(fixture, "src/value.ts");
	let source = original;
	const reports: MoveResult[] = [];
	for (let step = 0; step < moveCount; step++) {
		const target = path.join(fixture, `src/step-${step}/value.ts`);
		const result = await session.move(source, target);
		if (!result.success) {
			throw new Error(JSON.stringify(result));
		}
		reports.push(result);
		source = target;
	}
	const mutationMs = performance.now() - start;
	const mutationCounters = { ...counters };
	let destinationMapConstructions = 0;
	const OriginalMap = globalThis.Map;
	globalThis.Map = class<Key, Value> extends OriginalMap<Key, Value> {
		constructor(entries?: Iterable<readonly [Key, Value]> | null) {
			super(entries);
			destinationMapConstructions++;
		}
	};
	const translateStart = performance.now();
	try {
		for (let query = 0; query < lookups; query++) {
			if (session.translateBeforeFile(original) !== source) {
				throw new Error("Incorrect final path");
			}
		}
	} finally {
		globalThis.Map = OriginalMap;
	}
	const translationMs = performance.now() - translateStart;
	const contents: [string, string][] = [];
	for (const file of [
		source,
		path.join(fixture, "src/consumer-a.ts"),
		path.join(fixture, "src/consumer-b.ts"),
	]) {
		contents.push([file, await session.context.readFile(file)]);
	}
	const graphHasher = new Bun.CryptoHasher("sha256");
	for (const [label, records] of [
		["imports", graph.imports],
		["importedBy", graph.importedBy],
		["barrels", graph.barrelReExports],
	] as const) {
		graphHasher.update(label);
		for (const key of [...records.keys()].sort()) {
			graphHasher.update(
				JSON.stringify([key, records.get(key)]).replaceAll(fixture, "<fixture>")
			);
		}
	}
	return {
		dryRun,
		files: graph.imports.size,
		moves: moveCount,
		graphBuildMs,
		mutationMs,
		translationMs,
		lookups,
		destinationMapConstructions,
		counters: mutationCounters,
		outputHash: hash({ reports, contents }, fixture),
		graphHash: graphHasher.digest("hex"),
		sourceUnchanged: await Bun.file(original).exists(),
	};
}

async function makeFixture(directory: string, unrelatedFiles: number) {
	await mkdir(path.join(directory, "src"), { recursive: true });
	await Bun.write(
		path.join(directory, "tsconfig.json"),
		JSON.stringify({
			compilerOptions: {
				target: "ESNext",
				module: "ESNext",
				moduleResolution: "Bundler",
				noEmit: true,
			},
			include: ["src/**/*.ts"],
		})
	);
	await Bun.write(
		path.join(directory, "src/value.ts"),
		"export const value = 1;\n"
	);
	await Bun.write(
		path.join(directory, "src/shared.ts"),
		"export const shared = 1;\n"
	);
	for (const consumer of ["a", "b"]) {
		await Bun.write(
			path.join(directory, `src/consumer-${consumer}.ts`),
			'import { value } from "./value";\nexport const used = value;\n'
		);
	}
	await mapConcurrent(
		Array.from({ length: unrelatedFiles }, (_, index) => index + 1),
		async (index) => {
			await Bun.write(
				path.join(directory, `src/noise-${String(index).padStart(5, "0")}.ts`),
				`import { shared } from "./shared";\nexport const value${index} = shared + ${index};\n`
			);
		},
		{ concurrency: 16 }
	);
}

if (Bun.argv[2] === "--child") {
	const fixture = Bun.argv[3];
	if (!fixture) {
		throw new Error("Missing child fixture");
	}
	console.log(JSON.stringify(await child(fixture, Bun.argv[4] === "preview")));
} else {
	const destination = Bun.argv[2];
	if (!destination) {
		throw new Error(
			"Usage: bun scripts/benchmarks/move-session.ts <new-output-directory> [baseline-directory]"
		);
	}
	const output = path.resolve(destination);
	const baseline = Bun.argv[3] ? path.resolve(Bun.argv[3]) : undefined;
	await mkdir(output);
	const revisionProcess = Bun.spawn(["git", "rev-parse", "HEAD"], {
		cwd: repository,
		stdout: "pipe",
	});
	const revision = (await new Response(revisionProcess.stdout).text()).trim();
	if ((await revisionProcess.exited) !== 0) {
		throw new Error("Could not read source revision");
	}
	const diffProcess = Bun.spawn(["git", "diff", "--binary", "HEAD"], {
		cwd: repository,
		stdout: "pipe",
	});
	const sourceDiff = await new Response(diffProcess.stdout).text();
	await Bun.write(path.join(output, "source.diff"), sourceDiff);
	if ((await diffProcess.exited) !== 0) {
		throw new Error("Could not read source diff");
	}
	const sourceDiffHash = new Bun.CryptoHasher("sha256")
		.update(sourceDiff)
		.digest("hex");
	const benchmarkHash = new Bun.CryptoHasher("sha256")
		.update(await Bun.file(import.meta.filename).text())
		.digest("hex");
	const receipts: (Awaited<ReturnType<typeof measureProcess>> &
		Awaited<ReturnType<typeof child>> & { name: string })[] = [];
	const hashes = new Map<string, string>();
	await Bun.write(
		path.join(output, "metadata.json"),
		JSON.stringify(
			{
				revision,
				sourceDiffHash,
				benchmarkHash,
				bun: Bun.version,
				platform: process.platform,
				arch: process.arch,
				cpu: os.cpus()[0]?.model,
				memoryBytes: os.totalmem(),
				moveCount,
				lookups,
				runs: 3,
				filesystem:
					"Local APFS; fresh fixture per process; normal OS caches; no concurrent local tests/builds/benchmarks",
				scope:
					"Fresh process, graph construction and 20 real in-process session moves; native process peak includes parser threads; no compiler verification",
			},
			null,
			2
		)
	);
	for (const size of [50, 5000]) {
		for (const mode of ["preview", "apply"]) {
			for (const run of [1, 2, 3]) {
				const name = `${size}-${mode}-${run}`;
				const fixture = path.join(output, `${name}-fixture`);
				await makeFixture(fixture, size);
				const measured = await measureProcess(
					[process.execPath, import.meta.filename, "--child", fixture, mode],
					repository,
					path.join(output, name),
					300_000
				);
				if (
					measured.exitCode !== 0 ||
					!measured.peakRssBytes ||
					measured.peakRssBytes >= MEMORY_LIMIT_BYTES
				) {
					throw new Error(JSON.stringify({ name, measured }));
				}
				const report = (await Bun.file(
					path.join(output, `${name}.stdout`)
				).json()) as Awaited<ReturnType<typeof child>>;
				const key = `${size}-${mode}`;
				const completeHash = `${report.outputHash}:${report.graphHash}`;
				if (hashes.has(key) && hashes.get(key) !== completeHash) {
					throw new Error(`Repeated output drift: ${name}`);
				}
				hashes.set(key, completeHash);
				if (
					report.files !== size + 4 ||
					report.sourceUnchanged !== (mode === "preview")
				) {
					throw new Error(`Fixture or mutation mode mismatch: ${name}`);
				}
				if (baseline) {
					const expected = (await Bun.file(
						path.join(baseline, `${name}.stdout`)
					).json()) as Awaited<ReturnType<typeof child>>;
					if (
						expected.outputHash !== report.outputHash ||
						expected.graphHash !== report.graphHash
					) {
						throw new Error(`Baseline parity failed: ${name}`);
					}
				}
				const receipt = { name, ...measured, ...report };
				receipts.push(receipt);
				await Bun.write(
					path.join(output, "receipts.json"),
					JSON.stringify(receipts, null, 2)
				);
				console.log(JSON.stringify(receipt));
			}
		}
	}
}
