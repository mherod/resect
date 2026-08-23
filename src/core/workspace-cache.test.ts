import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	mkdir,
	mkdtemp,
	rename,
	rm,
	utimes,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
	clearWorkspaceCache,
	discoverWorkspace,
	getWorkspaceCacheStatsForTesting,
	MAX_WORKSPACE_ALIAS_ENTRIES,
	MAX_WORKSPACE_ROOT_ENTRIES,
} from "./workspace.ts";

const originalDateNow = Date.now;
const temporaryDirectories: string[] = [];
let mtimeSequence = 0;

async function writeJson(filePath: string, value: unknown): Promise<void> {
	await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

async function forceMtimeChange(filePath: string): Promise<void> {
	mtimeSequence += 1;
	const changedAt = new Date(originalDateNow() + 10_000 + mtimeSequence * 1000);
	await utimes(filePath, changedAt, changedAt);
}

async function createPackage(
	root: string,
	relativeDirectory: string,
	name: string,
	version = "1.0.0"
): Promise<string> {
	const packageDirectory = path.join(root, relativeDirectory);
	await mkdir(path.join(packageDirectory, "src"), { recursive: true });
	await writeJson(path.join(packageDirectory, "package.json"), {
		name,
		version,
	});
	await writeFile(
		path.join(packageDirectory, "src", "index.ts"),
		"export const value = 1;\n"
	);
	return packageDirectory;
}

async function createWorkspace(
	packageNames: readonly string[] = ["@fixture/a"]
): Promise<string> {
	const root = await mkdtemp(path.join(tmpdir(), "resect-workspace-cache-"));
	temporaryDirectories.push(root);
	await writeJson(path.join(root, "package.json"), {
		name: "fixture-root",
		private: true,
		version: "1.0.0",
	});
	await writeFile(
		path.join(root, "pnpm-workspace.yaml"),
		"packages:\n  - 'packages/*'\n"
	);
	for (const [index, packageName] of packageNames.entries()) {
		await createPackage(root, `packages/package-${index}`, packageName);
	}
	return root;
}

beforeEach(() => {
	clearWorkspaceCache();
});

afterEach(async () => {
	Date.now = originalDateNow;
	clearWorkspaceCache();
	mtimeSequence = 0;
	for (const directory of temporaryDirectories.splice(0)) {
		await rm(directory, { recursive: true, force: true });
	}
});

describe("workspace discovery cache", () => {
	test("reuses one hydrated root entry from sibling start directories", async () => {
		const root = await createWorkspace(["@fixture/a", "@fixture/b"]);
		const first = await discoverWorkspace(
			path.join(root, "packages/package-0")
		);
		const second = await discoverWorkspace(
			path.join(root, "packages/package-1")
		);

		expect(second).toBe(first);
		expect(getWorkspaceCacheStatsForTesting()).toEqual({
			aliasEntries: 2,
			negativeAliasEntries: 0,
			rootEntries: 1,
		});
	});

	test("keeps an absent root manifest as a stable cache input", async () => {
		const root = await mkdtemp(
			path.join(tmpdir(), "resect-workspace-no-root-")
		);
		temporaryDirectories.push(root);
		await writeFile(
			path.join(root, "pnpm-workspace.yaml"),
			"packages:\n  - 'packages/*'\n"
		);
		await createPackage(root, "packages/package-a", "@fixture/a");

		const first = await discoverWorkspace(root);
		const second = await discoverWorkspace(root);

		expect(second).toBe(first);
		expect(first?.rootPackage).toBeUndefined();
	});

	test("invalidates when the workspace configuration changes", async () => {
		const root = await createWorkspace(["@fixture/a"]);
		await createPackage(root, "modules/package-b", "@fixture/b");
		const first = await discoverWorkspace(root);
		expect(first?.packages.map((pkg) => pkg.name)).toEqual(["@fixture/a"]);

		const workspaceConfig = path.join(root, "pnpm-workspace.yaml");
		await writeFile(workspaceConfig, "packages:\n  - 'modules/*'\n");
		await forceMtimeChange(workspaceConfig);

		const refreshed = await discoverWorkspace(root);
		expect(refreshed).not.toBe(first);
		expect(refreshed?.packages.map((pkg) => pkg.name)).toEqual(["@fixture/b"]);
	});

	test("invalidates root and package manifest edits", async () => {
		const root = await createWorkspace(["@fixture/a"]);
		const first = await discoverWorkspace(root);
		const rootManifest = path.join(root, "package.json");
		await writeJson(rootManifest, {
			name: "renamed-root",
			private: true,
			version: "2.0.0",
		});
		await forceMtimeChange(rootManifest);

		const rootRefreshed = await discoverWorkspace(root);
		expect(rootRefreshed).not.toBe(first);
		expect(rootRefreshed?.rootPackage).toEqual({
			name: "renamed-root",
			packageManager: undefined,
			version: "2.0.0",
		});

		const packageManifest = path.join(root, "packages/package-0/package.json");
		await writeJson(packageManifest, {
			name: "@fixture/a",
			version: "3.0.0",
		});
		await forceMtimeChange(packageManifest);

		const packageRefreshed = await discoverWorkspace(root);
		expect(packageRefreshed).not.toBe(rootRefreshed);
		expect(packageRefreshed?.packages[0]?.version).toBe("3.0.0");
	});

	test("invalidates source, barrel, and tsconfig layout changes", async () => {
		const root = await createWorkspace([]);
		const packageDirectory = path.join(root, "packages/layout");
		await mkdir(path.join(packageDirectory, "lib"), { recursive: true });
		await writeJson(path.join(packageDirectory, "package.json"), {
			name: "@fixture/layout",
		});
		await writeFile(
			path.join(packageDirectory, "lib/index.ts"),
			"export const oldValue = 1;\n"
		);
		const tsconfigPath = path.join(packageDirectory, "tsconfig.json");
		await writeJson(tsconfigPath, {});

		const first = await discoverWorkspace(root);
		expect(first?.packages[0]?.srcDir).toBe("lib");
		expect(first?.packages[0]?.tsconfigPath).toBe(tsconfigPath);

		await mkdir(path.join(packageDirectory, "src"));
		const sourceBarrel = path.join(packageDirectory, "src/index.ts");
		await writeFile(sourceBarrel, "export const newValue = 1;\n");
		await rename(
			tsconfigPath,
			path.join(packageDirectory, "tsconfig.removed.json")
		);
		await forceMtimeChange(packageDirectory);

		const refreshed = await discoverWorkspace(root);
		expect(refreshed).not.toBe(first);
		expect(refreshed?.packages[0]?.srcDir).toBe("src");
		expect(refreshed?.packages[0]?.barrelFiles).toContain(sourceBarrel);
		expect(refreshed?.packages[0]?.tsconfigPath).toBeUndefined();
	});

	test("detects package additions after the bounded re-glob interval", async () => {
		let now = originalDateNow();
		Date.now = () => now;
		const root = await createWorkspace(["@fixture/a"]);
		const first = await discoverWorkspace(root);

		await createPackage(root, "packages/package-b", "@fixture/b");
		now += 60_000;

		const refreshed = await discoverWorkspace(root);
		expect(refreshed).not.toBe(first);
		expect(refreshed?.packages.map((pkg) => pkg.name)).toEqual([
			"@fixture/a",
			"@fixture/b",
		]);
	});

	test("detects package removals and keeps package ordering deterministic", async () => {
		let now = originalDateNow();
		Date.now = () => now;
		const root = await createWorkspace(["@fixture/z", "@fixture/a"]);
		const first = await discoverWorkspace(root);
		expect(first?.packages.map((pkg) => pkg.name)).toEqual([
			"@fixture/a",
			"@fixture/z",
		]);

		await rename(
			path.join(root, "packages/package-0"),
			path.join(root, "removed-package")
		);
		now += 60_000;

		const refreshed = await discoverWorkspace(root);
		expect(refreshed).not.toBe(first);
		expect(refreshed?.packages.map((pkg) => pkg.name)).toEqual(["@fixture/a"]);
	});

	test("expires negative entries so newly created workspaces become visible", async () => {
		let now = originalDateNow();
		Date.now = () => now;
		const root = await mkdtemp(
			path.join(tmpdir(), "resect-workspace-negative-")
		);
		temporaryDirectories.push(root);
		expect(await discoverWorkspace(root)).toBeNull();

		await writeJson(path.join(root, "package.json"), {
			name: "new-workspace",
			private: true,
			workspaces: ["packages/*"],
		});
		await createPackage(root, "packages/package-a", "@fixture/a");
		now += 60_000;

		expect((await discoverWorkspace(root))?.root).toBe(root);
	});

	test("bounds retained roots and evicts their aliases as one group", async () => {
		const roots: string[] = [];
		let firstResult: Awaited<ReturnType<typeof discoverWorkspace>> = null;
		let secondResult: Awaited<ReturnType<typeof discoverWorkspace>> = null;
		for (let index = 0; index < MAX_WORKSPACE_ROOT_ENTRIES; index += 1) {
			const root = await createWorkspace([`@fixture/package-${index}`]);
			roots.push(root);
			const result = await discoverWorkspace(
				path.join(root, "packages/package-0")
			);
			if (index === 0) {
				firstResult = result;
			}
			if (index === 1) {
				secondResult = result;
			}
		}

		const firstRoot = roots[0];
		const secondRoot = roots[1];
		if (!(firstRoot && secondRoot)) {
			throw new Error("Expected at least two root fixtures");
		}
		expect(await discoverWorkspace(firstRoot)).toBe(firstResult);
		const overflowRoot = await createWorkspace(["@fixture/overflow"]);
		await discoverWorkspace(path.join(overflowRoot, "packages/package-0"));

		const stats = getWorkspaceCacheStatsForTesting();
		expect(stats.rootEntries).toBe(MAX_WORKSPACE_ROOT_ENTRIES);
		expect(stats.aliasEntries).toBe(MAX_WORKSPACE_ROOT_ENTRIES + 1);
		expect(firstResult).not.toBeNull();
		expect(secondResult).not.toBeNull();
		expect(await discoverWorkspace(firstRoot)).toBe(firstResult);
		expect(await discoverWorkspace(secondRoot)).not.toBe(secondResult);
	});

	test("bounds high-cardinality start-directory aliases in a long-lived host", async () => {
		const root = await createWorkspace(["@fixture/a"]);
		for (let index = 0; index <= MAX_WORKSPACE_ALIAS_ENTRIES; index += 1) {
			await discoverWorkspace(path.join(root, "virtual", `start-${index}`));
		}

		const stats = getWorkspaceCacheStatsForTesting();
		expect(stats.aliasEntries).toBe(MAX_WORKSPACE_ALIAS_ENTRIES);
		expect(stats.negativeAliasEntries).toBe(0);
		expect(stats.rootEntries).toBe(1);
	});
});
