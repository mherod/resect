import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
	DEFAULT_TRANSFORM_CONFIG_PATH,
	loadTransformConfig,
	validateTransformConfig,
} from "./transform-config.ts";

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
	const dir = await mkdtemp(path.join(tmpdir(), "resect-transform-"));
	try {
		return await fn(dir);
	} finally {
		await rm(dir, { recursive: true, force: true }).catch(() => undefined);
	}
}

/**
 * Await a promise expected to reject and return the Error message, so the
 * caller can assert on it inside its own `test()` block (keeps `expect` out of
 * helpers — Biome's noMisplacedAssertion).
 */
async function rejectionMessage(promise: Promise<unknown>): Promise<string> {
	try {
		await promise;
	} catch (e) {
		return e instanceof Error ? e.message : String(e);
	}
	throw new Error("expected promise to reject, but it resolved");
}

describe("validateTransformConfig (#123)", () => {
	test("accepts a bare array of rules", () => {
		const rules = validateTransformConfig(
			[{ from: "import.meta.env.X", to: "process.env.Y" }],
			"test"
		);
		expect(rules).toEqual([{ from: "import.meta.env.X", to: "process.env.Y" }]);
	});

	test("accepts a { transforms: [...] } object", () => {
		const rules = validateTransformConfig(
			{ transforms: [{ from: "a", to: "b" }] },
			"test"
		);
		expect(rules).toEqual([{ from: "a", to: "b" }]);
	});

	test("treats an empty rule set as valid (returns [])", () => {
		expect(validateTransformConfig([], "test")).toEqual([]);
		expect(validateTransformConfig({ transforms: [] }, "test")).toEqual([]);
	});

	test("drops extra rule keys, keeping only from/to", () => {
		const rules = validateTransformConfig(
			[{ from: "a", to: "b", note: "ignored" }],
			"test"
		);
		expect(rules).toEqual([{ from: "a", to: "b" }]);
	});

	test("throws when the top level is neither array nor { transforms }", () => {
		expect(() => validateTransformConfig({ rules: [] }, "cfg.js")).toThrow(
			/expected an array of rules or \{ transforms/
		);
		expect(() => validateTransformConfig("nope", "cfg.js")).toThrow(
			/expected an array of rules/
		);
		expect(() => validateTransformConfig(null, "cfg.js")).toThrow();
	});

	test("throws with the offending index when a rule is missing 'to'", () => {
		expect(() => validateTransformConfig([{ from: "a" }], "cfg.js")).toThrow(
			/index 0 in cfg\.js: "to" must be a non-empty string/
		);
	});

	test("throws when 'from' is not a non-empty string", () => {
		expect(() =>
			validateTransformConfig([{ from: "", to: "b" }], "cfg.js")
		).toThrow(/"from" must be a non-empty string/);
		expect(() =>
			validateTransformConfig([{ from: 42, to: "b" }], "cfg.js")
		).toThrow(/"from" must be a non-empty string/);
	});

	test("throws when a rule is not an object", () => {
		expect(() => validateTransformConfig(["not-an-object"], "cfg.js")).toThrow(
			/each rule must be an object/
		);
	});
});

describe("loadTransformConfig (#123)", () => {
	test("loads a CommonJS { transforms } config relative to rootDir", async () => {
		await withTempDir(async (dir) => {
			await Bun.write(
				path.join(dir, "transforms.js"),
				"module.exports = { transforms: [{ from: 'import.meta.env.VITE_API_URL', to: 'process.env.NEXT_PUBLIC_API_URL' }] };"
			);
			const rules = await loadTransformConfig(dir, "transforms.js");
			expect(rules).toEqual([
				{
					from: "import.meta.env.VITE_API_URL",
					to: "process.env.NEXT_PUBLIC_API_URL",
				},
			]);
		});
	});

	test("loads a bare-array CommonJS config", async () => {
		await withTempDir(async (dir) => {
			await Bun.write(
				path.join(dir, "transforms.js"),
				"module.exports = [{ from: 'a', to: 'b' }];"
			);
			const rules = await loadTransformConfig(dir, "transforms.js");
			expect(rules).toEqual([{ from: "a", to: "b" }]);
		});
	});

	test("loads an ESM default-export config", async () => {
		await withTempDir(async (dir) => {
			await Bun.write(
				path.join(dir, "transforms.mjs"),
				"export default { transforms: [{ from: 'a', to: 'b' }] };"
			);
			const rules = await loadTransformConfig(dir, "transforms.mjs");
			expect(rules).toEqual([{ from: "a", to: "b" }]);
		});
	});

	test("resolves an absolute config path unchanged", async () => {
		await withTempDir(async (dir) => {
			const abs = path.join(dir, "transforms.js");
			await Bun.write(abs, "module.exports = { transforms: [] };");
			const rules = await loadTransformConfig("/some/other/root", abs);
			expect(rules).toEqual([]);
		});
	});

	test("throws a clear error when the config is missing (writes nothing)", async () => {
		await withTempDir(async (dir) => {
			expect(
				await rejectionMessage(loadTransformConfig(dir, "transforms.js"))
			).toMatch(/Transform config not found/);
		});
	});

	test("throws on a malformed config shape", async () => {
		await withTempDir(async (dir) => {
			await Bun.write(
				path.join(dir, "transforms.js"),
				"module.exports = { rules: 'nope' };"
			);
			expect(
				await rejectionMessage(loadTransformConfig(dir, "transforms.js"))
			).toMatch(/Invalid transform config/);
		});
	});

	test("throws on a rule missing required fields", async () => {
		await withTempDir(async (dir) => {
			await Bun.write(
				path.join(dir, "transforms.js"),
				"module.exports = { transforms: [{ from: 'a' }] };"
			);
			expect(
				await rejectionMessage(loadTransformConfig(dir, "transforms.js"))
			).toMatch(/Invalid transform rule at index 0/);
		});
	});

	test("wraps a config that throws while loading", async () => {
		await withTempDir(async (dir) => {
			await Bun.write(
				path.join(dir, "transforms.js"),
				"throw new Error('boom');"
			);
			expect(
				await rejectionMessage(loadTransformConfig(dir, "transforms.js"))
			).toMatch(/Failed to load transform config/);
		});
	});

	test("exposes the conventional default config path", () => {
		expect(DEFAULT_TRANSFORM_CONFIG_PATH).toBe(".resect/transforms.js");
	});
});
