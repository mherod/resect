import { describe, expect, test } from "bun:test";
import { loadProject } from "../core/project.ts";
import { makeProject } from "./__test-helpers.ts";
import { renameSymbol } from "./rename.ts";

async function setupProject(fileContent: string): Promise<{
	filePath: string;
	project: ReturnType<typeof loadProject>;
}> {
	const fixture = await makeProject({
		name: "dup-guard",
		files: { "mod.ts": fileContent },
		outsideRepo: true,
		tsconfig: "bundler",
	});
	const filePath = fixture.path("mod.ts");
	const project = loadProject(fixture.path("tsconfig.json"), filePath);
	return { filePath, project };
}

// `formatUser` and `combineName` are near-identical: renaming the former onto
// the latter's name should be flagged as a duplicate conflict.
const DUPLICATE_SOURCE = `
export function formatUser(user: { first: string; last: string }) {
	const full = user.first + " " + user.last;
	const trimmed = full.trim();
	return trimmed.toUpperCase();
}

export function combineName(person: { first: string; last: string }) {
	const whole = person.first + " " + person.last;
	const clean = whole.trim();
	return clean.toUpperCase();
}
`;

// `combineName` here is unrelated to `formatUser`.
const UNRELATED_SOURCE = `
export function formatUser(user: { first: string; last: string }) {
	const full = user.first + " " + user.last;
	const trimmed = full.trim();
	return trimmed.toUpperCase();
}

export function combineName(items: number[]) {
	let total = 0;
	for (const value of items) {
		total += value * value;
	}
	return Math.sqrt(total);
}
`;

describe("rename duplicate-declaration guard", () => {
	test("blocks a conflicting rename and flags the existing duplicate", async () => {
		const { filePath, project } = await setupProject(DUPLICATE_SOURCE);

		const result = await renameSymbol(
			filePath,
			"formatUser",
			"combineName",
			project,
			true, // dryRun
			false
		);

		expect(result.success).toBe(false);
		const message = result.errors[0]?.message ?? "";
		expect(message).toContain("already exists");
		expect(message).toContain("duplicate");
		expect(message).toContain("--force");
	});

	test("--force proceeds past the conflict", async () => {
		const { filePath, project } = await setupProject(DUPLICATE_SOURCE);

		const result = await renameSymbol(
			filePath,
			"formatUser",
			"combineName",
			project,
			true, // dryRun — no writes, but conflict + force gating still run
			false,
			[],
			true // force
		);

		expect(result.success).toBe(true);
	});

	test("blocks unrelated name clashes without claiming a duplicate", async () => {
		const { filePath, project } = await setupProject(UNRELATED_SOURCE);

		const result = await renameSymbol(
			filePath,
			"formatUser",
			"combineName",
			project,
			true, // dryRun
			false
		);

		expect(result.success).toBe(false);
		const message = result.errors[0]?.message ?? "";
		expect(message).toContain("already exists");
		expect(message).not.toContain("essentially a duplicate");
		expect(message).toContain("--force");
	});
});
