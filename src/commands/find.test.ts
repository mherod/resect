import { describe, expect, test } from "bun:test";
import {
	CLI,
	cleanup,
	makeStrictFixture as makeFixture,
} from "./__test-helpers";

describe("find command", () => {
	test("finds files by name", async () => {
		const dir = await makeFixture("by-name", {
			"utils.ts": "export const x = 1;",
			"helpers.ts": "export const y = 2;",
		});

		const proc = Bun.spawn([...CLI, "find", "utils", "-p", dir], {
			stdout: "pipe",
			stderr: "pipe",
		});
		const stdout = await new Response(proc.stdout).text();
		await proc.exited;
		expect(proc.exitCode).toBe(0);
		expect(stdout).toContain("utils.ts");
		expect(stdout).not.toContain("helpers.ts");

		await cleanup(dir);
	});

	test("finds exports by name", async () => {
		const dir = await makeFixture("by-export", {
			"math.ts":
				"export function calculate() { return 1; }\nexport function compute() { return 2; }",
		});

		const proc = Bun.spawn([...CLI, "find", "calculate", "-p", dir], {
			stdout: "pipe",
			stderr: "pipe",
		});
		const stdout = await new Response(proc.stdout).text();
		await proc.exited;
		expect(proc.exitCode).toBe(0);
		expect(stdout).toContain("calculate");

		await cleanup(dir);
	});

	test("--type=file restricts to file matches only", async () => {
		const dir = await makeFixture("type-file", {
			"helper.ts": "export function helper() { return 1; }",
		});

		const proc = Bun.spawn(
			[...CLI, "find", "helper", "-p", dir, "--type=file"],
			{ stdout: "pipe", stderr: "pipe" }
		);
		const stdout = await new Response(proc.stdout).text();
		await proc.exited;
		expect(proc.exitCode).toBe(0);
		expect(stdout).toContain("Files");
		// Should find the file but not list exports section
		expect(stdout).toContain("helper.ts");

		await cleanup(dir);
	});

	test("--type=export restricts to export matches only", async () => {
		const dir = await makeFixture("type-export", {
			"utils.ts": "export function fetchData() { return 1; }",
		});

		const proc = Bun.spawn(
			[...CLI, "find", "fetchData", "-p", dir, "--type=export"],
			{ stdout: "pipe", stderr: "pipe" }
		);
		const stdout = await new Response(proc.stdout).text();
		await proc.exited;
		expect(proc.exitCode).toBe(0);
		expect(stdout).toContain("Exports");
		expect(stdout).toContain("fetchData");

		await cleanup(dir);
	});

	test("case-insensitive search", async () => {
		const dir = await makeFixture("case", {
			"MyComponent.ts": "export function MyComponent() { return 1; }",
		});

		const proc = Bun.spawn([...CLI, "find", "mycomponent", "-p", dir], {
			stdout: "pipe",
			stderr: "pipe",
		});
		const stdout = await new Response(proc.stdout).text();
		await proc.exited;
		expect(proc.exitCode).toBe(0);
		expect(stdout).toContain("MyComponent");

		await cleanup(dir);
	});

	test("reports no matches for non-existent query", async () => {
		const dir = await makeFixture("no-match", {
			"utils.ts": "export const x = 1;",
		});

		const proc = Bun.spawn([...CLI, "find", "nonexistent", "-p", dir], {
			stdout: "pipe",
			stderr: "pipe",
		});
		const stdout = await new Response(proc.stdout).text();
		await proc.exited;
		expect(proc.exitCode).toBe(0);
		expect(stdout).toContain("No matches found");

		await cleanup(dir);
	});

	test("missing query argument exits with error", async () => {
		const proc = Bun.spawn([...CLI, "find"], {
			stdout: "pipe",
			stderr: "pipe",
		});
		const stderr = await new Response(proc.stderr).text();
		await proc.exited;
		expect(proc.exitCode).toBe(1);
		expect(stderr).toContain("find requires a <query> argument");
	});

	test("missing -p option exits with error", async () => {
		const proc = Bun.spawn([...CLI, "find", "query"], {
			stdout: "pipe",
			stderr: "pipe",
		});
		const stderr = await new Response(proc.stderr).text();
		await proc.exited;
		expect(proc.exitCode).toBe(1);
		expect(stderr).toContain("find requires -p <project> option");
	});

	test("--verbose shows analysis tip", async () => {
		const dir = await makeFixture("verbose", {
			"utils.ts": "export const x = 1;",
		});

		const proc = Bun.spawn([...CLI, "find", "utils", "-p", dir, "--verbose"], {
			stdout: "pipe",
			stderr: "pipe",
		});
		const stdout = await new Response(proc.stdout).text();
		await proc.exited;
		expect(proc.exitCode).toBe(0);
		expect(stdout).toContain("analyze");

		await cleanup(dir);
	});

	test("exact filename matches sort first", async () => {
		const dir = await makeFixture("sort", {
			"auth-utils.ts": "export const a = 1;",
			"auth.ts": "export const b = 2;",
			"pre-auth.ts": "export const c = 3;",
		});

		const proc = Bun.spawn([...CLI, "find", "auth", "-p", dir, "--type=file"], {
			stdout: "pipe",
			stderr: "pipe",
		});
		const stdout = await new Response(proc.stdout).text();
		await proc.exited;
		expect(proc.exitCode).toBe(0);
		// auth.ts should appear before auth-utils.ts (exact match first)
		const authIdx = stdout.indexOf("auth.ts");
		const authUtilsIdx = stdout.indexOf("auth-utils.ts");
		expect(authIdx).toBeLessThan(authUtilsIdx);

		await cleanup(dir);
	});
});
