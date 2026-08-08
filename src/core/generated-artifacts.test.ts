import { afterAll, describe, expect, test } from "bun:test";
import path from "node:path";
import { cleanup, makeFixture } from "../commands/__test-helpers.ts";
import {
	createFrameworkGeneratedArtifactClassifier,
	excludeFrameworkGeneratedArtifacts,
	generatedArtifactWarning,
} from "./generated-artifacts.ts";
import type { DependencyGraph } from "./graph.ts";

const fixtures: string[] = [];

afterAll(async () => {
	for (const directory of fixtures) {
		await cleanup(directory);
	}
});

describe("framework-generated TypeScript artifacts", () => {
	test("classifies only Next-generated type trees under the default distDir", async () => {
		const root = await makeFixture(
			"generated-default",
			{ "tsconfig.json": "{}\n" },
			{ outsideRepo: true }
		);
		fixtures.push(root);
		const tsconfigPath = path.join(root, "tsconfig.json");
		const classifier = await createFrameworkGeneratedArtifactClassifier([
			tsconfigPath,
		]);

		expect(
			classifier.classify(path.join(root, ".next/types/routes.d.ts"))
		).toEqual(
			expect.objectContaining({
				framework: "next",
				generatedDirectory: path.join(root, ".next"),
				tsconfigPath,
			})
		);
		expect(
			classifier.classify(path.join(root, ".next/dev/types/cache-life.d.ts"))
		).toBeDefined();
		expect(classifier.classify(path.join(root, ".next/cache/trace.ts"))).toBe(
			undefined
		);
		expect(classifier.classify(path.join(root, "src/authored.d.ts"))).toBe(
			undefined
		);
	});

	test("reads a static custom distDir without executing Next config code", async () => {
		const root = await makeFixture(
			"generated-custom",
			{
				"next.config.ts": [
					"throw new Error('must not execute');",
					"const config = { distDir: 'build-output' } as const;",
					"export default config;",
				].join("\n"),
				"tsconfig.json": "{}\n",
			},
			{ outsideRepo: true }
		);
		fixtures.push(root);
		const tsconfigPath = path.join(root, "tsconfig.json");
		const classifier = await createFrameworkGeneratedArtifactClassifier([
			tsconfigPath,
		]);

		expect(
			classifier.classify(path.join(root, "build-output/types/routes.d.ts"))
		).toEqual(
			expect.objectContaining({
				generatedDirectory: path.join(root, "build-output"),
				tsconfigPath,
			})
		);
		expect(
			classifier.classify(
				path.join(root, "build-output/dev/types/route-metadata.d.ts")
			)
		).toBeDefined();
	});

	test("removes generated sources and references from a dependency graph", async () => {
		const root = await makeFixture(
			"generated-graph",
			{ "tsconfig.json": "{}\n" },
			{ outsideRepo: true }
		);
		fixtures.push(root);
		const authored = path.join(root, "src/authored.ts");
		const generated = path.join(root, ".next/types/routes.d.ts");
		const graph: DependencyGraph = {
			imports: new Map([
				[
					authored,
					[
						{
							sourceFile: authored,
							specifier: generated,
							resolvedPath: generated,
							type: "import",
							line: 1,
							column: 1,
							isTypeOnly: true,
						},
					],
				],
				[generated, []],
			]),
			importedBy: new Map(),
			skippedFiles: [generated],
			barrelFiles: new Set([generated]),
			barrelReExports: new Map([[generated, [authored]]]),
		};
		const classifier = await createFrameworkGeneratedArtifactClassifier([
			path.join(root, "tsconfig.json"),
		]);

		const result = excludeFrameworkGeneratedArtifacts(graph, classifier);

		expect(result.excludedGeneratedFiles.map(({ file }) => file)).toEqual([
			generated,
		]);
		expect(result.graph.imports).toEqual(new Map([[authored, []]]));
		expect(result.graph.importedBy.size).toBe(0);
		expect(result.graph.skippedFiles).toEqual([]);
		expect(result.graph.barrelFiles.size).toBe(0);
		expect(result.graph.barrelReExports.size).toBe(0);
		expect(generatedArtifactWarning(1)).toBe(
			"Excluded 1 framework-generated TypeScript file(s) from analysis."
		);
	});
});
