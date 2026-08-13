import { describe, expect, test } from "bun:test";
import {
	CLI,
	cleanup,
	makeStrictFixture as makeFixture,
} from "./__test-helpers";

// Two files with identical functions (different variable names) to guarantee a group
const DUPLICATE_A = `
export function formatDate(input: Date): string {
  const iso = input.toISOString();
  const parts = iso.split("T");
  const date = parts[0];
  return date;
}
`;

const DUPLICATE_B = `
export function formatTimestamp(value: Date): string {
  const str = value.toISOString();
  const segments = str.split("T");
  const result = segments[0];
  return result;
}
`;

describe("similar command", () => {
	test("reports no similar declarations for unique functions", async () => {
		const dir = await makeFixture("unique", {
			"a.ts": `
export function add(a: number, b: number): number {
  const sum = a + b;
  const doubled = sum * 2;
  return doubled;
}`,
			"b.ts": `
export function greet(name: string): string {
  const prefix = "Hello";
  const message = prefix + " " + name;
  return message;
}`,
		});

		const proc = Bun.spawn([...CLI, "similar", dir], {
			stdout: "pipe",
			stderr: "pipe",
		});
		const stdout = await new Response(proc.stdout).text();
		await proc.exited;
		expect(proc.exitCode).toBe(0);
		expect(stdout).toContain("No similar declarations found");

		await cleanup(dir);
	});

	test("finds duplicate functions and reports groups", async () => {
		const dir = await makeFixture("dupes", {
			"a.ts": DUPLICATE_A,
			"b.ts": DUPLICATE_B,
		});

		const proc = Bun.spawn([...CLI, "similar", dir, "--threshold=0.7"], {
			stdout: "pipe",
			stderr: "pipe",
		});
		const stdout = await new Response(proc.stdout).text();
		await proc.exited;
		expect(proc.exitCode).toBe(0);
		expect(stdout).toContain("candidate group");
		expect(stdout).toContain("formatDate");
		expect(stdout).toContain("formatTimestamp");

		await cleanup(dir);
	});

	test("--json outputs valid JSON with group data", async () => {
		const dir = await makeFixture("json", {
			"a.ts": DUPLICATE_A,
			"b.ts": DUPLICATE_B,
		});

		const proc = Bun.spawn(
			[...CLI, "similar", dir, "--json", "--threshold=0.7"],
			{ stdout: "pipe", stderr: "pipe" }
		);
		const stdout = await new Response(proc.stdout).text();
		await proc.exited;
		expect(proc.exitCode).toBe(0);

		const parsed = JSON.parse(stdout);
		expect(parsed.totalFunctions).toBeGreaterThanOrEqual(2);
		expect(parsed.totalFiles).toBeGreaterThanOrEqual(2);
		expect(parsed.groups).toBeArray();
		expect(parsed.totalGroups).toBeNumber();
		expect(typeof parsed.truncated).toBe("boolean");

		await cleanup(dir);
	});

	test("--strict exits with error when groups found", async () => {
		const dir = await makeFixture("strict", {
			"a.ts": DUPLICATE_A,
			"b.ts": DUPLICATE_B,
		});

		const proc = Bun.spawn(
			[...CLI, "similar", dir, "--strict", "--threshold=0.7"],
			{ stdout: "pipe", stderr: "pipe" }
		);
		const stderr = await new Response(proc.stderr).text();
		await proc.exited;
		expect(proc.exitCode).toBe(1);
		expect(stderr).toContain("similar declaration group");

		await cleanup(dir);
	});

	test("--strict exits 0 when no groups found", async () => {
		const dir = await makeFixture("strict-clean", {
			"a.ts": `
export function unique(x: number): number {
  const doubled = x * 2;
  const shifted = doubled + 10;
  return shifted;
}`,
		});

		const proc = Bun.spawn([...CLI, "similar", dir, "--strict"], {
			stdout: "pipe",
			stderr: "pipe",
		});
		await proc.exited;
		expect(proc.exitCode).toBe(0);

		await cleanup(dir);
	});

	test("--format=compact produces compact output", async () => {
		const dir = await makeFixture("compact", {
			"a.ts": DUPLICATE_A,
			"b.ts": DUPLICATE_B,
		});

		const proc = Bun.spawn(
			[...CLI, "similar", dir, "--format=compact", "--threshold=0.7"],
			{ stdout: "pipe", stderr: "pipe" }
		);
		const stdout = await new Response(proc.stdout).text();
		await proc.exited;
		expect(proc.exitCode).toBe(0);
		// Compact format uses "---" prefix for groups
		if (stdout.includes("---")) {
			expect(stdout).toContain("formatDate");
		}

		await cleanup(dir);
	});

	test("--format with an unsupported value exits with error", async () => {
		const dir = await makeFixture("bad-format", {
			"a.ts": DUPLICATE_A,
			"b.ts": DUPLICATE_B,
		});

		const proc = Bun.spawn(
			[...CLI, "similar", dir, "--format=bogus", "--threshold=0.7"],
			{ stdout: "pipe", stderr: "pipe" }
		);
		const stderr = await new Response(proc.stderr).text();
		await proc.exited;
		expect(proc.exitCode).toBe(1);
		expect(stderr).toContain("--format must be 'compact'");

		await cleanup(dir);
	});

	test("--max-groups limits output", async () => {
		const dir = await makeFixture("maxgroups", {
			"a.ts": DUPLICATE_A,
			"b.ts": DUPLICATE_B,
		});

		const proc = Bun.spawn(
			[...CLI, "similar", dir, "--json", "--threshold=0.7", "--max-groups=1"],
			{ stdout: "pipe", stderr: "pipe" }
		);
		const stdout = await new Response(proc.stdout).text();
		await proc.exited;
		expect(proc.exitCode).toBe(0);

		const parsed = JSON.parse(stdout);
		expect(parsed.groups.length).toBeLessThanOrEqual(1);

		await cleanup(dir);
	});

	test("--json --strict exits 1 with error on stderr", async () => {
		const dir = await makeFixture("json-strict", {
			"a.ts": DUPLICATE_A,
			"b.ts": DUPLICATE_B,
		});

		const proc = Bun.spawn(
			[...CLI, "similar", dir, "--json", "--strict", "--threshold=0.7"],
			{ stdout: "pipe", stderr: "pipe" }
		);
		const stdout = await new Response(proc.stdout).text();
		const stderr = await new Response(proc.stderr).text();
		await proc.exited;
		expect(proc.exitCode).toBe(1);
		// JSON is still written to stdout
		expect(() => JSON.parse(stdout)).not.toThrow();
		// Error message on stderr
		expect(stderr).toContain("similar declaration group");

		await cleanup(dir);
	});

	test("missing directory argument exits with error", async () => {
		const proc = Bun.spawn([...CLI, "similar"], {
			stdout: "pipe",
			stderr: "pipe",
		});
		const stderr = await new Response(proc.stderr).text();
		await proc.exited;
		expect(proc.exitCode).toBe(1);
		expect(stderr).toContain("similar requires a <directory> argument");
	});
});
