import { mkdir, realpath } from "node:fs/promises";
import { arch, cpus, platform, totalmem } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { z } from "zod";
import {
	MEMORY_LIMIT_BYTES,
	measureProcess,
	outputHash,
	startMcp,
} from "./process.ts";

export const VSCODE_REVISION = "225a0fa530ceff3013168a5c023290d0e8a4024b";
const repository = path.resolve(import.meta.dir, "../..");

export async function gitOutput(cwd: string, args: string[]): Promise<string> {
	const child = Bun.spawn(["git", "-c", "core.fsmonitor=false", ...args], {
		cwd,
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	if (exitCode !== 0) {
		throw new Error(`git ${args.join(" ")}: ${stderr}`);
	}
	return stdout.trim();
}

export async function validateFixture(fixture: string): Promise<void> {
	if ((await gitOutput(fixture, ["rev-parse", "HEAD"])) !== VSCODE_REVISION) {
		throw new Error(`Expected VS Code revision ${VSCODE_REVISION}`);
	}
	if (
		await gitOutput(fixture, [
			"status",
			"--porcelain",
			"--untracked-files=normal",
		])
	) {
		throw new Error("The pinned VS Code fixture must be clean");
	}
}

export function benchmarkCases(fixture: string) {
	const src = path.join(fixture, "src");
	const project = path.join(src, "tsconfig.json");
	return [
		{
			name: "audit",
			cli: ["audit", src, "-p", project, "--json"],
			args: { directory: src, project },
		},
		{
			name: "analyze",
			cli: [
				"analyze",
				path.join(src, "vs/base/common/lifecycle.ts"),
				"-p",
				project,
				"--json",
			],
			args: { file: path.join(src, "vs/base/common/lifecycle.ts"), project },
		},
		{
			name: "unused",
			cli: ["unused", path.join(src, "vs/base"), "-p", project, "--json"],
			args: { directory: path.join(src, "vs/base"), project },
		},
		{
			name: "find",
			cli: ["find", "Disposable", "-p", fixture, "--type=export", "--json"],
			args: { query: "Disposable", project: fixture, type: "export" },
		},
		{
			name: "similar",
			cli: ["similar", fixture, "--json"],
			args: { directory: fixture },
		},
	];
}

const toolResultSchema = z.object({
	isError: z.boolean().optional(),
	content: z.array(z.object({ type: z.string(), text: z.string().optional() })),
});

export function toolText(value: unknown): string {
	const result = toolResultSchema.parse(value);
	if (result.isError) {
		throw new Error(JSON.stringify(result));
	}
	const text = result.content.find((block) => block.type === "text")?.text;
	if (!text) {
		throw new Error("MCP tool returned no text report");
	}
	JSON.parse(text);
	return text;
}

async function run() {
	const { values } = parseArgs({
		args: Bun.argv.slice(2),
		options: {
			fixture: { type: "string" },
			output: { type: "string" },
			baseline: { type: "string" },
			runs: { type: "string", default: "3" },
			cases: { type: "string", default: "audit,analyze,unused,find,similar" },
			surface: { type: "string", default: "all" },
		},
	});
	if (!(values.fixture && values.output)) {
		throw new Error(
			"Required: --fixture <pinned clone> --output <new directory> [--baseline <receipt directory>]"
		);
	}
	const fixture = await realpath(values.fixture);
	const output = path.resolve(values.output);
	const baseline = values.baseline ? path.resolve(values.baseline) : undefined;
	const runs = Number(values.runs);
	if (!Number.isInteger(runs) || runs < 1) {
		throw new Error("--runs must be a positive integer");
	}
	if (!["all", "cli", "mcp"].includes(values.surface)) {
		throw new Error("--surface must be all, cli, or mcp");
	}
	const names = values.cases.split(",");
	const cases = benchmarkCases(fixture).filter((item) =>
		names.includes(item.name)
	);
	if (cases.length !== names.length) {
		throw new Error("Unknown or duplicated --cases");
	}
	await validateFixture(fixture);
	if (output === fixture || output.startsWith(`${fixture}${path.sep}`)) {
		throw new Error("Output must be outside the fixture");
	}
	await mkdir(output); // Never overwrite baseline evidence.
	const metadata = {
		fixture,
		fixtureRevision: VSCODE_REVISION,
		resectRevision: await gitOutput(repository, ["rev-parse", "HEAD"]),
		resectStatus: await gitOutput(repository, ["status", "--porcelain"]),
		bun: Bun.version,
		platform: platform(),
		arch: arch(),
		cpu: cpus()[0]?.model,
		memoryBytes: totalmem(),
		runs,
		memoryLimitBytes: MEMORY_LIMIT_BYTES,
	};
	const receipts: unknown[] = [];
	const failures: string[] = [];
	const hashes = new Map<string, string>();
	const save = () =>
		Bun.write(
			path.join(output, "receipts.json"),
			JSON.stringify({ metadata, receipts, failures }, null, 2)
		);
	const checkMemory = (name: string, bytes: number | null) => {
		if (bytes === null || bytes > MEMORY_LIMIT_BYTES) {
			failures.push(
				`${name}: peak RSS ${bytes} exceeds ${MEMORY_LIMIT_BYTES} or unavailable`
			);
		}
	};
	const checkOutput = async (name: string, text: string) => {
		JSON.parse(text);
		const hash = outputHash(text, fixture);
		const expected = hashes.get(name);
		if (expected && expected !== hash) {
			failures.push(`${name}: repeated output changed`);
		}
		hashes.set(name, hash);
		if (baseline) {
			const old = await Bun.file(
				path.join(baseline, `${name}-1.stdout`)
			).text();
			const oldMetadata = await Bun.file(
				path.join(baseline, "receipts.json")
			).json();
			if (outputHash(old, oldMetadata.metadata.fixture) !== hash) {
				failures.push(`${name}: baseline output changed`);
			}
		}
		return hash;
	};
	await save();
	if (values.surface !== "mcp") {
		for (let trial = 1; trial <= runs; trial++) {
			for (const item of cases) {
				const name = `cli-${item.name}`;
				const target = path.join(output, `${name}-${trial}`);
				const result = await measureProcess(
					[
						process.execPath,
						path.join(repository, "bin/resect.js"),
						...item.cli,
					],
					fixture,
					target
				);
				checkMemory(name, result.peakRssBytes);
				if (result.exitCode !== 0 || result.timedOut) {
					failures.push(`${name}: process failed or timed out`);
				}
				const text = await Bun.file(`${target}.stdout`).text();
				const hash =
					result.exitCode === 0 ? await checkOutput(name, text) : null;
				receipts.push({ name, trial, ...result, hash });
				await save();
				console.log(JSON.stringify({ name, trial, ...result, hash }));
			}
		}
	}
	if (values.surface !== "cli") {
		const session = startMcp(
			[process.execPath, path.join(repository, "bin/resect-mcp.js")],
			fixture,
			path.join(output, "mcp.stderr")
		);
		try {
			await session.request("initialize", {
				protocolVersion: "2024-11-05",
				capabilities: {},
				clientInfo: { name: "resect-vscode-benchmark", version: "1" },
			});
			session.notify("notifications/initialized");
			const call = async (
				item: (typeof cases)[number],
				trial: number,
				concurrent = false
			) => {
				const start = performance.now();
				const text = toolText(
					await session.request("tools/call", {
						name: item.name,
						arguments: item.args,
					})
				);
				const elapsedMs = performance.now() - start;
				const name = `mcp-${item.name}`;
				await Bun.write(path.join(output, `${name}-${trial}.stdout`), text);
				const hash = await checkOutput(name, text);
				const receipt = { name, trial, concurrent, elapsedMs, hash };
				receipts.push(receipt);
				console.log(JSON.stringify(receipt));
			};
			for (let trial = 1; trial <= runs; trial++) {
				for (const item of cases) {
					await call(item, trial);
					await save();
				}
			}
			const results = await Promise.allSettled(
				cases.map((item) => call(item, runs + 1, true))
			);
			for (const result of results) {
				if (result.status === "rejected") {
					failures.push(String(result.reason));
				}
			}
		} finally {
			const result = await session.close();
			checkMemory("mcp-session", result.peakRssBytes);
			if (result.exitCode !== 0) {
				failures.push(`mcp-session exited ${result.exitCode}`);
			}
			receipts.push({ name: "mcp-session", ...result });
			await save();
		}
	}
	await validateFixture(fixture);
	if (failures.length) {
		throw new Error(failures.join("\n"));
	}
}

if (import.meta.main) {
	await run();
}
