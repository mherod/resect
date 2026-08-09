import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const CLI = ["bun", path.resolve(import.meta.dir, "cli.ts")];
const JSON_PIPE_FIXTURE_FILE_COUNT = 800;
const JSON_PIPE_EXPORTS_PER_FILE = 12;
const HUMAN_PIPELINE = 'bun "$@" | head -n 1';
const JSON_PIPELINE = 'bun "$@" | head -c 1';

async function runWithClosedStdout(args: string[], pipeline: string) {
	const child = Bun.spawn(
		[
			"bash",
			"-o",
			"pipefail",
			"-c",
			pipeline,
			"resect-pipeline",
			...CLI.slice(1),
			...args,
		],
		{
			stdout: "pipe",
			stderr: "pipe",
		}
	);
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);

	return {
		exitCode,
		stderr,
		stdout,
	};
}

describe("cli", () => {
	test("--version returns version", async () => {
		const proc = Bun.spawn(["bun", "src/cli.ts", "--version"]);
		const output = await new Response(proc.stdout).text();
		expect(output).toContain("resect v");
	});

	test("--help shows usage", async () => {
		const proc = Bun.spawn(["bun", "src/cli.ts", "--help"]);
		const output = await new Response(proc.stdout).text();
		expect(output).toContain("Usage:");
		expect(output).toContain("Commands:");
	});

	test("unknown command exits with error", async () => {
		const proc = Bun.spawn(["bun", "src/cli.ts", "unknown"]);
		await proc.exited;
		expect(proc.exitCode).toBe(1);
	});

	test("rejects options unsupported by the selected command", async () => {
		const outputPath = `/tmp/resect-discover-${crypto.randomUUID()}.json`;
		const proc = Bun.spawn(
			["bun", "src/cli.ts", "discover", ".", "--out", outputPath],
			{ stderr: "pipe", stdout: "pipe" }
		);
		const [stderr, exitCode] = await Promise.all([
			new Response(proc.stderr).text(),
			proc.exited,
		]);

		expect(exitCode).toBe(1);
		expect(stderr).toContain("Error: --out is not supported by 'discover'");
		expect(stderr).toContain("Run 'resect discover --help' for usage");
		expect(await Bun.file(outputPath).exists()).toBe(false);
	});

	test("rejects mutation-only and short options on read-only commands", async () => {
		const cases = [
			{
				args: ["discover", ".", "--force"],
				expectedOption: "--force",
			},
			{
				args: ["workspace", ".", "-p", "."],
				expectedOption: "--project",
			},
		];

		for (const { args, expectedOption } of cases) {
			const proc = Bun.spawn(["bun", "src/cli.ts", ...args], {
				stderr: "pipe",
				stdout: "pipe",
			});
			const [stderr, exitCode] = await Promise.all([
				new Response(proc.stderr).text(),
				proc.exited,
			]);

			expect(exitCode).toBe(1);
			expect(stderr).toContain(
				`Error: ${expectedOption} is not supported by '${args[0]}'`
			);
		}
	});

	test("keeps command help global when other options are present", async () => {
		const proc = Bun.spawn(
			["bun", "src/cli.ts", "discover", ".", "--force", "--help"],
			{ stderr: "pipe", stdout: "pipe" }
		);
		const [stdout, exitCode] = await Promise.all([
			new Response(proc.stdout).text(),
			proc.exited,
		]);

		expect(exitCode).toBe(0);
		expect(stdout).toContain("Usage: resect discover <directory> [options]");
	});

	test("exits quietly when a human-output reader closes stdout", async () => {
		const result = await runWithClosedStdout(
			["discover", process.cwd()],
			HUMAN_PIPELINE
		);

		expect(result.stdout.length).toBeGreaterThan(0);
		expect(result.exitCode).toBe(0);
		expect(result.stderr).not.toContain("EPIPE");
	});

	test("exits quietly when a JSON-output reader closes stdout", async () => {
		const fixtureRoot = await mkdtemp(
			path.join(tmpdir(), "resect-cli-json-pipe-")
		);

		try {
			await Bun.write(
				path.join(fixtureRoot, "tsconfig.json"),
				JSON.stringify({ include: ["src/**/*.ts"] })
			);
			await Promise.all(
				Array.from(
					{ length: JSON_PIPE_FIXTURE_FILE_COUNT },
					async (_, index) => {
						await Bun.write(
							path.join(fixtureRoot, "src", `file-${index}.ts`),
							Array.from(
								{ length: JSON_PIPE_EXPORTS_PER_FILE },
								(__, exportIndex) =>
									`export const value${index}_${exportIndex} = ${exportIndex};`
							).join("\n")
						);
					}
				)
			);

			const result = await runWithClosedStdout(
				["audit", fixtureRoot, "--json"],
				JSON_PIPELINE
			);

			expect(result.stdout).toHaveLength(1);
			expect(result.exitCode).toBe(0);
			expect(result.stderr).not.toContain("EPIPE");
		} finally {
			await rm(fixtureRoot, { recursive: true, force: true });
		}
	});
});

