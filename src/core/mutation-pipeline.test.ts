import { describe, expect, test } from "bun:test";
import type { ProjectConfig } from "../types.ts";
import type { WorktreeGuardOutcome } from "./git.ts";
import {
	type MutationPipelineDependencies,
	type MutationPipelineOptions,
	runMutation,
} from "./mutation-pipeline.ts";
import type { VerificationResult } from "./verify.ts";

const FAKE_PROJECT: ProjectConfig = {
	compilerOptions: {},
	exclude: [],
	files: [],
	include: [],
	pathAliases: new Map(),
	rootDir: "/fake/project",
	tsconfigPath: "/fake/project/tsconfig.json",
};

interface RigOptions {
	guard?: Partial<WorktreeGuardOutcome>;
	delta?: Partial<VerificationResult> | null;
}

function cleanGuard(): WorktreeGuardOutcome {
	return {
		blocked: false,
		dirty: false,
		rollbackEnabled: true,
		worktreeDirtyRollbackDisabled: false,
	};
}

function makeDelta(overrides: Partial<VerificationResult>): VerificationResult {
	return {
		errorsAfter: [],
		errorsBefore: [],
		fixedErrors: [],
		newErrors: [],
		success: true,
		verificationIncomplete: false,
		...overrides,
	};
}

/**
 * Test rig: fake every injected seam, record the order of pipeline events,
 * and return the recorded trace next to the configured runMutation inputs.
 */
function makeRig(rig: RigOptions = {}) {
	const events: string[] = [];
	const guardOutcome: WorktreeGuardOutcome = { ...cleanGuard(), ...rig.guard };
	const delta = rig.delta === null ? null : makeDelta(rig.delta ?? {});

	const dependencies: MutationPipelineDependencies = {
		checkRollbackSafeWorktree: async (dir, _options) => {
			events.push(`guard:${dir}`);
			return Promise.resolve(guardOutcome);
		},
		completeOperationJournal: async (context, _details) => {
			events.push("journal:complete");
			return Promise.resolve(
				context
					? ({ id: "journal-entry-1" } as Awaited<
							ReturnType<
								MutationPipelineDependencies["completeOperationJournal"]
							>
						>)
					: null
			);
		},
		prepareOperationJournal: async (_root, enabled) => {
			events.push(`journal:prepare:${enabled}`);
			return Promise.resolve(
				enabled
					? ({ baseRevision: "rev" } as Awaited<
							ReturnType<
								MutationPipelineDependencies["prepareOperationJournal"]
							>
						>)
					: null
			);
		},
		runWithTypecheckGuard: async (_project, apply, _options) => {
			events.push("verify:before");
			const result = await apply();
			events.push("verify:after");
			if (delta === null) {
				throw new Error("verify fake invoked without a configured delta");
			}
			return { delta: { ...delta }, result };
		},
	};

	const baseOptions: MutationPipelineOptions<{ success: boolean }> = {
		apply: async () => {
			events.push("apply");
			return Promise.resolve({ success: true });
		},
		dryRun: false,
		force: false,
		guardDir: "/fake/project/src",
		isApplySuccessful: (result) => result.success,
		journalDetails: { args: {}, command: "test-op" },
		journalEnabled: true,
		operation: "test-op",
		project: FAKE_PROJECT,
		verify: "rollback",
		rollbackStrategy: async () => {
			events.push("rollback");
			return Promise.resolve(true);
		},
	};

	return { baseOptions, dependencies, events };
}

