import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import path from "node:path";
import { bunRuntime, type Runtime, setRuntime } from "../runtime/index.ts";
import { discoverPackageEntrypoints } from "./package-entrypoints.ts";
import { normalizePath } from "./resolver.ts";
import {
	clearWorkspaceCache,
	discoverWorkspace,
	WORKSPACE_HYDRATION_CONCURRENCY,
} from "./workspace.ts";

const WORKSPACE_ROOT = "/virtual/resect-workspace";
const MANIFEST_DELAY_MS = 30;

interface HydrationMetrics {
	activeOperationHighWater: number;
	closedDescriptors: number;
	descriptorHighWater: number;
	manifestReads: number;
	openedDescriptors: number;
}

interface ManifestFixture {
	delayMs?: number;
	manifest: Record<string, unknown> | Error;
}

function installWorkspaceRuntime(
	fixtures: ReadonlyMap<string, ManifestFixture>,
	existingPaths: ReadonlySet<string>
): HydrationMetrics {
	const metrics: HydrationMetrics = {
		activeOperationHighWater: 0,
		closedDescriptors: 0,
		descriptorHighWater: 0,
		manifestReads: 0,
		openedDescriptors: 0,
	};
	let activeOperations = 0;
	let openDescriptors = 0;
	const workspaceConfig = path.join(WORKSPACE_ROOT, "pnpm-workspace.yaml");
	const rootManifest = path.join(WORKSPACE_ROOT, "package.json");

	const runtime: Runtime = {
		process: bunRuntime.process,
		fs: {
			async readFile(filePath: string): Promise<string> {
				if (filePath === workspaceConfig) {
					return "packages:\n  - 'packages/*'\n";
				}
				if (filePath === rootManifest) {
					return JSON.stringify({ name: "fixture-root", private: true });
				}
				const fixture = fixtures.get(filePath);
				if (fixture) {
					metrics.manifestReads += 1;
					metrics.openedDescriptors += 1;
					activeOperations += 1;
					openDescriptors += 1;
					metrics.activeOperationHighWater = Math.max(
						metrics.activeOperationHighWater,
						activeOperations
					);
					metrics.descriptorHighWater = Math.max(
						metrics.descriptorHighWater,
						openDescriptors
					);
					try {
						await Bun.sleep(fixture.delayMs ?? MANIFEST_DELAY_MS);
						if (fixture.manifest instanceof Error) {
							throw fixture.manifest;
						}
						return JSON.stringify(fixture.manifest);
					} finally {
						activeOperations -= 1;
						openDescriptors -= 1;
						metrics.closedDescriptors += 1;
					}
				}
				if (existingPaths.has(filePath)) {
					return "export const entrypoint = true;\n";
				}
				throw new Error(`Unexpected read: ${filePath}`);
			},
			async writeFile(): Promise<void> {
				throw new Error("Unexpected write");
			},
			async exists(filePath: string): Promise<boolean> {
				return (
					filePath === workspaceConfig ||
					filePath === rootManifest ||
					fixtures.has(filePath) ||
					existingPaths.has(filePath)
				);
			},
			async deleteFile(): Promise<void> {
				throw new Error("Unexpected delete");
			},
			async rename(): Promise<void> {
				throw new Error("Unexpected rename");
			},
		},
		glob: {
			async *glob(): AsyncIterable<string> {
				for (const packageJsonPath of fixtures.keys()) {
					yield packageJsonPath;
				}
			},
		},
	};
	setRuntime(runtime);
	return metrics;
}

function packageManifestPath(index: number): string {
	return path.join(
		WORKSPACE_ROOT,
		"packages",
		`package-${index}`,
		"package.json"
	);
}

beforeEach(() => {
	clearWorkspaceCache();
});

afterEach(() => {
	clearWorkspaceCache();
	setRuntime(bunRuntime);
});

