import { chmod, mkdir, readdir } from "node:fs/promises";
import path from "node:path";
import {
	assertAppliedEdits,
	restoreMutationFixture,
} from "./mutation-fixture.ts";
import { MEMORY_LIMIT_BYTES, measureProcess } from "./process.ts";
import { gitOutput, VSCODE_REVISION, validateFixture } from "./vscode.ts";

const original = path.resolve(Bun.argv[2] ?? "");
const output = path.resolve(Bun.argv[3] ?? "");
const runs = Number(Bun.argv[4] ?? 3);
const baseline = Bun.argv[5] ? path.resolve(Bun.argv[5]) : undefined;
if (!Number.isInteger(runs) || runs < 1) {
	throw new Error("Runs must be a positive integer");
}
await validateFixture(original);
if (output === original || output.startsWith(`${original}${path.sep}`)) {
	throw new Error("Output must be outside the original fixture");
}
await mkdir(output);
const compilerDirectory = path.join(output, "compiler");
await mkdir(compilerDirectory);
const compilerExecutable = path.resolve(
	import.meta.dir,
	"../../node_modules/.bin/tsc"
);
const compilerShim = path.join(compilerDirectory, "tsc");
await Bun.write(
	compilerShim,
	`#!${process.execPath}
const child = Bun.spawn([${JSON.stringify(compilerExecutable)}, ...Bun.argv.slice(2)], { stdin: "inherit", stdout: "inherit", stderr: "inherit" });
const exitCode = await child.exited;
await Bun.write(${JSON.stringify(compilerDirectory)} + "/" + process.pid + ".json", JSON.stringify({ exitCode, peakRssBytes: child.resourceUsage()?.maxRSS }));
process.exit(exitCode);
`
);
await chmod(compilerShim, 0o755);
process.env.PATH = `${compilerDirectory}${path.delimiter}${process.env.PATH ?? ""}`;
await Bun.write(
	path.join(output, "metadata.json"),
	JSON.stringify(
		{
			fixtureRevision: VSCODE_REVISION,
			resectRevision: await gitOutput(import.meta.dir, ["rev-parse", "HEAD"]),
			resectStatus: await gitOutput(import.meta.dir, ["status", "--porcelain"]),
			bun: Bun.version,
			runs,
			baseline,
			memoryLimitBytes: MEMORY_LIMIT_BYTES,
			compilerExecutable,
			verification:
				"default before/after compiler verification; dependencies are intentionally absent from the fixture",
		},
		null,
		2
	)
);
const fixture = path.join(output, "fixture");
await gitOutput(original, [
	"clone",
	"--shared",
	"--no-hardlinks",
	original,
	fixture,
]);
await gitOutput(fixture, ["config", "core.fsmonitor", "false"]);
await validateFixture(fixture);
const cli = path.resolve(import.meta.dir, "../../bin/resect.js");
const source = path.join(fixture, "src/vs/base/common/lifecycle.ts");
const target = path.join(fixture, "src/vs/base/common/resect/lifecycle.ts");
const project = path.join(fixture, "src/tsconfig.json");
if (await Bun.file(target).exists()) {
	throw new Error("Destination already exists");
}

const cases = [
	{
		name: "rename-preview",
		args: ["rename", source, "toDisposable", "toResectDisposable", "--dry-run"],
		preview: true,
	},
	{
		name: "rename-conflict",
		args: ["rename", source, "toDisposable", "Disposable", "--dry-run"],
		conflict: true,
	},
	{
		name: "rename-verified",
		args: ["rename", source, "toDisposable", "toResectDisposable"],
		rename: true,
	},
	{
		name: "move-preview",
		args: ["move", source, target, "--dry-run"],
		preview: true,
	},
	{ name: "move-verified", args: ["move", source, target] },
];
const previews = new Map<string, unknown>();
const receipts: unknown[] = [];

