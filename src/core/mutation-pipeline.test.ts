import { describe, expect, test } from "bun:test";
import {
	currentCancellationSignal,
	withCancellationSignal,
} from "../runtime/cancellation.ts";
import { bunRuntime, setRuntime } from "../runtime/index.ts";
import type { ProjectConfig } from "../types.ts";
import type { WorktreeGuardOutcome } from "./git.ts";
import {
	MutationExecutionError,
	type MutationPipelineDependencies,
	type MutationPipelineOptions,
	runMutation,
} from "./mutation-pipeline.ts";
import {
	runWithWorkspaceTypecheckGuard,
	type VerificationResult,
} from "./verify.ts";

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

test("restores a retained checkpoint when apply throws after writing", async () => {
	const { baseOptions, dependencies, events } = makeRig();
	let contents = "original";
	const failure = new Error("second write failed");
	const operation = runMutation(
		{
			...baseOptions,
			apply: async () => {
				contents = "partially changed";
				throw failure;
			},
			rollbackStrategy: async () => {
				contents = "original";
				return true;
			},
		},
		dependencies
	);
	const error = await operation.catch((caught: unknown) => caught);
	expect(error instanceof Error && error.message).toContain(
		"second write failed"
	);
	expect(contents).toBe("original");
	expect(events).not.toContain("journal:complete");
});

test("restores after an injected closing verifier throws", async () => {
	const { baseOptions, dependencies, events } = makeRig();
	const operation = runMutation(baseOptions, {
		...dependencies,
		runWithTypecheckGuard: async (_project, apply) => {
			await apply();
			throw new Error("closing verifier failed");
		},
	});
	const error = await operation.catch((caught: unknown) => caught);
	expect(error instanceof Error && error.message).toContain(
		"closing verifier failed"
	);
	expect(events.filter((event) => event === "rollback")).toHaveLength(1);
	expect(events).not.toContain("journal:complete");
});

test("a baseline exception preserves the original failure without applying or restoring", async () => {
	const { baseOptions, dependencies, events } = makeRig();
	const failure = new Error("baseline could not start");
	const error = await runMutation(baseOptions, {
		...dependencies,
		runWithTypecheckGuard: async () => {
			throw failure;
		},
	}).catch((caught: unknown) => caught);
	expect(error).toBe(failure);
	expect(events).not.toContain("apply");
	expect(events).not.toContain("rollback");
	expect(events).not.toContain("journal:complete");
});

test("a closing exception restores partial application even when apply reported failure", async () => {
	const { baseOptions, dependencies, events } = makeRig({
		delta: {
			success: false,
			verificationIncomplete: true,
			verificationException: "closing compiler failed",
		},
	});
	const outcome = await runMutation(
		{ ...baseOptions, apply: async () => ({ success: false }) },
		dependencies
	);
	expect(outcome.success).toBe(false);
	expect(outcome.rolledBack).toBe(true);
	expect(events).not.toContain("journal:complete");
});

test("failed restoration retains the closing verification failure", async () => {
	const { baseOptions, dependencies, events } = makeRig({
		delta: {
			success: false,
			verificationIncomplete: true,
			verificationException: "closing compiler failed",
		},
	});
	const restoreFailure = new Error("restore permission denied");
	const error = await runMutation(
		{
			...baseOptions,
			rollbackStrategy: async () => {
				throw restoreFailure;
			},
		},
		dependencies
	).catch((caught: unknown) => caught);
	expect(error).toBeInstanceOf(MutationExecutionError);
	expect(error).toMatchObject({
		rolledBack: false,
		rollbackAttempted: true,
		rollbackError: restoreFailure,
	});
	expect(error instanceof Error && error.message).toContain(
		"closing compiler failed"
	);
	expect(error instanceof Error && error.message).toContain(
		"restore permission denied"
	);
	expect(events).not.toContain("journal:complete");
});

test.each([
	"restored",
	"failed",
	"threw",
] as const)("apply failure reports %s recovery and preserves its cause", async (recovery) => {
	const { baseOptions, dependencies, events } = makeRig();
	const failure = new Error("EACCES: second write");
	const rollbackFailure = new Error("checkpoint is read-only");
	const error = await runMutation(
		{
			...baseOptions,
			apply: async () => {
				throw failure;
			},
			rollbackStrategy: async () => {
				if (recovery === "threw") {
					throw rollbackFailure;
				}
				return recovery === "restored";
			},
		},
		dependencies
	).catch((caught: unknown) => caught);
	expect(error).toBeInstanceOf(MutationExecutionError);
	if (!(error instanceof MutationExecutionError)) {
		throw new Error("Expected mutation failure");
	}
	expect(error.cause).toBe(failure);
	expect(error.rollbackAttempted).toBe(true);
	expect(error.rolledBack).toBe(recovery === "restored");
	expect(error.rollbackError).toBe(
		recovery === "threw" ? rollbackFailure : undefined
	);
	expect(error.message).toContain("EACCES: second write");
	expect(error.message).toContain(
		recovery === "restored" ? "Changes were rolled back" : "Rollback failed"
	);
	expect(events).not.toContain("journal:complete");
});