describe("workspace package hydration", () => {
	test("bounds concurrent hydration, isolates failure, and records resource metrics", async () => {
		const packageCount = WORKSPACE_HYDRATION_CONCURRENCY * 2 + 1;
		const fixtures = new Map<string, ManifestFixture>();
		for (let index = 0; index < packageCount; index += 1) {
			fixtures.set(packageManifestPath(index), {
				manifest:
					index === 3
						? new Error("unreadable fixture manifest")
						: { name: `@fixture/package-${index}`, version: "1.0.0" },
			});
		}
		const metrics = installWorkspaceRuntime(fixtures, new Set());
		const startedAt = performance.now();

		const workspace = await discoverWorkspace(WORKSPACE_ROOT);
		const wallTimeMs = performance.now() - startedAt;

		expect(workspace?.packages).toHaveLength(packageCount - 1);
		expect(workspace?.packages.map((pkg) => pkg.name)).toEqual(
			workspace?.packages.map((pkg) => pkg.name).toSorted()
		);
		expect(metrics.activeOperationHighWater).toBeGreaterThan(1);
		expect(metrics.activeOperationHighWater).toBeLessThanOrEqual(
			WORKSPACE_HYDRATION_CONCURRENCY
		);
		expect(metrics.descriptorHighWater).toBe(metrics.activeOperationHighWater);
		expect(metrics.openedDescriptors).toBe(packageCount);
		expect(metrics.closedDescriptors).toBe(metrics.openedDescriptors);
		expect(wallTimeMs).toBeLessThan(packageCount * MANIFEST_DELAY_MS);
	});

	test("reuses retained manifests and keeps entrypoint ordering deterministic", async () => {
		const firstPackageRoot = path.join(WORKSPACE_ROOT, "packages/package-0");
		const secondPackageRoot = path.join(WORKSPACE_ROOT, "packages/package-1");
		const firstEntrypoint = path.join(firstPackageRoot, "src/index.ts");
		const firstBin = path.join(firstPackageRoot, "src/cli.ts");
		const secondEntrypoint = path.join(secondPackageRoot, "src/index.ts");
		const fixtures = new Map<string, ManifestFixture>([
			[
				packageManifestPath(0),
				{
					delayMs: MANIFEST_DELAY_MS * 2,
					manifest: {
						name: "@fixture/z-package",
						exports: "./src/index.ts",
						bin: "./src/cli.ts",
					},
				},
			],
			[
				packageManifestPath(1),
				{
					delayMs: 1,
					manifest: {
						name: "@fixture/a-package",
						exports: "./src/index.ts",
					},
				},
			],
		]);
		const metrics = installWorkspaceRuntime(
			fixtures,
			new Set([
				path.join(firstPackageRoot, "src"),
				path.join(secondPackageRoot, "src"),
				firstEntrypoint,
				firstBin,
				secondEntrypoint,
			])
		);
		const workspace = await discoverWorkspace(WORKSPACE_ROOT);
		await discoverWorkspace(path.join(firstPackageRoot, "src"));
		const manifestReadsAfterHydration = metrics.manifestReads;

		const entrypoints = await discoverPackageEntrypoints(
			path.join(firstPackageRoot, "src"),
			{ includeWorkspacePackages: true }
		);

		expect(workspace?.packages.map((pkg) => pkg.name)).toEqual([
			"@fixture/a-package",
			"@fixture/z-package",
		]);
		const serializedWorkspace = JSON.parse(JSON.stringify(workspace)) as {
			packages: Record<string, unknown>[];
		};
		expect(serializedWorkspace.packages[1]).not.toHaveProperty("bin");
		expect(metrics.manifestReads).toBe(manifestReadsAfterHydration);
		expect([...entrypoints.files]).toEqual([
			normalizePath(secondEntrypoint),
			normalizePath(firstEntrypoint),
		]);
		expect([...entrypoints.binFiles]).toEqual([normalizePath(firstBin)]);
		expect(entrypoints.unresolved).toEqual([]);
	});
});
