import { describe, expect, test } from "bun:test";
import path from "node:path";
import { analyzeDependencyContracts } from "./dependency-contracts.ts";
import type { WorkspaceInfo, WorkspacePackage } from "./workspace.ts";

const root = "/repo";

function workspacePackage(
	name: string,
	overrides: Partial<WorkspacePackage> = {}
): WorkspacePackage {
	const directory = path.join(root, "packages", name.replaceAll("/", "-"));
	return {
		name,
		path: directory,
		packageJsonPath: path.join(directory, "package.json"),
		...overrides,
	};
}

function workspace(packages: WorkspacePackage[]): WorkspaceInfo {
	return {
		root,
		type: "pnpm",
		patterns: ["packages/*"],
		packages,
	};
}

describe("analyzeDependencyContracts", () => {
	test("plans explicit external and workspace consumer dependencies", () => {
		const schema = workspacePackage("@test/schema");
		const provider = workspacePackage("@test/provider", {
			dependencies: { "@test/schema": "workspace:*", zod: "^4.0.0" },
			resect: { consumerDependencies: ["@test/schema", "zod"] },
		});
		const consumer = workspacePackage("@test/consumer", {
			dependencies: { "@test/provider": "workspace:*" },
		});

		const report = analyzeDependencyContracts(
			workspace([schema, provider, consumer])
		);

		expect(report.issues).toEqual([]);
		expect(report.conflicts).toEqual([]);
		expect(
			report.changes.map(({ dependencyName, section, specifier, type }) => ({
				dependencyName,
				section,
				specifier,
				type,
			}))
		).toEqual([
			{
				dependencyName: "@test/schema",
				section: "dependencies",
				specifier: "workspace:*",
				type: "add",
			},
			{
				dependencyName: "zod",
				section: "dependencies",
				specifier: "^4.0.0",
				type: "add",
			},
		]);
	});

	test("expands workspace closure only when the contract opts in", () => {
		const utils = workspacePackage("@test/utils");
		const schema = workspacePackage("@test/schema", {
			dependencies: { "@test/utils": "workspace:*" },
		});
		const provider = workspacePackage("@test/provider", {
			dependencies: { "@test/schema": "workspace:*" },
			resect: {
				consumerDependencies: [
					{ name: "@test/schema", includeWorkspaceClosure: true },
				],
			},
		});
		const consumer = workspacePackage("functions", {
			dependencies: { "@test/provider": "file:../provider" },
		});

		const report = analyzeDependencyContracts(
			workspace([utils, schema, provider, consumer])
		);
		const changes = report.changes.map((change) => ({
			dependencyName: change.dependencyName,
			specifier: change.specifier,
			chain: change.reasons[0]?.chain,
			kind: change.reasons[0]?.kind,
		}));

		expect(changes).toEqual([
			{
				dependencyName: "@test/schema",
				specifier: "file:../@test-schema",
				chain: ["@test/provider", "@test/schema"],
				kind: "contract",
			},
			{
				dependencyName: "@test/utils",
				specifier: "file:../@test-utils",
				chain: ["@test/provider", "@test/schema", "@test/utils"],
				kind: "workspace-closure",
			},
		]);
	});

	test("honours explicit dependency sections and reports moves", () => {
		const provider = workspacePackage("@test/provider", {
			peerDependencies: { react: ">=18" },
			resect: {
				consumerDependencies: [{ name: "react", section: "peerDependencies" }],
			},
		});
		const consumer = workspacePackage("@test/consumer", {
			dependencies: {
				"@test/provider": "workspace:*",
				react: "^18.0.0",
			},
		});

		const report = analyzeDependencyContracts(workspace([provider, consumer]));
		expect(report.changes).toHaveLength(1);
		expect(report.changes[0]).toMatchObject({
			dependencyName: "react",
			fromSection: "dependencies",
			fromSpecifier: "^18.0.0",
			section: "peerDependencies",
			specifier: ">=18",
			type: "move",
		});
	});

	test("reports conflicting consumer requirements without planning a change", () => {
		const left = workspacePackage("@test/left", {
			dependencies: { zod: "^3.0.0" },
			resect: { consumerDependencies: ["zod"] },
		});
		const right = workspacePackage("@test/right", {
			dependencies: { zod: "^4.0.0" },
			resect: { consumerDependencies: ["zod"] },
		});
		const consumer = workspacePackage("@test/consumer", {
			dependencies: {
				"@test/left": "workspace:*",
				"@test/right": "workspace:*",
			},
		});

		const report = analyzeDependencyContracts(
			workspace([left, right, consumer])
		);
		expect(report.conflicts).toHaveLength(1);
		expect(report.conflicts[0]?.requirements).toHaveLength(2);
		expect(report.changes).toEqual([]);
	});

	test("reports malformed policies and missing provider declarations", () => {
		const malformed = workspacePackage("@test/malformed", {
			resect: { consumerDependencies: [{ name: "" }, 42 as never] },
		});
		const provider = workspacePackage("@test/provider", {
			resect: { consumerDependencies: ["zod"] },
		});
		const consumer = workspacePackage("@test/consumer", {
			dependencies: { "@test/provider": "workspace:*" },
		});

		const report = analyzeDependencyContracts(
			workspace([malformed, provider, consumer])
		);
		expect(report.issues.map((issue) => issue.code)).toEqual([
			"invalid-policy-entry",
			"invalid-policy-entry",
			"missing-provider-dependency",
		]);
	});

	test("terminates cyclic policy and workspace-closure expansion", () => {
		const left = workspacePackage("@test/left", {
			dependencies: { "@test/right": "workspace:*" },
			resect: {
				consumerDependencies: [
					{ name: "@test/right", includeWorkspaceClosure: true },
				],
			},
		});
		const right = workspacePackage("@test/right", {
			dependencies: { "@test/left": "workspace:*" },
		});
		const consumer = workspacePackage("@test/consumer", {
			dependencies: { "@test/left": "workspace:*" },
		});

		const report = analyzeDependencyContracts(
			workspace([left, right, consumer])
		);
		expect(report.conflicts).toEqual([]);
		expect(
			report.requirements
				.filter((item) => item.consumerName === "@test/consumer")
				.map((item) => item.dependencyName)
		).toEqual(["@test/left", "@test/right"]);
		expect(
			report.changes
				.filter((item) => item.consumerName === "@test/consumer")
				.map((item) => item.dependencyName)
		).toEqual(["@test/right"]);
	});
});
