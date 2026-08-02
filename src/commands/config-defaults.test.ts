import { describe, expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { CLI, cleanup, makeTempDir } from "./__test-helpers.ts";
import { applyResectConfigToCliValues } from "./config-defaults.ts";

describe("CLI project config defaults", () => {
	test("uses config values when flags are absent", () => {
		expect(
			applyResectConfigToCliValues(
				{ "dry-run": true },
				{
					prefer: "alias",
					ignore: "**/*.test.ts",
					verify: false,
					transformConfigPath: "/repo/.resect/transforms.js",
				}
			)
		).toEqual({
			"dry-run": true,
			prefer: "alias",
			ignore: "**/*.test.ts",
			transform: "/repo/.resect/transforms.js",
			"no-verify": true,
		});
	});

	test("explicit flags override config values", () => {
		expect(
			applyResectConfigToCliValues(
				{
					prefer: "relative",
					ignore: "vendor/**",
					verify: true,
					transform: "custom.js",
				},
				{
					prefer: "alias",
					ignore: "**/*.test.ts",
					verify: false,
					transformConfigPath: "/repo/.resect/transforms.js",
				}
			)
		).toEqual({
			prefer: "relative",
			ignore: "vendor/**",
			verify: true,
			transform: "custom.js",
			"no-verify": false,
		});
	});

	test("rejects conflicting verification flags", () => {
		expect(() =>
			applyResectConfigToCliValues({ verify: true, "no-verify": true }, {})
		).toThrow("--verify and --no-verify cannot be used together");
	});

	test("real CLI applies config and preserves explicit precedence", async () => {
		const root = await makeTempDir("project-config-cli");
		try {
			await mkdir(path.join(root, "src", "lib"), { recursive: true });
			await Bun.write(
				path.join(root, "tsconfig.json"),
				JSON.stringify({
					compilerOptions: {
						baseUrl: ".",
						module: "ESNext",
						moduleResolution: "Bundler",
						paths: { "@/*": ["src/*"] },
						strict: true,
						target: "ESNext",
						types: [],
					},
					include: ["src/**/*.ts"],
				})
			);
			await Bun.write(
				path.join(root, "resect.config.ts"),
				'export default { prefer: "alias", verify: false };\n'
			);
			await Bun.write(
				path.join(root, "src", "lib", "value.ts"),
				"export const value = 1;\n"
			);
			await Bun.write(
				path.join(root, "src", "consumer.ts"),
				'import { value } from "./lib/value";\nexport { value };\n'
			);

			const configured = Bun.spawn(
				[...CLI, "alias", "src", "--dry-run", "--json"],
				{
					cwd: root,
					stdout: "pipe",
					stderr: "pipe",
				}
			);
			const [configuredStdout, configuredStderr] = await Promise.all([
				new Response(configured.stdout).text(),
				new Response(configured.stderr).text(),
			]);
			await configured.exited;
			expect(configured.exitCode, configuredStderr).toBe(0);
			expect(configuredStdout).toContain('"newSpecifier": "@/lib/value"');

			const explicit = Bun.spawn(
				[...CLI, "alias", "src", "--prefer=relative", "--dry-run", "--json"],
				{ cwd: root, stdout: "pipe", stderr: "pipe" }
			);
			const [explicitStdout, explicitStderr] = await Promise.all([
				new Response(explicit.stdout).text(),
				new Response(explicit.stderr).text(),
			]);
			await explicit.exited;
			expect(explicit.exitCode, explicitStderr).toBe(0);
			expect(explicitStdout).toContain('"changes": []');
		} finally {
			await cleanup(root);
		}
	});
});
