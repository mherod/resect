import { describe, expect, test } from "bun:test";
import { mapConcurrent } from "./concurrency.ts";

describe("mapConcurrent", () => {
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
