import { describe, expect, test } from "bun:test";

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
});
