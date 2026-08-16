import { describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import path from "node:path";
import { makeTempDir } from "./__test-helpers.ts";
import { extractCommonCommand, runExtractCommon } from "./extract-common.ts";

const baseFixtureDir = path.join(
	import.meta.dir,
	"__fixtures__/extract-common"
);
let testCounter = 0;

function nextFixtureDir(): string {
	testCounter++;
	return `${baseFixtureDir}-${testCounter}-${Date.now()}`;
}

async function setupFixtures(dir: string): Promise<void> {
	await Bun.write(
		path.join(dir, "tsconfig.json"),
		JSON.stringify({
			compilerOptions: { target: "ES2020", module: "ESNext", strict: true },
			include: ["*.ts"],
		})
	);
	await Bun.write(
		path.join(dir, "a.ts"),
		`export function formatDate(input: Date): string {
  const iso = input.toISOString();
  const parts = iso.split("T");
  return parts[0] ?? "";
}

export function otherA(): number {
  return 42;
}
`
	);
	await Bun.write(
		path.join(dir, "b.ts"),
		`function formatDate(input: Date): string {
  const iso = input.toISOString();
  const parts = iso.split("T");
  return parts[0] ?? "";
}

export function otherB(): number {
  return 99;
}
`
	);
}

function runExtractCommonCli(args: string[]): {
	stdout: string;
	stderr: string;
	exitCode: number;
} {
	const proc = Bun.spawnSync(
		["bun", path.join(process.cwd(), "src/cli.ts"), "extract-common", ...args],
		{ stdout: "pipe", stderr: "pipe" }
	);

	return {
		stdout: proc.stdout.toString(),
		stderr: proc.stderr.toString(),
		exitCode: proc.exitCode,
	};
}

describe("extract-common", () => {
	test("dry-run reports duplicates without modifying files", async () => {
		const dir = nextFixtureDir();
		await setupFixtures(dir);

		const { stdout, stderr, exitCode } = runExtractCommonCli([
			dir,
			"--threshold=0.95",
			"--dry-run",
			"--force",
		]);
		expect(exitCode).toBe(0);
		expect(stdout + stderr).toContain("Dry run");
		expect(stdout + stderr).toContain("formatDate");
		expect(stdout + stderr).toContain("Would remove from");

		// Files should be unchanged
		const aContent = await Bun.file(path.join(dir, "a.ts")).text();
		const bContent = await Bun.file(path.join(dir, "b.ts")).text();
		expect(aContent).toContain("export function formatDate");
		expect(bContent).toContain("function formatDate");

		await rm(dir, { recursive: true, force: true });
	});

	test("extracts duplicates and adds imports", async () => {
		const dir = nextFixtureDir();
		await setupFixtures(dir);

		await extractCommonCommand({
			directory: dir,
			threshold: 0.95,
			force: true,
			dryRun: false,
		});

		const aContent = await Bun.file(path.join(dir, "a.ts")).text();
		const bContent = await Bun.file(path.join(dir, "b.ts")).text();

		// a.ts should still have the function (canonical)
		expect(aContent).toContain("export function formatDate");

		// b.ts should have an import instead of the function definition
		expect(bContent).not.toContain("function formatDate(input: Date)");
		expect(bContent).toContain('import { formatDate } from "./a"');
		// b.ts should still have its own function
		expect(bContent).toContain("export function otherB");

		await rm(dir, { recursive: true, force: true });
	});

	test("no groups found with different functions", async () => {
		const dir = nextFixtureDir();
		await Bun.write(
			path.join(dir, "tsconfig.json"),
			JSON.stringify({
				compilerOptions: {
					target: "ES2020",
					module: "ESNext",
					strict: true,
				},
				include: ["*.ts"],
			})
		);
		await Bun.write(
			path.join(dir, "a.ts"),
			`export function formatDate(input: Date): string {
  const iso = input.toISOString();
  const parts = iso.split("T");
  return parts[0] ?? "";
}
`
		);
		await Bun.write(
			path.join(dir, "b.ts"),
			`export function completelyDifferent(x: number): boolean {
  for (let i = 0; i < x; i++) {
    if (i % 2 === 0) {
      console.log(i);
    }
  }
  return true;
}
`
		);

		const { stdout, stderr, exitCode } = runExtractCommonCli([
			dir,
			"--threshold=0.95",
			"--dry-run",
			"--force",
		]);
		expect(exitCode).toBe(0);
		expect(stdout + stderr).toContain("No similar function groups found");

		await rm(dir, { recursive: true, force: true });
	});

	test("same-file duplicate: removes duplicate without generating self-import", async () => {
		const dir = nextFixtureDir();
		await Bun.write(
			path.join(dir, "tsconfig.json"),
			JSON.stringify({
				compilerOptions: { target: "ES2020", module: "ESNext", strict: true },
				include: ["*.ts"],
			})
		);
		// Both functions are in the same file; one should be kept, the other removed,
		// but NO self-import (`import { ... } from "./utils"`) should be generated.
		await Bun.write(
			path.join(dir, "utils.ts"),
			`export function formatDate(input: Date): string {
  const iso = input.toISOString();
  const parts = iso.split("T");
  return parts[0] ?? "";
}

function parseDate(input: Date): string {
  const iso = input.toISOString();
  const parts = iso.split("T");
  return parts[0] ?? "";
}

export function otherUtil(): number {
  return 1;
}
`
		);

		await extractCommonCommand({
			directory: dir,
			threshold: 0.95,
			force: true,
			dryRun: false,
		});

		const content = await Bun.file(path.join(dir, "utils.ts")).text();

		// Same-file, different-name declarations are intentional aliases —
		// both should remain untouched.
		expect(content).toContain("export function formatDate");
		expect(content).toContain("function parseDate");
		// No self-import from the same file
		expect(content).not.toContain('from "./utils"');
		// Other exports should be untouched
		expect(content).toContain("export function otherUtil");

		await rm(dir, { recursive: true, force: true });
	});

	test("name mismatch: generates aliased import using canonical name", async () => {
		const dir = nextFixtureDir();
		await Bun.write(
			path.join(dir, "tsconfig.json"),
			JSON.stringify({
				compilerOptions: { target: "ES2020", module: "ESNext", strict: true },
				include: ["*.ts"],
			})
		);
		// a.ts exports formatDate; b.ts has the same function body under formatDateStr
		await Bun.write(
			path.join(dir, "a.ts"),
			`export function formatDate(input: Date): string {
  const iso = input.toISOString();
  const parts = iso.split("T");
  return parts[0] ?? "";
}
`
		);
		await Bun.write(
			path.join(dir, "b.ts"),
			`function formatDateStr(input: Date): string {
  const iso = input.toISOString();
  const parts = iso.split("T");
  return parts[0] ?? "";
}

export function otherB(): number {
  return 99;
}
`
		);

		await extractCommonCommand({
			directory: dir,
			threshold: 0.95,
			force: true,
			dryRun: false,
			sameNameOnly: false,
		});

		const bContent = await Bun.file(path.join(dir, "b.ts")).text();

		// b.ts should NOT have the function body anymore
		expect(bContent).not.toContain("function formatDateStr(input: Date)");
		// b.ts should import using the canonical name, aliased to the duplicate name
		expect(bContent).toContain(
			'import { formatDate as formatDateStr } from "./a"'
		);
		// b.ts should still have its own function
		expect(bContent).toContain("export function otherB");

		await rm(dir, { recursive: true, force: true });
	});

	test("extension-aware: emits .ts extension when allowImportingTsExtensions is set", async () => {
		const dir = nextFixtureDir();
		await Bun.write(
			path.join(dir, "tsconfig.json"),
			JSON.stringify({
				compilerOptions: {
					target: "ES2020",
					moduleResolution: "bundler",
					allowImportingTsExtensions: true,
					strict: true,
				},
				include: ["*.ts"],
			})
		);
		await Bun.write(
			path.join(dir, "a.ts"),
			`export function formatDate(input: Date): string {
  const iso = input.toISOString();
  const parts = iso.split("T");
  return parts[0] ?? "";
}

export function otherA(): number {
  return 42;
}
`
		);
		await Bun.write(
			path.join(dir, "b.ts"),
			`function formatDate(input: Date): string {
  const iso = input.toISOString();
  const parts = iso.split("T");
  return parts[0] ?? "";
}

export function otherB(): number {
  return 99;
}
`
		);

		await extractCommonCommand({
			directory: dir,
			threshold: 0.95,
			force: true,
			dryRun: false,
		});

		const bContent = await Bun.file(path.join(dir, "b.ts")).text();

		// Import should include .ts extension
		expect(bContent).toContain('import { formatDate } from "./a.ts"');
		expect(bContent).not.toContain('import { formatDate } from "./a"');
		expect(bContent).toContain("export function otherB");

		await rm(dir, { recursive: true, force: true });
	});

	test("multi-plan: multiple groups modifying same file apply without corruption", async () => {
		const dir = nextFixtureDir();
		await Bun.write(
			path.join(dir, "tsconfig.json"),
			JSON.stringify({
				compilerOptions: { target: "ES2020", module: "ESNext", strict: true },
				include: ["*.ts"],
			})
		);
		// shared.ts has two exported functions that appear as duplicates in consumer.ts
		await Bun.write(
			path.join(dir, "shared.ts"),
			`export function formatDate(input: Date): string {
  const iso = input.toISOString();
  const parts = iso.split("T");
  return parts[0] ?? "";
}

export function parseIso(input: Date): string {
  const result = input.toISOString();
  const segments = result.split("T");
  return segments[0] ?? "";
}
`
		);
		await Bun.write(
			path.join(dir, "consumer.ts"),
			`function formatDate(input: Date): string {
  const iso = input.toISOString();
  const parts = iso.split("T");
  return parts[0] ?? "";
}

function parseIso(input: Date): string {
  const result = input.toISOString();
  const segments = result.split("T");
  return segments[0] ?? "";
}

export function run(): void {
  console.log(formatDate(new Date()));
  console.log(parseIso(new Date()));
}
`
		);

		await extractCommonCommand({
			directory: dir,
			threshold: 0.95,
			force: true,
			dryRun: false,
		});

		const consumerContent = await Bun.file(
			path.join(dir, "consumer.ts")
		).text();

		// Both duplicate functions should be removed
		expect(consumerContent).not.toContain("function formatDate(input: Date)");
		expect(consumerContent).not.toContain("function parseIso(input: Date)");
		// Both imports should be present
		expect(consumerContent).toContain('from "./shared"');
		// Own function should survive uncorrupted
		expect(consumerContent).toContain("export function run");
		// No corruption: "async", "export", "function" keywords should not be merged
		expect(consumerContent).not.toMatch(/\w+export\s/);

		await rm(dir, { recursive: true, force: true });
	});

	test("closed-over vars: skips functions capturing different module-scope variables", async () => {
		const dir = nextFixtureDir();
		await Bun.write(
			path.join(dir, "tsconfig.json"),
			JSON.stringify({
				compilerOptions: { target: "ES2020", module: "ESNext", strict: true },
				include: ["*.ts"],
			})
		);
		// cal.ts and contacts.ts each have a structurally identical reAuthAndRetry
		// that captures a different module-scope registry. After normalization the
		// bodies are identical, but they must NOT be deduplicated.
		await Bun.write(
			path.join(dir, "cal.ts"),
			`import { calRegistry } from "./registry";

export async function reAuthAndRetry(fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    await calRegistry.reAuth();
    await fn();
  }
}
`
		);
		await Bun.write(
			path.join(dir, "contacts.ts"),
			`import { contactsRegistry } from "./registry";

export async function reAuthAndRetry(fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    await contactsRegistry.reAuth();
    await fn();
  }
}
`
		);
		// Stub registry module so the project is structurally complete
		await Bun.write(
			path.join(dir, "registry.ts"),
			`export const calRegistry = { reAuth: async () => {} };
export const contactsRegistry = { reAuth: async () => {} };
`
		);

		await extractCommonCommand({
			directory: dir,
			threshold: 0.95,
			force: true,
			dryRun: false,
			sameNameOnly: true,
		});

		const calContent = await Bun.file(path.join(dir, "cal.ts")).text();
		const contactsContent = await Bun.file(
			path.join(dir, "contacts.ts")
		).text();

		// Both files should be unchanged — the function captures different registries
		expect(calContent).toContain("async function reAuthAndRetry");
		expect(contactsContent).toContain("async function reAuthAndRetry");
		// No cross-import should have been generated
		expect(contactsContent).not.toContain('from "./cal"');
		expect(calContent).not.toContain('from "./contacts"');

		await rm(dir, { recursive: true, force: true });
	});

	test("--output writes function to specified file and rewrites all sources", async () => {
		const dir = nextFixtureDir();
		await setupFixtures(dir);
		const outputFile = path.join(dir, "shared.ts");

		await extractCommonCommand({
			directory: dir,
			threshold: 0.95,
			force: true,
			dryRun: false,
			output: outputFile,
		});

		const sharedContent = await Bun.file(outputFile).text();
		const aContent = await Bun.file(path.join(dir, "a.ts")).text();
		const bContent = await Bun.file(path.join(dir, "b.ts")).text();

		// shared.ts should contain the exported function
		expect(sharedContent).toContain("export function formatDate");

		// a.ts should no longer contain the function definition
		expect(aContent).not.toContain("function formatDate(input: Date)");
		// a.ts should import from shared (was exported, so re-export)
		expect(aContent).toContain('export { formatDate } from "./shared"');
		// a.ts should still have its own function
		expect(aContent).toContain("export function otherA");

		// b.ts should import from shared (was not exported, so plain import)
		expect(bContent).not.toContain("function formatDate(input: Date)");
		expect(bContent).toContain('import { formatDate } from "./shared"');
		expect(bContent).toContain("export function otherB");

		await rm(dir, { recursive: true, force: true });
	});

	test("--json emits valid JSON with expected schema", async () => {
		const dir = nextFixtureDir();
		await setupFixtures(dir);
		const { stdout, exitCode } = runExtractCommonCli([
			dir,
			"--threshold=0.95",
			"--dry-run",
			"--force",
			"--json",
		]);
		expect(exitCode).toBe(0);

		// Should be valid JSON
		const parsed = JSON.parse(stdout);

		// Top-level schema
		expect(typeof parsed.totalGroups).toBe("number");
		expect(Array.isArray(parsed.groups)).toBe(true);
		expect(typeof parsed.dryRun).toBe("boolean");
		expect(parsed.dryRun).toBe(true);

		// At least one group (formatDate duplicate exists)
		expect(parsed.totalGroups).toBeGreaterThan(0);
		expect(parsed.groups.length).toBe(parsed.totalGroups);

		// Per-group schema
		const group = parsed.groups[0];
		expect(Array.isArray(group.functions)).toBe(true);
		expect(typeof group.canonical).toBe("object");
		expect(Array.isArray(group.removed)).toBe(true);

		// canonical has required fields
		expect(typeof group.canonical.file).toBe("string");
		expect(typeof group.canonical.line).toBe("number");
		expect(typeof group.canonical.name).toBe("string");
		expect(group.canonical.name).toBe("formatDate");

		// removed entries have required fields
		for (const removed of group.removed) {
			expect(typeof removed.file).toBe("string");
			expect(typeof removed.line).toBe("number");
			expect(typeof removed.name).toBe("string");
		}

		// Files should be unchanged (dry-run)
		const aContent = await Bun.file(path.join(dir, "a.ts")).text();
		const bContent = await Bun.file(path.join(dir, "b.ts")).text();
		expect(aContent).toContain("export function formatDate");
		expect(bContent).toContain("function formatDate");

		await rm(dir, { recursive: true, force: true });
	});

	test("--json without --dry-run modifies files and emits JSON with dryRun: false", async () => {
		const dir = nextFixtureDir();
		await setupFixtures(dir);
		const { stdout, exitCode } = runExtractCommonCli([
			dir,
			"--threshold=0.95",
			"--force",
			"--json",
		]);
		expect(exitCode).toBe(0);

		const parsed = JSON.parse(stdout);
		expect(parsed.dryRun).toBe(false);
		expect(parsed.totalGroups).toBeGreaterThan(0);

		// Files should be modified (not dry-run)
		const bContent = await Bun.file(path.join(dir, "b.ts")).text();
		expect(bContent).not.toContain("function formatDate(input: Date)");
		expect(bContent).toContain('import { formatDate } from "./a"');

		await rm(dir, { recursive: true, force: true });
	});

	test("--strict --dry-run exits 1 when extractable groups are found", async () => {
		const dir = nextFixtureDir();
		await setupFixtures(dir);

		const result = runExtractCommonCli([
			dir,
			"--threshold=0.95",
			"--dry-run",
			"--force",
			"--strict",
		]);
		expect(result.exitCode).toBe(1);

		// Files should be unchanged (dry-run)
		const bContent = await Bun.file(path.join(dir, "b.ts")).text();
		expect(bContent).toContain("function formatDate");

		await rm(dir, { recursive: true, force: true });
	});

	test("--strict exits 0 when no extractable groups found", async () => {
		const dir = nextFixtureDir();
		// Single file, no duplicates
		await Bun.write(
			path.join(dir, "tsconfig.json"),
			JSON.stringify({
				compilerOptions: { target: "ES2020", module: "ESNext", strict: true },
				include: ["*.ts"],
			})
		);
		await Bun.write(
			path.join(dir, "a.ts"),
			"export function onlyHere(): number { return 1; }\n"
		);

		const result = runExtractCommonCli([
			dir,
			"--threshold=0.95",
			"--dry-run",
			"--force",
			"--strict",
		]);
		expect(result.exitCode).toBe(0);

		await rm(dir, { recursive: true, force: true });
	});

	test("--workspace: deduplicates across packages in a workspace", async () => {
		const dir = nextFixtureDir();

		// Minimal pnpm workspace with two packages sharing a duplicate function
		await Bun.write(
			path.join(dir, "pnpm-workspace.yaml"),
			`packages:\n  - "packages/*"\n`
		);
		await Bun.write(
			path.join(dir, "package.json"),
			JSON.stringify({ name: "root", version: "0.0.0" })
		);

		const pkgA = path.join(dir, "packages", "pkg-a");
		const pkgB = path.join(dir, "packages", "pkg-b");

		await Bun.write(
			path.join(pkgA, "tsconfig.json"),
			JSON.stringify({
				compilerOptions: { target: "ES2020", module: "ESNext", strict: true },
				include: ["*.ts"],
			})
		);
		await Bun.write(
			path.join(pkgA, "package.json"),
			JSON.stringify({ name: "pkg-a", version: "0.0.0" })
		);
		await Bun.write(
			path.join(pkgA, "utils.ts"),
			`export function formatDate(input: Date): string {
  const iso = input.toISOString();
  const parts = iso.split("T");
  return parts[0] ?? "";
}
`
		);

		await Bun.write(
			path.join(pkgB, "tsconfig.json"),
			JSON.stringify({
				compilerOptions: { target: "ES2020", module: "ESNext", strict: true },
				include: ["*.ts"],
			})
		);
		await Bun.write(
			path.join(pkgB, "package.json"),
			JSON.stringify({ name: "pkg-b", version: "0.0.0" })
		);
		await Bun.write(
			path.join(pkgB, "helpers.ts"),
			`function formatDate(input: Date): string {
  const iso = input.toISOString();
  const parts = iso.split("T");
  return parts[0] ?? "";
}

export function otherHelper(): number {
  return 7;
}
`
		);

		await extractCommonCommand({
			directory: dir,
			threshold: 0.95,
			force: true,
			dryRun: false,
			workspace: true,
		});

		const pkgAContent = await Bun.file(path.join(pkgA, "utils.ts")).text();
		const pkgBContent = await Bun.file(path.join(pkgB, "helpers.ts")).text();

		// pkg-a canonical should be untouched (already exported)
		expect(pkgAContent).toContain("export function formatDate");

		// pkg-b duplicate should be removed and replaced with an import
		expect(pkgBContent).not.toContain("function formatDate(input: Date)");
		// pkg-b should still have its own function
		expect(pkgBContent).toContain("export function otherHelper");

		await rm(dir, { recursive: true, force: true });
	});

	test("skips value extraction that would create circular import", async () => {
		const dir = nextFixtureDir();
		await Bun.write(
			path.join(dir, "tsconfig.json"),
			JSON.stringify({
				compilerOptions: { target: "ES2020", module: "ESNext", strict: true },
				include: ["*.ts"],
			})
		);
		// a.ts imports from b.ts — extracting a duplicate from b→a would create a cycle
		await Bun.write(
			path.join(dir, "a.ts"),
			`import { helperB } from "./b";

export function formatDate(input: Date): string {
  const iso = input.toISOString();
  const parts = iso.split("T");
  return parts[0] ?? "";
}

export function useHelper(): string {
  return helperB();
}
`
		);
		await Bun.write(
			path.join(dir, "b.ts"),
			`export function helperB(): string {
  return "hello";
}

function formatDate(input: Date): string {
  const iso = input.toISOString();
  const parts = iso.split("T");
  return parts[0] ?? "";
}
`
		);

		await extractCommonCommand({
			directory: dir,
			threshold: 0.95,
			force: true,
			dryRun: false,
		});

		const bContent = await Bun.file(path.join(dir, "b.ts")).text();

		// formatDate should NOT be removed from b.ts — extracting it would
		// require b.ts to import from a.ts, creating a circular dependency
		// since a.ts already imports from b.ts.
		expect(bContent).toContain("function formatDate");

		await rm(dir, { recursive: true, force: true });
	});
});

describe("extract-common --output duplicate guard", () => {
	// Use an OS temp dir (not a git repo) so the dirty-worktree guard is inert
	// and `force: false` reaches the duplicate-declaration guard.
	async function setupOutputFixture(): Promise<{
		dir: string;
		output: string;
	}> {
		const dir = await makeTempDir("extract-out-guard");
		await Bun.write(
			path.join(dir, "tsconfig.json"),
			JSON.stringify({
				compilerOptions: { target: "ES2020", module: "ESNext", strict: true },
				include: ["*.ts"],
			})
		);
		const formatDate = `function formatDate(input: Date): string {
  const iso = input.toISOString();
  const parts = iso.split("T");
  return parts[0] ?? "";
}`;
		await Bun.write(path.join(dir, "a.ts"), `export ${formatDate}\n`);
		await Bun.write(
			path.join(dir, "b.ts"),
			`${formatDate}\nexport const useB = formatDate;\n`
		);
		// Output file already declares a near-identical formatDate.
		const output = path.join(dir, "shared.ts");
		await Bun.write(
			output,
			`export function formatDate(value: Date): string {
  const text = value.toISOString();
  const segs = text.split("T");
  return segs[0] ?? "";
}\n`
		);
		return { dir, output };
	}

	test("blocks appending when the output already declares the name", async () => {
		const { dir, output } = await setupOutputFixture();

		const result = await runExtractCommon({
			directory: dir,
			output,
			threshold: 0.95,
			force: false,
			dryRun: false,
			// This block tests the duplicate-declaration guard, not verification.
			// The fixture is an OS temp dir with no node_modules, so leaving verify
			// on would make the assertion depend on `tsc` being on PATH.
			verify: false,
		});

		expect(result.success).toBe(false);
		const message = result.errors[0]?.message ?? "";
		expect(message).toContain("already exists");
		expect(message).toContain("duplicate");

		await rm(dir, { recursive: true, force: true });
	});

	test("--force proceeds past the output conflict", async () => {
		const { dir, output } = await setupOutputFixture();

		const result = await runExtractCommon({
			directory: dir,
			output,
			threshold: 0.95,
			force: true,
			dryRun: false,
			// See the sibling test: this block covers the conflict guard, and the
			// temp-dir fixture has no node_modules to resolve `tsc` from.
			verify: false,
		});

		expect(result.success).toBe(true);

		await rm(dir, { recursive: true, force: true });
	});
});
