import { describe, expect, test } from "bun:test";
import { setImmediate } from "node:timers/promises";
import { mapConcurrent } from "./concurrency.ts";

describe("mapConcurrent", () => {
	test("settles started writes before rejecting and stops scheduling after failure", async () => {
		const started: string[] = [];
		const events: string[] = [];
		const slowStarted = Promise.withResolvers<void>();
		const releaseSlow = Promise.withResolvers<void>();
		const slowFinished = Promise.withResolvers<void>();
		const failure = new Error("write failed");
		const operation = mapConcurrent(
			["fail", "slow", "unscheduled"],
			async (item) => {
				started.push(item);
				if (item === "fail") {
					await slowStarted.promise;
					throw failure;
				}
				slowStarted.resolve();
				await releaseSlow.promise;
				events.push("write settled");
				slowFinished.resolve();
				return item;
			},
			{ concurrency: 2 }
		).catch((error: unknown) => {
			events.push("rejected");
			return error;
		});
		await slowStarted.promise;
		await setImmediate();
		const rejectedBeforeSettlement = events.includes("rejected");
		releaseSlow.resolve();
		const error = await operation;
		await slowFinished.promise;
		await setImmediate();
		expect(rejectedBeforeSettlement).toBe(false);
		expect(error).toBe(failure);
		expect(started).toEqual(["fail", "slow"]);
		expect(events).toEqual(["write settled", "rejected"]);
	});
	test("reports monotonic completion progress", async () => {
		const progress: [done: number, total: number][] = [];

		const results = await mapConcurrent([1, 2, 3], async (value) => value * 2, {
			concurrency: 2,
			onProgress: (done, total) => progress.push([done, total]),
		});

		expect(results).toEqual([2, 4, 6]);
		expect(progress).toEqual([
			[1, 3],
			[2, 3],
			[3, 3],
		]);
	});

	test("counts handled errors as completed work", async () => {
		const progress: [done: number, total: number][] = [];

		const results = await mapConcurrent(
			["ok", "broken"],
			async (value) => {
				if (value === "broken") {
					throw new Error("expected failure");
				}
				return value;
			},
			{
				onError: () => "recovered",
				onProgress: (done, total) => progress.push([done, total]),
			}
		);

		expect(results).toEqual(["ok", "recovered"]);
		expect(progress.at(-1)).toEqual([2, 2]);
	});
});