test.each([
	"report",
	"dirty",
	"absent",
] as const)("%s policy never invokes recovery after an apply exception", async (policy) => {
	const { baseOptions, dependencies, events } = makeRig({
		guard:
			policy === "dirty"
				? {
						dirty: true,
						rollbackEnabled: false,
						worktreeDirtyRollbackDisabled: true,
					}
				: {},
	});
	const error = await runMutation(
		{
			...baseOptions,
			verify: policy === "report" ? "report" : "rollback",
			rollbackStrategy:
				policy === "absent" ? null : baseOptions.rollbackStrategy,
			apply: async () => {
				throw new Error("write failed");
			},
		},
		dependencies
	).catch((caught: unknown) => caught);
	expect(error).toBeInstanceOf(MutationExecutionError);
	if (!(error instanceof MutationExecutionError)) {
		throw new Error("Expected mutation failure");
	}
	expect(error.rollbackAttempted).toBe(false);
	expect(error.rolledBack).toBe(false);
	expect(error.worktreeDirtyRollbackDisabled).toBe(policy === "dirty");
	expect(events).not.toContain("rollback");
	expect(events).not.toContain("journal:complete");
});

test("an aborted apply still restores without the cancelled request signal when verification is disabled", async () => {
	const { baseOptions, dependencies, events } = makeRig();
	const controller = new AbortController();
	let cleanupSignal: AbortSignal | undefined = controller.signal;
	const error = await withCancellationSignal(controller.signal, async () =>
		runMutation(
			{
				...baseOptions,
				verify: "none",
				apply: async () => {
					controller.abort();
					throw new Error("request cancelled after writing");
				},
				rollbackStrategy: async () => {
					cleanupSignal = currentCancellationSignal();
					return true;
				},
			},
			dependencies
		)
	).catch((caught: unknown) => caught);
	expect(error).toMatchObject({ rolledBack: true });
	expect(cleanupSignal).toBeUndefined();
	expect(events).not.toContain("verify:before");
	expect(events).not.toContain("journal:complete");
});

test("workspace closing exceptions remain rollback-eligible outcomes", async () => {
	const { baseOptions, dependencies, events } = makeRig();
	let checks = 0;
	setRuntime({
		...bunRuntime,
		process: {
			exec: async () => {
				checks += 1;
				if (checks === 2) {
					throw new Error("workspace tsc failed to start");
				}
				return {
					exitCode: 0,
					outputTruncated: false,
					stderr: "",
					stdout: "",
					termination: { kind: "exit", exitCode: 0 },
				};
			},
		},
	});
	try {
		const outcome = await runMutation(baseOptions, {
			...dependencies,
			runWithTypecheckGuard: async (_project, apply, options) =>
				runWithWorkspaceTypecheckGuard([FAKE_PROJECT], apply, options),
		});
		expect(outcome.success).toBe(false);
		expect(outcome.rolledBack).toBe(true);
		expect(outcome.delta?.verificationException).toContain(
			"workspace tsc failed"
		);
		expect(events).not.toContain("journal:complete");
	} finally {
		setRuntime(bunRuntime);
	}
});

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

	test("rollbackRequiresApplySuccess:false rolls back even when isApplySuccessful is false", async () => {
		// move-batch: a partially-failed batch still rolls back the items that
		// did apply when verification finds new errors (#225).
		const { baseOptions, dependencies, events } = makeRig({
			delta: {
				newErrors: ["src/a.ts(1,1): error TS2322: boom"],
				success: false,
			},
		});

		const outcome = await runMutation(
			{
				...baseOptions,
				isApplySuccessful: () => false,
				rollbackRequiresApplySuccess: false,
			},
			dependencies
		);

		expect(events).toContain("rollback");
		expect(outcome.rolledBack).toBe(true);
		expect(outcome.success).toBe(false);
	});

	test("rollbackRequiresApplySuccess defaults to true: no rollback when apply itself failed", async () => {
		const { baseOptions, dependencies, events } = makeRig({
			delta: {
				newErrors: ["src/a.ts(1,1): error TS2322: boom"],
				success: false,
			},
		});

		const outcome = await runMutation(
			{ ...baseOptions, isApplySuccessful: () => false },
			dependencies
		);

		expect(events).not.toContain("rollback");
		expect(outcome.rolledBack).toBe(false);
	});

	test("a function journalDetails receives the apply result", async () => {
		const { baseOptions, dependencies } = makeRig();
		let receivedResult: unknown;

		const outcome = await runMutation(
			{
				...baseOptions,
				journalDetails: (result) => {
					receivedResult = result;
					return { args: {}, command: "test-op" };
				},
			},
			dependencies
		);

		expect(outcome.success).toBe(true);
		expect(receivedResult).toEqual({ success: true });
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
