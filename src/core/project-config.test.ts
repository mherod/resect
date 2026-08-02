import { describe, expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { cleanup, makeTempDir } from "../commands/__test-helpers.ts";
import {
	loadResectConfig,
	resolveResectConfig,
	validateResectConfig,
} from "./project-config.ts";

describe("project config", () => {
	test("discovers JSON config upward and resolves command defaults", async () => {
		const root = await makeTempDir("project-config-json");
		try {
			const nested = path.join(root, "packages", "app", "src");
			await mkdir(path.join(root, ".resect"), { recursive: true });
			await mkdir(nested, { recursive: true });
			await Bun.write(
				path.join(root, ".resect", "config.json"),
				JSON.stringify({
					prefer: "alias",
					ignore: "**/*.generated.ts",
					verify: true,
					transformConfigPath: ".resect/transforms.js",
					commands: { move: { prefer: "relative", verify: false } },
				})
			);

			const loaded = await loadResectConfig(nested);
			expect(loaded?.rootDir).toBe(root);
			expect(loaded?.path).toBe(path.join(root, ".resect", "config.json"));
			expect(resolveResectConfig(loaded, "move")).toEqual({
				prefer: "relative",
				ignore: "**/*.generated.ts",
				verify: false,
				transformConfigPath: path.join(root, ".resect", "transforms.js"),
				configPath: path.join(root, ".resect", "config.json"),
				rootDir: root,
			});
		} finally {
			await cleanup(root);
		}
	});

	test("prefers resect.config.ts and reloads it after edits", async () => {
		const root = await makeTempDir("project-config-ts");
		try {
			await mkdir(path.join(root, ".resect"), { recursive: true });
			await Bun.write(
				path.join(root, ".resect", "config.json"),
				JSON.stringify({ prefer: "shortest" })
			);
			const configPath = path.join(root, "resect.config.ts");
			await Bun.write(configPath, 'export default { prefer: "alias" };\n');

			const first = await loadResectConfig(root);
			expect(first?.path).toBe(configPath);
			expect(first?.config.prefer).toBe("alias");

			await Bun.write(configPath, 'export default { prefer: "relative" };\n');
			const second = await loadResectConfig(root);
			expect(second?.config.prefer).toBe("relative");
		} finally {
			await cleanup(root);
		}
	});

	test("returns null when no config exists", async () => {
		const root = await makeTempDir("project-config-none");
		try {
			expect(await loadResectConfig(root)).toBeNull();
		} finally {
			await cleanup(root);
		}
	});

	test("reports validation errors with the config source", () => {
		expect(() =>
			validateResectConfig({ prefer: "nearest" }, "/tmp/resect.config.ts")
		).toThrow(
			'Invalid resect config /tmp/resect.config.ts: "prefer" must be "alias", "relative", or "shortest".'
		);
		expect(() =>
			validateResectConfig(
				{ commands: { move: { verify: "yes" } } },
				"/tmp/resect.config.ts"
			)
		).toThrow('commands.move: "verify" must be a boolean.');
		expect(() =>
			validateResectConfig({ mystery: true }, "/tmp/resect.config.ts")
		).toThrow('unknown option "mystery"');
	});
});
