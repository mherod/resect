import { mkdir } from "node:fs/promises";
import path from "node:path";
import {
	assertAppliedEdits,
	restoreMutationFixture,
} from "./mutation-fixture.ts";
import {
	MEMORY_LIMIT_BYTES,
	outputHash,
	processMemoryReceipt,
	startMcp,
} from "./process.ts";
import {
	benchmarkCases,
	gitOutput,
	toolText,
	VSCODE_REVISION,
	validateFixture,
} from "./vscode.ts";

const original = path.resolve(Bun.argv[2] ?? "");
const output = path.resolve(Bun.argv[3] ?? "");
const baseline = Bun.argv[4] ? path.resolve(Bun.argv[4]) : undefined;
const profile = Bun.argv.includes("--profile");
const apply = Bun.argv.includes("--apply");
const stopOnMemoryLimit = Bun.argv.includes("--stop-on-memory-limit");
if (stopOnMemoryLimit && !profile) {
	throw new Error("--stop-on-memory-limit requires --profile native samples");
}
await validateFixture(original);
if (output === original || output.startsWith(`${original}${path.sep}`)) {
	throw new Error("Output must be outside the fixture");
}
await mkdir(output);
const fixture = apply ? path.join(output, "fixture") : original;
if (apply) {
	await gitOutput(original, [
		"clone",
		"--shared",
		"--no-hardlinks",
		original,
		fixture,
	]);
	await gitOutput(fixture, ["config", "core.fsmonitor", "false"]);
	await validateFixture(fixture);
}
const source = path.join(fixture, "src/vs/base/common/lifecycle.ts");
const project = path.join(fixture, "src/tsconfig.json");
const target = path.join(fixture, "src/vs/base/common/resect/lifecycle.ts");
const fixtureOptions = { original, fixture, source, target, project };
const cases = [
	...benchmarkCases(fixture),
	{
		name: "rename",
		args: {
			file: source,
			oldName: "toDisposable",
			newName: "toResectDisposable",
			project,
			dryRun: !apply,
			verify: true,
		},
	},
	{
		name: "move",
		args: {
			source,
			target,
			project,
			dryRun: !apply,
			verify: true,
		},
	},
];
const receipts: unknown[] = [];
const hashes = new Map<string, string>();
let sessionFailed = false;
const session = startMcp(
	[
		process.execPath,
		...(profile
			? ["--preload", path.join(import.meta.dir, "memory-probe.ts")]
			: []),
		path.resolve(import.meta.dir, "../../bin/resect-mcp.js"),
	],
	fixture,
	path.join(output, "mcp.stderr"),
	300_000
);
await Bun.write(
	path.join(output, "metadata.json"),
	JSON.stringify(
		{
			fixture,
			fixtureRevision: VSCODE_REVISION,
			resectRevision: await gitOutput(import.meta.dir, ["rev-parse", "HEAD"]),
			resectStatus: await gitOutput(import.meta.dir, ["status", "--porcelain"]),
			bun: Bun.version,
			profile,
			stopOnMemoryLimit,
			apply,
			rounds: 3,
			memoryLimitBytes: MEMORY_LIMIT_BYTES,
		},
		null,
		2
	)
);
try {
	await session.request("initialize", {
		protocolVersion: "2024-11-05",
		capabilities: {},
		clientInfo: { name: "resect-mutation-session", version: "1" },
	});
	session.notify("notifications/initialized");
	for (const run of [1, 2, 3]) {
		for (const item of cases) {
			const start = performance.now();
			const text = toolText(
				await session.request("tools/call", {
					name: item.name,
					arguments: item.args,
				})
			);
			const elapsedMs = performance.now() - start;
			await Bun.write(path.join(output, `${item.name}-${run}.stdout`), text);
			const hash = outputHash(text, fixture);
			if (hashes.has(item.name) && hashes.get(item.name) !== hash) {
				throw new Error(`${item.name}: repeated report drift`);
			}
			hashes.set(item.name, hash);
			const report = JSON.parse(text);
			if (item.name === "move" || item.name === "rename") {
				const expectedReferences = item.name === "move" ? 4219 : 1188;
				if (
					report.success !== !apply ||
					report.updatedReferenceCount !== expectedReferences
				) {
					throw new Error(
						`${item.name}: mutation preview failed or lost references`
					);
				}
				if (baseline) {
					const expected = await Bun.file(
						path.join(baseline, `${item.name}-preview.stdout`)
					).json();
					if (JSON.stringify(report.edits) !== JSON.stringify(expected.edits)) {
						throw new Error(
							`${item.name}: complete edits differ from the full-program baseline`
						);
					}
				}
				if (apply) {
					if (
						!report.typecheck?.verificationIncomplete ||
						report.rolledBack !== (item.name === "rename")
					) {
						throw new Error(
							`${item.name}: incorrect incomplete verification or rollback`
						);
					}
					if (item.name === "move") {
						await assertAppliedEdits(fixtureOptions, report.edits, true);
						await Bun.write(
							path.join(output, `move-${run}.diff`),
							await gitOutput(fixture, ["diff", "HEAD", "--no-ext-diff"])
						);
						await restoreMutationFixture(fixtureOptions);
					}
					await validateFixture(fixture);
				}
			}
			const receipt = { name: item.name, run, elapsedMs, hash };
			receipts.push(receipt);
			console.log(JSON.stringify(receipt));
			if (stopOnMemoryLimit) {
				const samples = await Bun.file(path.join(output, "mcp.stderr")).text();
				let parentPeak = 0;
				for (const line of samples.split("\n")) {
					if (
						!(line.startsWith('{"benchmarkMemory":true,') && line.endsWith("}"))
					) {
						continue;
					}
					const sample = JSON.parse(line);
					parentPeak = Math.max(parentPeak, sample.nativePeakRssBytes ?? 0);
				}
				const memory = await processMemoryReceipt(
					undefined,
					path.join(output, "mcp.stderr"),
					parentPeak
				);
				if (!memory.peakRssBytes || memory.peakRssBytes > MEMORY_LIMIT_BYTES) {
					throw new Error(
						"Diagnostic stopped after a completed request exceeded the combined native memory limit"
					);
				}
			}
		}
	}
} finally {
	const result = await session.close();
	receipts.push({ name: "mcp-session", ...result });
	await Bun.write(
		path.join(output, "receipts.json"),
		JSON.stringify(receipts, null, 2)
	);
	console.log(JSON.stringify(result));
	if (apply) {
		await restoreMutationFixture(fixtureOptions);
	}
	await validateFixture(fixture);
	await validateFixture(original);
	sessionFailed =
		result.exitCode !== 0 ||
		!result.peakRssBytes ||
		result.peakRssBytes > MEMORY_LIMIT_BYTES;
}
if (sessionFailed) {
	throw new Error(
		"Mixed analysis/mutation session failed its exit or memory gate"
	);
}