async function assertBaseline(name: string, report: unknown): Promise<void> {
	if (!baseline) {
		return;
	}
	const expected = JSON.parse(
		(await Bun.file(path.join(baseline, `${name}.stdout`)).text()).replaceAll(
			path.join(baseline, "fixture"),
			"<VSCODE>"
		)
	);
	const actual = JSON.parse(
		JSON.stringify(report).replaceAll(fixture, "<VSCODE>")
	);
	if (actual.typecheck) {
		// The only accepted verification transition: the old compiler aborted;
		// the new preflight identifies all seven missing explicit type packages.
		const missing = [
			"@webgpu/types",
			"mocha",
			"semver",
			"sinon",
			"trusted-types",
			"winreg",
			"wicg-file-system-access",
		].map(
			(name) => `error TS2688: Cannot find type definition file for '${name}'.`
		);
		for (const field of ["errorsBefore", "errorsAfter"]) {
			if (JSON.stringify(actual.typecheck[field]) !== JSON.stringify(missing)) {
				throw new Error("Unexpected verification diagnostics");
			}
			expected.typecheck[field] = missing;
		}
	}
	if (JSON.stringify(actual) !== JSON.stringify(expected)) {
		throw new Error(`${name}: complete baseline report differs`);
	}
}

const fixtureOptions = { original, fixture, source, target, project };

for (const run of Array.from({ length: runs }, (_, index) => index + 1)) {
	for (const item of cases) {
		await validateFixture(fixture);
		const prefix = path.join(output, `${item.name}-${run}`);
		try {
			const result = await measureProcess(
				[process.execPath, cli, ...item.args, "-p", project, "--json"],
				fixture,
				prefix,
				300_000
			);
			await Bun.write(
				`${prefix}.process.json`,
				JSON.stringify(result, null, 2)
			);
			await Bun.write(
				`${prefix}.diff`,
				await gitOutput(fixture, ["diff", "HEAD", "--no-ext-diff"])
			);
			if (result.timedOut) {
				throw new Error(`${item.name} timed out`);
			}
			if (!result.peakRssBytes || result.peakRssBytes > MEMORY_LIMIT_BYTES) {
				throw new Error(
					`${item.name}: peak ${result.peakRssBytes} exceeds the memory ceiling`
				);
			}
			const report = await Bun.file(`${prefix}.stdout`).json();
			await assertBaseline(item.name, report);
			if (report.success !== (result.exitCode === 0)) {
				throw new Error(
					`${item.name}: JSON success disagrees with the process exit status`
				);
			}
			if (item.conflict) {
				if (report.success || report.errors.length === 0) {
					throw new Error("Expected a naming conflict");
				}
				await validateFixture(fixture);
			} else if (report.updatedReferences.length < 20) {
				throw new Error("Expected a heavily referenced mutation");
			}
			const kind = item.name.startsWith("rename") ? "rename" : "move";
			if (item.preview) {
				if (!report.success || result.exitCode !== 0) {
					throw new Error("Preview failed");
				}
				previews.set(kind, report.edits);
				await validateFixture(fixture);
			} else if (!item.conflict) {
				if (
					JSON.stringify(report.edits) !== JSON.stringify(previews.get(kind))
				) {
					throw new Error("Applied edits differ from preview");
				}
				if (!report.typecheck) {
					throw new Error("Verification was not run");
				}
				if (
					(await readdir(compilerDirectory)).some((file) =>
						file.endsWith(".json")
					)
				) {
					throw new Error(
						"Missing type dependencies should fail before starting the full compiler; inspect compiler RSS receipts"
					);
				}
				if (item.rename && !report.typecheck.success && !report.rolledBack) {
					throw new Error("Failed rename verification did not roll back");
				}
				if (report.rolledBack) {
					await validateFixture(fixture);
				} else {
					await assertAppliedEdits(
						fixtureOptions,
						report.edits,
						kind === "move"
					);
				}
			}
			receipts.push({
				name: item.name,
				run,
				...result,
				success: report.success,
				updatedReferences: report.updatedReferences.length,
				rolledBack: report.rolledBack,
				verification: report.typecheck,
				memoryScope:
					"Conservative native parent peak plus overlapping analysis-process peaks; compiler invocation probe requires zero full compiler subprocesses on this dependency-free fixture",
			});
			await Bun.write(
				path.join(output, "receipts.json"),
				JSON.stringify(receipts, null, 2)
			);
			console.log(JSON.stringify(receipts.at(-1)));
		} finally {
			await restoreMutationFixture(fixtureOptions);
		}
	}
}
await validateFixture(original);
