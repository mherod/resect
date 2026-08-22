import { describe, expect, test } from "bun:test";
import { bunRuntime } from "./bun.ts";
import { withCancellationSignal, withoutCancellation } from "./cancellation.ts";
import { nodeRuntime } from "./node.ts";
import type { ProcessRunner } from "./types.ts";

const runners: [string, ProcessRunner][] = [
	["bun", bunRuntime.process],
	["node", nodeRuntime.process],
];

const SHORT_TIMEOUT_MS = 200;
const SMALL_OUTPUT_LIMIT = 1024;

for (const [name, runner] of runners) {
	describe(`${name} ProcessRunner termination parity (#245)`, () => {
		test("a normal exit reports its code and full output", async () => {
			const result = await runner.exec([
				"sh",
				"-c",
				"printf out; printf err >&2; exit 3",
			]);

			expect(result.termination).toEqual({ kind: "exit", exitCode: 3 });
			expect(result.exitCode).toBe(3);
			expect(result.stdout).toBe("out");
			expect(result.stderr).toBe("err");
			expect(result.outputTruncated).toBe(false);
		});

		test("stdin is delivered before streams are drained", async () => {
			const result = await runner.exec(["cat"], { stdin: "hello" });

			expect(result.termination).toEqual({ kind: "exit", exitCode: 0 });
			expect(result.stdout).toBe("hello");
		});

		test("a missing executable is a spawn error, never exit 0", async () => {
			const result = await runner.exec(["definitely-not-a-real-binary-245"]);

			expect(result.termination.kind).toBe("spawn-error");
			expect(result.exitCode).toBeNull();
		});

		test("a pre-aborted signal never spawns and reports aborted", async () => {
			const controller = new AbortController();
			controller.abort();

			const result = await runner.exec(["sleep", "5"], {
				signal: controller.signal,
			});

			expect(result.termination).toEqual({ kind: "aborted" });
			expect(result.exitCode).toBeNull();
		});

		test("a live abort stops a running child promptly", async () => {
			const controller = new AbortController();
			const started = performance.now();
			const pending = runner.exec(["sleep", "5"], {
				signal: controller.signal,
			});
			setTimeout(() => {
				controller.abort();
			}, 50);

			const result = await pending;

			expect(result.termination).toEqual({ kind: "aborted" });
			expect(result.exitCode).toBeNull();
			expect(performance.now() - started).toBeLessThan(4000);
		});

		test("a deadline overrun reports timeout, not a clean exit", async () => {
			const started = performance.now();
			const result = await runner.exec(["sleep", "5"], {
				timeoutMs: SHORT_TIMEOUT_MS,
			});

			expect(result.termination).toEqual({ kind: "timeout" });
			expect(result.exitCode).toBeNull();
			expect(performance.now() - started).toBeLessThan(4000);
		});

		test("oversized stdout is bounded, truncated, and terminal", async () => {
			const result = await runner.exec(
				["sh", "-c", "head -c 100000 /dev/zero; sleep 5"],
				{ maxOutputBytes: SMALL_OUTPUT_LIMIT }
			);

			expect(result.termination).toEqual({
				kind: "output-limit",
				stream: "stdout",
			});
			expect(result.outputTruncated).toBe(true);
			expect(result.stdout.length).toBeLessThanOrEqual(SMALL_OUTPUT_LIMIT);
		});

		test("oversized stderr is bounded, truncated, and terminal", async () => {
			const result = await runner.exec(
				["sh", "-c", "head -c 100000 /dev/zero >&2; sleep 5"],
				{ maxOutputBytes: SMALL_OUTPUT_LIMIT }
			);

			expect(result.termination).toEqual({
				kind: "output-limit",
				stream: "stderr",
			});
			expect(result.outputTruncated).toBe(true);
			expect(result.stderr.length).toBeLessThanOrEqual(SMALL_OUTPUT_LIMIT);
		});

		test("the ambient cancellation scope reaches spawned children", async () => {
			const controller = new AbortController();
			const pending = withCancellationSignal(controller.signal, async () =>
				runner.exec(["sleep", "5"])
			);
			setTimeout(() => {
				controller.abort();
			}, 50);

			const result = await pending;

			expect(result.termination).toEqual({ kind: "aborted" });
		});

		test("withoutCancellation shields cleanup from an aborted scope", async () => {
			const controller = new AbortController();
			controller.abort();

			const result = await withCancellationSignal(controller.signal, async () =>
				withoutCancellation(async () => runner.exec(["sh", "-c", "printf ok"]))
			);

			expect(result.termination).toEqual({ kind: "exit", exitCode: 0 });
			expect(result.stdout).toBe("ok");
		});
	});
}
