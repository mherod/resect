import { describe, expect, test } from "bun:test";
import { bunRuntime, setRuntime } from "../runtime/index.ts";
import type { ProcessResult } from "../runtime/types.ts";
import type { ProjectConfig } from "../types.ts";
import {
	isIncompleteTypeCheck,
	parseTsCompilerOutput,
	runTypeCheckDetailed,
	runWithWorkspaceTypecheckGuard,
	VERIFY_INCOMPLETE_PREFIX,
} from "./verify.ts";

test("a workspace closing exception preserves other projects' completed diagnostics", async () => {
	const projects: ProjectConfig[] = ["a", "b"].map((name) => ({
		rootDir: `/workspace/${name}`,
		tsconfigPath: `/workspace/${name}/tsconfig.json`,
		compilerOptions: {},
		pathAliases: new Map(),
		include: [],
		exclude: [],
		files: [],
	}));
	const checks = new Map<string, number>();
	const diagnostic = "src/value.ts(1,1): error TS2322: new project-b error";
	setRuntime({
		...bunRuntime,
		process: {
			exec: async (_args, options) => {
				const cwd = options?.cwd ?? "";
				const count = (checks.get(cwd) ?? 0) + 1;
				checks.set(cwd, count);
				if (cwd.endsWith("/a") && count === 2) {
					throw new Error("project-a compiler unavailable");
				}
				const exitCode = count === 2 ? 1 : 0;
				return {
					exitCode,
					stdout: count === 2 ? diagnostic : "",
					stderr: "",
					outputTruncated: false,
					termination: { kind: "exit", exitCode },
				};
			},
		},
	});
	try {
		const { delta, result } = await runWithWorkspaceTypecheckGuard(
			projects,
			async () => "applied"
		);
		expect(result).toBe("applied");
		expect(delta.success).toBe(false);
		expect(delta.verificationIncomplete).toBe(true);
		expect(delta.verificationException).toBe("project-a compiler unavailable");
		expect(delta.newErrors).toEqual([diagnostic]);
		expect([...checks.values()]).toEqual([2, 2]);
	} finally {
		setRuntime(bunRuntime);
	}
});

describe("parseTsCompilerOutput", () => {
	test("returns empty list when tsc exits zero", () => {
		const result = parseTsCompilerOutput("", 0);
		expect(result.errors).toEqual([]);
		expect(result.incomplete).toBe(false);
	});

	test("ignores stray output when tsc exits zero", () => {
		const result = parseTsCompilerOutput("some warning text", 0);
		expect(result.errors).toEqual([]);
		expect(result.incomplete).toBe(false);
	});

	test("parses a per-file diagnostic", () => {
		const output =
			'src/foo.ts(12,5): error TS2307: Cannot find module "./bar".';
		const result = parseTsCompilerOutput(output, 1);
		expect(result.errors).toEqual([output]);
		expect(result.incomplete).toBe(false);
	});

	test("parses a global TS2688 diagnostic and marks the run incomplete (regression #67)", () => {
		const output = [
			"error TS2688: Cannot find type definition file for 'jest'.",
			"error TS2688: Cannot find type definition file for 'node'.",
		].join("\n");
		const result = parseTsCompilerOutput(output, 1);
		expect(result.errors).toHaveLength(2);
		expect(result.errors[0]).toBe(
			"error TS2688: Cannot find type definition file for 'jest'."
		);
		expect(result.incomplete).toBe(true);
	});

	test("synthesizes a VERIFY_INCOMPLETE marker when tsc exits non-zero with no parseable output (regression #67)", () => {
		const result = parseTsCompilerOutput("", 1);
		expect(result.errors).toHaveLength(1);
		expect(result.errors[0]?.startsWith(VERIFY_INCOMPLETE_PREFIX)).toBe(true);
		expect(result.errors[0]).toContain("code 1");
		expect(result.incomplete).toBe(true);
	});

	test("synthesizes a VERIFY_INCOMPLETE marker even when tsc emits an unrecognised non-error message", () => {
		const result = parseTsCompilerOutput(
			"some unexpected internal failure trace",
			2
		);
		expect(result.incomplete).toBe(true);
		expect(result.errors[0]?.startsWith(VERIFY_INCOMPLETE_PREFIX)).toBe(true);
		expect(result.errors[0]).toContain("some unexpected internal failure");
	});

	test("mixes per-file and global diagnostics in the same output", () => {
		const output = [
			"error TS2688: Cannot find type definition file for 'jest'.",
			"src/foo.ts(1,1): error TS2307: Cannot find module './missing'.",
		].join("\n");
		const result = parseTsCompilerOutput(output, 1);
		expect(result.errors).toHaveLength(2);
		expect(result.incomplete).toBe(true);
	});
});

