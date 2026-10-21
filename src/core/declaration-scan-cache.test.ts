import { expect, test } from "bun:test";
import { unlink, utimes } from "node:fs/promises";
import path from "node:path";
import { cleanup, makeFixture } from "../commands/__test-helpers.ts";
import { DeclarationScanCache } from "./declaration-scan-cache.ts";
import { snapshotMtimes } from "./path-utils.ts";
import { collectFileFunctions } from "./similarity-collection.ts";

test("scan snapshots preserve order and resist caller mutation while respecting their byte bound", async () => {
	const dir = await makeFixture("declaration-cache", {
		"a.ts":
			"export function original(value: number) { return value + value * 2; }",
		"b.ts":
			"export function second(value: number) { return value + value * 3; }",
	});
	try {
		const files = [path.join(dir, "a.ts"), path.join(dir, "b.ts")];
		const result = {
			functions: (await Promise.all(files.map(collectFileFunctions))).flat(),
			totalFiles: 2,
		};
		const snapshot = snapshotMtimes(files);
		const cache = new DeclarationScanCache();
		cache.set(files, snapshot, result);
		const expected = structuredClone(result);
		const groups = [
			{ bucket: "high" as const, score: 0.9, functions: expected.functions },
		];
		cache.setGroups(result.functions, "options-one", groups);
		const warm = cache.get(files);
		if (!warm) {
			throw new Error("Expected warm scan");
		}
		expect(cache.getSummary(warm)).toEqual({ files, totalFunctions: 2 });
		const lazy = cache.get(files);
		if (!lazy) {
			throw new Error("Expected lazy scan");
		}
		Object.defineProperty(lazy, "functions", {
			get() {
				throw new Error("Declarations must not be decoded for a cached report");
			},
		});
		expect(cache.getScanGroups(lazy, "options-one")).toEqual(groups);
		expect(cache.getScanGroups(lazy, "options-two")).toBeUndefined();
		expect(cache.getGroups(warm.functions, "options-one")).toEqual(groups);
		expect(cache.getGroups(warm.functions, "options-two")).toBeUndefined();
		expect(cache.getGroups([...warm.functions], "options-one")).toBeUndefined();
		const cachedGroups = cache.getGroups(warm.functions, "options-one");
		cachedGroups?.splice(0);
		expect(cache.getGroups(warm.functions, "options-one")).toEqual(groups);
		result.functions.length = 0;
		expect(cache.get(files)).toEqual(expected);
		const first = cache.get(files);
		first?.functions.splice(0);
		expect(cache.get(files)).toEqual(expected);
		expect(cache.get(files.toReversed())).toBeUndefined();
		expect(cache.getGroups(warm.functions, "options-one")).toBeUndefined();
		expect(cache.getScanGroups(lazy, "options-one")).toBeUndefined();
		expect(cache.getSummary(lazy)).toBeUndefined();
		const tiny = new DeclarationScanCache(1);
		tiny.set(files, snapshot, expected);
		expect(tiny.get(files)).toBeUndefined();
	} finally {
		await cleanup(dir);
	}
});

test("edits, additions, deletions and edits racing collection invalidate the scan", async () => {
	const dir = await makeFixture("declaration-cache-edits", {
		"a.ts":
			"export function original(value: number) { return value + value * 2; }",
	});
	try {
		const file = path.join(dir, "a.ts");
		const files = [file];
		const result = {
			functions: await collectFileFunctions(file),
			totalFiles: 1,
		};
		const cache = new DeclarationScanCache();
		const before = snapshotMtimes(files);
		cache.set(files, before, result);
		await Bun.write(file, "export const changed = 1;");
		const later = new Date(Date.now() + 2000);
		await utimes(file, later, later);
		expect(cache.get(files)).toBeUndefined();
		cache.set(files, before, result); // A build that raced this edit is also stale.
		expect(cache.get(files)).toBeUndefined();
		cache.set(files, snapshotMtimes(files), result);
		expect(cache.get([...files, path.join(dir, "added.ts")])).toBeUndefined();
		cache.set(files, snapshotMtimes(files), result);
		await unlink(file);
		expect(cache.get(files)).toBeUndefined();
	} finally {
		await cleanup(dir);
	}
});

test("lazy snapshots retain exact Unicode after eviction and keep the decoded-size budget", async () => {
	const dir = await makeFixture("declaration-cache-unicode", {
		"value.ts":
			"export function value(input: number) { return input + input * 2; }",
	});
	try {
		const file = path.join(dir, "value.ts");
		const functions = await collectFileFunctions(file);
		const declaration = functions[0];
		if (!declaration) {
			throw new Error("Expected a declaration");
		}
		declaration.normalizedBody = "\ud800😀\r\n".repeat(4096);
		const result = { functions, totalFiles: 1 };
		const expected = structuredClone(result);
		const cache = new DeclarationScanCache();
		cache.set([file], snapshotMtimes([file]), result);
		const lazy = cache.get([file]);
		expect(lazy).toBeDefined();
		expect(cache.get([])).toBeUndefined();
		declaration.normalizedBody = "changed by caller";
		expect(lazy?.functions).toEqual(expected.functions);
		const bounded = new DeclarationScanCache(4096);
		bounded.set([file], snapshotMtimes([file]), expected);
		expect(bounded.get([file])).toBeUndefined();
	} finally {
		await cleanup(dir);
	}
});

test("reports and declarations share one immutable budget with membership, option and mtime invalidation", async () => {
	const dir = await makeFixture("report-cache", {
		"a.ts":
			"export function value(input: number) { return input + input * 2; }",
	});
	try {
		const file = path.join(dir, "a.ts");
		const files = [file];
		const functions = await collectFileFunctions(file);
		const scan = { functions, totalFiles: 1 };
		const report = {
			groups: [{ bucket: "exact" as const, score: 1, functions }],
			totalFiles: 1,
			totalFunctions: functions.length,
			warnings: [],
		};
		const result = { report, declarationFiles: files, excludedKey: "[]" };
		const before = snapshotMtimes(files);
		const cache = new DeclarationScanCache();
		cache.set(files, before, scan);
		cache.setReport(files, before, "one", result);
		expect(cache.get(files)).toBeUndefined();
		const warm = cache.getReport(files, "one");
		expect(warm?.report).toEqual(report);
		warm?.report.groups[0]?.functions.splice(0);
		warm?.declarationFiles.splice(0);
		expect(cache.getReport(files, "one")?.report).toEqual(report);
		expect(cache.getReport(files, "one")?.declarationFiles).toEqual(files);
		expect(cache.getReport(files, "two")).toBeUndefined();
		cache.setReport(files, before, "one", result);
		expect(cache.getReport([...files, "missing.ts"], "one")).toBeUndefined();
		cache.setReport(files, before, "one", result);
		cache.set(files, before, scan);
		expect(cache.getReport(files, "one")).toBeUndefined();
		cache.setReport(files, before, "one", result);
		await Bun.write(file, "export const changed = 2;");
		const later = new Date(Date.now() + 2000);
		await utimes(file, later, later);
		expect(cache.getReport(files, "one")).toBeUndefined();
		const tiny = new DeclarationScanCache(1);
		tiny.setReport(files, before, "one", result);
		expect(tiny.getReport(files, "one")).toBeUndefined();
	} finally {
		await cleanup(dir);
	}
});