describe("runMutation contract", () => {
	test("orders guard before journal prepare before apply, and completes the journal last", async () => {
		const { baseOptions, dependencies, events } = makeRig();

		const outcome = await runMutation(baseOptions, dependencies);

		expect(outcome.success).toBe(true);
		expect(events).toEqual([
			"guard:/fake/project/src",
			"journal:prepare:true",
			"verify:before",
			"apply",
			"verify:after",
			"journal:complete",
		]);
	});

	test("a blocked guard stops everything: no journal, no apply, no verify", async () => {
		const { baseOptions, dependencies, events } = makeRig({
			guard: { blocked: true, dirty: true },
		});

		const outcome = await runMutation(baseOptions, dependencies);

		expect(outcome.blocked).toBe(true);
		expect(outcome.success).toBe(false);
		expect(outcome.result).toBeUndefined();
		expect(events).toEqual(["guard:/fake/project/src"]);
	});

	test("journal completes only on verified success", async () => {
		const { baseOptions, dependencies, events } = makeRig({
			delta: {
				newErrors: ["src/a.ts(1,1): error TS2322: boom"],
				success: false,
			},
		});

		const outcome = await runMutation(baseOptions, dependencies);

		expect(outcome.success).toBe(false);
		expect(outcome.journalEntry ?? null).toBeNull();
		expect(events).not.toContain("journal:complete");
	});

	test("new errors under verify:rollback trigger the rollback strategy and honest flags", async () => {
		const { baseOptions, dependencies, events } = makeRig({
			delta: {
				newErrors: ["src/a.ts(1,1): error TS2322: boom"],
				success: false,
			},
		});

		const outcome = await runMutation(baseOptions, dependencies);

		expect(events).toContain("rollback");
		expect(outcome.rolledBack).toBe(true);
		expect(outcome.delta?.rolledBack).toBe(true);
	});

	test("verify:report never rolls back even on new errors", async () => {
		const { baseOptions, dependencies, events } = makeRig({
			delta: {
				newErrors: ["src/a.ts(1,1): error TS2322: boom"],
				success: false,
			},
		});

		const outcome = await runMutation(
			{ ...baseOptions, verify: "report" },
			dependencies
		);

		expect(events).not.toContain("rollback");
		expect(outcome.rolledBack).toBe(false);
		expect(outcome.success).toBe(false);
	});

	test("forced-dirty worktree disables rollback and reports it honestly", async () => {
		const { baseOptions, dependencies, events } = makeRig({
			delta: {
				newErrors: ["src/a.ts(1,1): error TS2322: boom"],
				success: false,
			},
			guard: {
				dirty: true,
				rollbackEnabled: false,
				worktreeDirtyRollbackDisabled: true,
			},
		});

		const outcome = await runMutation(
			{ ...baseOptions, force: true },
			dependencies
		);

		expect(events).not.toContain("rollback");
		expect(outcome.rolledBack).toBe(false);
		expect(outcome.worktreeDirtyRollbackDisabled).toBe(true);
		expect(outcome.delta?.worktreeDirtyRollbackDisabled).toBe(true);
	});

	test("dry run applies without verification, rollback, or journal completion", async () => {
		const { baseOptions, dependencies, events } = makeRig({ delta: null });

		const outcome = await runMutation(
			{ ...baseOptions, dryRun: true },
			dependencies
		);

		expect(outcome.success).toBe(true);
		expect(outcome.delta).toBeUndefined();
		expect(events).toEqual([
			"guard:/fake/project/src",
			"journal:prepare:false",
			"apply",
		]);
	});

	test("verify:none skips the typecheck guard entirely", async () => {
		const { baseOptions, dependencies, events } = makeRig({ delta: null });

		const outcome = await runMutation(
			{ ...baseOptions, verify: "none" },
			dependencies
		);

		expect(outcome.success).toBe(true);
		expect(outcome.delta).toBeUndefined();
		expect(events).not.toContain("verify:before");
		expect(events).toContain("apply");
	});

	test("incomplete verification is failure and triggers rollback under verify:rollback", async () => {
		const { baseOptions, dependencies, events } = makeRig({
			delta: { success: false, verificationIncomplete: true },
		});

		const outcome = await runMutation(baseOptions, dependencies);

		expect(outcome.success).toBe(false);
		expect(events).toContain("rollback");
		expect(events).not.toContain("journal:complete");
	});

	test("blockDirtyDryRun blocks a dirty unforced dry run (MCP guard policy)", async () => {
		const { baseOptions, dependencies, events } = makeRig({ delta: null });
		let guardOptions: unknown;
		dependencies.checkRollbackSafeWorktree = async (dir, options) => {
			guardOptions = options;
			events.push(`guard:${dir}`);
			return Promise.resolve({
				...cleanGuard(),
				blocked: true,
				dirty: true,
			});
		};

		const outcome = await runMutation(
			{ ...baseOptions, blockDirtyDryRun: true, dryRun: true },
			dependencies
		);

		expect(outcome.blocked).toBe(true);
		expect(guardOptions).toMatchObject({
			blockDirtyDryRun: true,
			dryRun: true,
		});
		expect(events).toEqual(["guard:/fake/project/src"]);
	});

	test("a null rollback strategy leaves changes applied on failed verification", async () => {
		const { baseOptions, dependencies, events } = makeRig({
			delta: {
				newErrors: ["src/a.ts(1,1): error TS2322: boom"],
				success: false,
			},
		});

		const outcome = await runMutation(
			{ ...baseOptions, rollbackStrategy: null },
			dependencies
		);

		expect(events).not.toContain("rollback");
		expect(outcome.rolledBack).toBe(false);
		expect(outcome.success).toBe(false);
		expect(outcome.result).toBeDefined();
	});
});