describe("isIncompleteTypeCheck", () => {
	test("flags the synthetic verify-incomplete marker", () => {
		expect(
			isIncompleteTypeCheck([
				`${VERIFY_INCOMPLETE_PREFIX} tsc exited with code 1`,
			])
		).toBe(true);
	});

	test("flags fatal global TS errors", () => {
		expect(
			isIncompleteTypeCheck([
				"error TS2688: Cannot find type definition file for 'jest'.",
			])
		).toBe(true);
	});

	test("does not flag a clean per-file diagnostic list", () => {
		expect(
			isIncompleteTypeCheck([
				'src/foo.ts(1,1): error TS2307: Cannot find module "./bar".',
			])
		).toBe(false);
	});

	test("does not flag an empty list", () => {
		expect(isIncompleteTypeCheck([])).toBe(false);
	});
});

// ─── Abnormal process termination is never a clean typecheck (#245) ────────

describe("runTypeCheckDetailed abnormal termination (#245)", () => {
	const project: ProjectConfig = {
		rootDir: "/repo",
		tsconfigPath: "/repo/tsconfig.json",
		compilerOptions: {},
		pathAliases: new Map(),
		include: [],
		exclude: [],
		files: [],
	};

	function fakeRuntimeWith(result: ProcessResult) {
		setRuntime({
			...bunRuntime,
			process: { exec: async () => Promise.resolve(result) },
		});
	}

	const abnormalResults: ProcessResult[] = [
		{
			stdout: "",
			stderr: "",
			exitCode: null,
			termination: { kind: "spawn-error", message: "ENOENT" },
			outputTruncated: false,
		},
		{
			stdout: "",
			stderr: "",
			exitCode: null,
			termination: { kind: "timeout" },
			outputTruncated: false,
		},
		{
			stdout: "",
			stderr: "",
			exitCode: null,
			termination: { kind: "aborted" },
			outputTruncated: false,
		},
		{
			stdout: "",
			stderr: "",
			exitCode: null,
			termination: { kind: "signal", signal: "SIGKILL" },
			outputTruncated: false,
		},
		{
			stdout: "partial",
			stderr: "",
			exitCode: 0,
			termination: { kind: "exit", exitCode: 0 },
			outputTruncated: true,
		},
	];

	for (const result of abnormalResults) {
		const label =
			result.termination.kind === "exit"
				? "truncated output"
				: result.termination.kind;
		test(`${label} with empty diagnostics is incomplete, never clean`, async () => {
			fakeRuntimeWith(result);
			try {
				const outcome = await runTypeCheckDetailed(project);
				expect(outcome.incomplete).toBe(true);
				expect(outcome.errors[0]).toStartWith(VERIFY_INCOMPLETE_PREFIX);
			} finally {
				setRuntime(bunRuntime);
			}
		});
	}

	test("a normal empty exit-0 run still parses clean", async () => {
		fakeRuntimeWith({
			stdout: "",
			stderr: "",
			exitCode: 0,
			termination: { kind: "exit", exitCode: 0 },
			outputTruncated: false,
		});
		try {
			const outcome = await runTypeCheckDetailed(project);
			expect(outcome.errors).toEqual([]);
			expect(outcome.incomplete).toBe(false);
		} finally {
			setRuntime(bunRuntime);
		}
	});
});
