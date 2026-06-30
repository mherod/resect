import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const CLI = ["bun", path.resolve(import.meta.dir, "../cli.ts")];

describe("workspace command", () => {
	test("exits with error for non-workspace directory", async () => {
		const tmpDir = await mkdtemp(path.join(tmpdir(), "resect-ws-test-"));
		await Bun.write(path.join(tmpDir, "file.ts"), "export const x = 1;");

		const proc = Bun.spawn([...CLI, "workspace", tmpDir], {
			stderr: "pipe",
			stdout: "pipe",
		});
		const stderr = await new Response(proc.stderr).text();
		await proc.exited;
		expect(proc.exitCode).toBe(1);
		expect(stderr).toContain("No workspace found");

		// Cleanup
		const { rm } = await import("node:fs/promises");
		await rm(tmpDir, { recursive: true, force: true });
	});

	test("discovers pnpm workspace and outputs package info", async () => {
		const tmpDir = path.join(
			import.meta.dir,
			"__fixtures__",
			`ws-test-pnpm-${Date.now()}`
		);

		// Create a minimal pnpm workspace
		await Bun.write(
			path.join(tmpDir, "pnpm-workspace.yaml"),
			'packages:\n  - "packages/*"\n'
		);
		await Bun.write(
			path.join(tmpDir, "package.json"),
			JSON.stringify({ name: "test-workspace", version: "1.0.0" })
		);
		await Bun.write(
			path.join(tmpDir, "packages", "pkg-a", "package.json"),
			JSON.stringify({ name: "@test/pkg-a", version: "1.0.0" })
		);
		await Bun.write(
			path.join(tmpDir, "packages", "pkg-b", "package.json"),
			JSON.stringify({
				name: "@test/pkg-b",
				version: "1.0.0",
				dependencies: { "@test/pkg-a": "workspace:*" },
			})
		);

		const proc = Bun.spawn([...CLI, "workspace", tmpDir], {
			stdout: "pipe",
			stderr: "pipe",
		});
		const stdout = await new Response(proc.stdout).text();
		await proc.exited;
		expect(proc.exitCode).toBe(0);
		expect(stdout).toContain("test-workspace");
		expect(stdout).toContain("pnpm");
		expect(stdout).toContain("@test/pkg-a");
		expect(stdout).toContain("@test/pkg-b");

		const { rm } = await import("node:fs/promises");
		await rm(tmpDir, { recursive: true, force: true });
	});

	test("--json outputs valid JSON", async () => {
		const tmpDir = path.join(
			import.meta.dir,
			"__fixtures__",
			`ws-test-json-${Date.now()}`
		);

		await Bun.write(
			path.join(tmpDir, "pnpm-workspace.yaml"),
			'packages:\n  - "packages/*"\n'
		);
		await Bun.write(
			path.join(tmpDir, "package.json"),
			JSON.stringify({ name: "json-ws", version: "1.0.0" })
		);
		await Bun.write(
			path.join(tmpDir, "packages", "lib", "package.json"),
			JSON.stringify({ name: "@json/lib", version: "0.1.0" })
		);

		const proc = Bun.spawn([...CLI, "workspace", tmpDir, "--json"], {
			stdout: "pipe",
			stderr: "pipe",
		});
		const stdout = await new Response(proc.stdout).text();
		await proc.exited;
		expect(proc.exitCode).toBe(0);

		const parsed = JSON.parse(stdout);
		expect(parsed.type).toBe("pnpm");
		expect(parsed.packages).toBeArray();
		expect(parsed.packages.length).toBeGreaterThanOrEqual(1);
		expect(parsed.packages[0].name).toBe("@json/lib");

		const { rm } = await import("node:fs/promises");
		await rm(tmpDir, { recursive: true, force: true });
	});

	test("--verbose shows detailed package info", async () => {
		const tmpDir = path.join(
			import.meta.dir,
			"__fixtures__",
			`ws-test-verbose-${Date.now()}`
		);

		await Bun.write(
			path.join(tmpDir, "pnpm-workspace.yaml"),
			'packages:\n  - "packages/*"\n'
		);
		await Bun.write(
			path.join(tmpDir, "package.json"),
			JSON.stringify({ name: "verbose-ws", version: "1.0.0" })
		);
		await Bun.write(
			path.join(tmpDir, "packages", "core", "package.json"),
			JSON.stringify({
				name: "@verbose/core",
				version: "1.0.0",
				exports: {
					".": { import: "./dist/index.js", types: "./dist/index.d.ts" },
				},
			})
		);

		const proc = Bun.spawn([...CLI, "workspace", tmpDir, "--verbose"], {
			stdout: "pipe",
			stderr: "pipe",
		});
		const stdout = await new Response(proc.stdout).text();
		await proc.exited;
		expect(proc.exitCode).toBe(0);
		expect(stdout).toContain("Package Details");
		expect(stdout).toContain("@verbose/core");
		expect(stdout).toContain("Exports");

		const { rm } = await import("node:fs/promises");
		await rm(tmpDir, { recursive: true, force: true });
	});

	test("discovers yarn/npm workspace from package.json workspaces field", async () => {
		const tmpDir = path.join(
			import.meta.dir,
			"__fixtures__",
			`ws-test-yarn-${Date.now()}`
		);

		await Bun.write(
			path.join(tmpDir, "package.json"),
			JSON.stringify({
				name: "yarn-ws",
				version: "1.0.0",
				workspaces: ["packages/*"],
			})
		);
		await Bun.write(
			path.join(tmpDir, "packages", "utils", "package.json"),
			JSON.stringify({ name: "@yarn/utils", version: "1.0.0" })
		);

		const proc = Bun.spawn([...CLI, "workspace", tmpDir], {
			stdout: "pipe",
			stderr: "pipe",
		});
		const stdout = await new Response(proc.stdout).text();
		await proc.exited;
		expect(proc.exitCode).toBe(0);
		expect(stdout).toContain("@yarn/utils");

		const { rm } = await import("node:fs/promises");
		await rm(tmpDir, { recursive: true, force: true });
	});

	test("--verbose shows internal dependencies between packages", async () => {
		const tmpDir = path.join(
			import.meta.dir,
			"__fixtures__",
			`ws-test-deps-${Date.now()}`
		);

		await Bun.write(
			path.join(tmpDir, "pnpm-workspace.yaml"),
			'packages:\n  - "packages/*"\n'
		);
		await Bun.write(
			path.join(tmpDir, "package.json"),
			JSON.stringify({ name: "deps-ws", version: "1.0.0" })
		);
		await Bun.write(
			path.join(tmpDir, "packages", "core", "package.json"),
			JSON.stringify({ name: "@deps/core", version: "1.0.0" })
		);
		await Bun.write(
			path.join(tmpDir, "packages", "app", "package.json"),
			JSON.stringify({
				name: "@deps/app",
				version: "1.0.0",
				dependencies: { "@deps/core": "workspace:*" },
			})
		);

		const proc = Bun.spawn([...CLI, "workspace", tmpDir, "--verbose"], {
			stdout: "pipe",
			stderr: "pipe",
		});
		const stdout = await new Response(proc.stdout).text();
		await proc.exited;
		expect(proc.exitCode).toBe(0);
		expect(stdout).toContain("Internal dependencies");
		expect(stdout).toContain("@deps/core");

		const { rm } = await import("node:fs/promises");
		await rm(tmpDir, { recursive: true, force: true });
	});
});