// ─── --json on the read-only analysis commands (#141) ──────────────────────

describe("--json on find, analyze, analyze-impact and discover", () => {
	async function makeJsonFixture(): Promise<string> {
		const dir = await mkdtemp(path.join(tmpdir(), "resect-cli-json-flag-"));
		await Bun.write(
			path.join(dir, "tsconfig.json"),
			JSON.stringify({
				compilerOptions: {
					strict: true,
					moduleResolution: "bundler",
					module: "esnext",
					target: "esnext",
				},
				include: ["lib/**/*.ts"],
			})
		);
		await Bun.write(
			path.join(dir, "lib/query.ts"),
			"export function loadRecords() {\n  return [] as string[];\n}\n"
		);
		await Bun.write(
			path.join(dir, "lib/api.ts"),
			'import { loadRecords } from "./query";\n\nexport function fetchRecords() {\n  return loadRecords();\n}\n'
		);
		return dir;
	}

	async function runCli(
		args: string[]
	): Promise<{ stdout: string; stderr: string; exitCode: number }> {
		const proc = Bun.spawn([...CLI, ...args], {
			stdout: "pipe",
			stderr: "pipe",
		});
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);
		return { stdout, stderr, exitCode };
	}

	test("each command emits exactly one parseable JSON document on stdout", async () => {
		const dir = await makeJsonFixture();
		try {
			const invocations: Array<{ name: string; args: string[] }> = [
				{ name: "discover", args: ["discover", dir, "--json"] },
				{
					name: "analyze",
					args: ["analyze", path.join(dir, "lib/api.ts"), "--json"],
				},
				{
					name: "find",
					args: ["find", "loadRecords", "-p", dir, "--json"],
				},
				{
					name: "analyze-impact",
					args: [
						"analyze-impact",
						path.join(dir, "lib/api.ts"),
						path.join(dir, "lib/moved.ts"),
						"--json",
					],
				},
			];

			for (const { name, args } of invocations) {
				const { stdout, exitCode } = await runCli(args);
				expect(exitCode).toBe(0);
				// Exactly one document: JSON.parse of the whole stdout must succeed.
				const parsed = JSON.parse(stdout) as unknown;
				expect(typeof parsed).toBe("object");
				expect(parsed).not.toBeNull();
				expect(name).toBeTruthy();
			}
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test("JSON mode keeps the human report off stdout", async () => {
		const dir = await makeJsonFixture();
		try {
			const { stdout } = await runCli(["discover", dir, "--json"]);

			// The human report's banner and config line must not leak into stdout.
			expect(stdout).not.toContain("🔍 Discovering tsconfig files");
			expect(stdout).not.toContain("Resect config:");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test("find reports matched exports in the JSON document", async () => {
		const dir = await makeJsonFixture();
		try {
			const { stdout } = await runCli([
				"find",
				"loadRecords",
				"-p",
				dir,
				"--json",
			]);
			const report = JSON.parse(stdout) as {
				query: string;
				exports: Array<{ name: string }>;
			};

			expect(report.query).toBe("loadRecords");
			expect(report.exports.map((exp) => exp.name)).toContain("loadRecords");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test("omitting --json still produces the human report", async () => {
		const dir = await makeJsonFixture();
		try {
			const { stdout, exitCode } = await runCli(["discover", dir]);

			expect(exitCode).toBe(0);
			expect(stdout).toContain("🔍 Discovering tsconfig files");
			expect(() => JSON.parse(stdout)).toThrow();
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});
