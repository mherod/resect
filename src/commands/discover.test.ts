import { describe, expect, test } from "bun:test";
import { CLI, cleanup, makeFixture as makeFixtureBase } from "./__test-helpers";

async function makeFixture(name: string, files: Record<string, string>) {
	return makeFixtureBase(`discover-${name}`, files);
}

describe("discover command", () => {
	test("discovers tsconfig.json in a directory", async () => {
		const dir = await makeFixture("basic", {
			"tsconfig.json": JSON.stringify({
				compilerOptions: { strict: true, outDir: "dist" },
				include: ["src/**/*.ts"],
			}),
			"src/index.ts": "export const x = 1;",
		});

		const proc = Bun.spawn([...CLI, "discover", dir], {
			stdout: "pipe",
			stderr: "pipe",
		});
		const stdout = await new Response(proc.stdout).text();
		await proc.exited;
		expect(proc.exitCode).toBe(0);
		expect(stdout).toContain("tsconfig");
		expect(stdout).toContain("Found");

		await cleanup(dir);
	});

	test("surfaces resolved project config", async () => {
		const dir = await makeFixture("config", {
			".resect/config.json": JSON.stringify({
				prefer: "alias",
				verify: true,
				commands: { move: { prefer: "relative" } },
			}),
			"tsconfig.json": JSON.stringify({ include: ["src/**/*.ts"] }),
			"src/index.ts": "export const x = 1;",
		});

		const proc = Bun.spawn([...CLI, "discover", dir], {
			stdout: "pipe",
			stderr: "pipe",
		});
		const stdout = await new Response(proc.stdout).text();
		await proc.exited;
		expect(proc.exitCode).toBe(0);
		expect(stdout).toContain("Resect config: .resect/config.json");
		expect(stdout).toContain("Global: prefer=alias");
		expect(stdout).toContain("move: prefer=relative");
		expect(stdout).toContain("verify=true");

		await cleanup(dir);
	});

	test("reports no tsconfig files when none exist", async () => {
		const dir = await makeFixture("empty", {
			"src/index.ts": "export const x = 1;",
		});

		const proc = Bun.spawn([...CLI, "discover", dir], {
			stdout: "pipe",
			stderr: "pipe",
		});
		const stdout = await new Response(proc.stdout).text();
		await proc.exited;
		expect(proc.exitCode).toBe(0);
		expect(stdout).toContain("No tsconfig.json files found");

		await cleanup(dir);
	});

	test("--verbose shows file ownership and path aliases", async () => {
		const dir = await makeFixture("verbose", {
			"tsconfig.json": JSON.stringify({
				compilerOptions: {
					strict: true,
					baseUrl: ".",
					paths: { "@/*": ["src/*"] },
				},
				include: ["src/**/*.ts"],
			}),
			"src/utils.ts": "export function helper() { return 1; }",
			"src/index.ts": 'export { helper } from "./utils";',
		});

		const proc = Bun.spawn([...CLI, "discover", dir, "--verbose"], {
			stdout: "pipe",
			stderr: "pipe",
		});
		const stdout = await new Response(proc.stdout).text();
		await proc.exited;
		expect(proc.exitCode).toBe(0);
		expect(stdout).toContain("Files by config");
		expect(stdout).toContain("Path aliases");
		expect(stdout).toContain("@/*");

		await cleanup(dir);
	});

	test("discovers multiple tsconfig files", async () => {
		const dir = await makeFixture("multi", {
			"tsconfig.json": JSON.stringify({
				compilerOptions: { strict: true },
				references: [{ path: "./packages/lib" }],
			}),
			"packages/lib/tsconfig.json": JSON.stringify({
				compilerOptions: { strict: true, outDir: "dist" },
				include: ["src/**/*.ts"],
			}),
			"packages/lib/src/index.ts": "export const lib = 1;",
		});

		const proc = Bun.spawn([...CLI, "discover", dir], {
			stdout: "pipe",
			stderr: "pipe",
		});
		const stdout = await new Response(proc.stdout).text();
		await proc.exited;
		expect(proc.exitCode).toBe(0);
		expect(stdout).toContain("Found 2 tsconfig file(s)");

		await cleanup(dir);
	});

	test("missing directory argument exits with error", async () => {
		const proc = Bun.spawn([...CLI, "discover"], {
			stdout: "pipe",
			stderr: "pipe",
		});
		const stderr = await new Response(proc.stderr).text();
		await proc.exited;
		expect(proc.exitCode).toBe(1);
		expect(stderr).toContain("discover requires a <directory> argument");
	});

	test("--workspace exits with error when no workspace found", async () => {
		const dir = await makeFixture("no-ws", {
			"tsconfig.json": JSON.stringify({
				compilerOptions: { strict: true },
				include: ["*.ts"],
			}),
			"index.ts": "export const x = 1;",
		});

		const proc = Bun.spawn([...CLI, "discover", dir, "--workspace"], {
			stdout: "pipe",
			stderr: "pipe",
		});
		const stderr = await new Response(proc.stderr).text();
		await proc.exited;
		expect(proc.exitCode).toBe(1);
		expect(stderr).toContain("No workspace packages found");

		await cleanup(dir);
	});
});
