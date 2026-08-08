import { describe, expect, test } from "bun:test";
import {
	enforceCacheLimit,
	setCacheEntry,
	touchCacheEntry,
} from "./bounded-cache.ts";

describe("bounded cache groups", () => {
	test("evicts the least recently used key from every map", () => {
		const primary = new Map<string, number>([
			["first", 1],
			["second", 2],
		]);
		const metadata = new Map<string, string>([
			["first", "one"],
			["second", "two"],
		]);

		expect(touchCacheEntry(primary, "first")).toBe(1);
		setCacheEntry(primary, "third", 3);
		setCacheEntry(metadata, "third", "three");
		enforceCacheLimit(primary, [primary, metadata], 2);

		expect([...primary.keys()]).toEqual(["first", "third"]);
		expect([...metadata.keys()].sort()).toEqual(["first", "third"]);
	});

	test("removes every overflow entry from a cache group", () => {
		const primary = new Map<string, number>([
			["first", 1],
			["second", 2],
			["third", 3],
		]);
		const metadata = new Map(primary);

		enforceCacheLimit(primary, [primary, metadata], 1);

		expect([...primary.keys()]).toEqual(["third"]);
		expect([...metadata.keys()]).toEqual(["third"]);
	});
});
