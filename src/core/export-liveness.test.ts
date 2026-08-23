import { describe, expect, test } from "bun:test";
import path from "node:path";
import { cleanup, makeFixture } from "../commands/__test-helpers.ts";
import {
	type ExportLivenessCandidate,
	evaluateExportLiveness,
} from "./export-liveness.ts";
import { buildDependencyGraph, withGraphSourceFile } from "./graph.ts";
import { loadProject } from "./project.ts";

describe("export-liveness policy", () => {
	test("uses the same verdict path for one and many prepared candidates", async () => {
		const dir = await makeFixture("export-liveness-policy", {
			"tsconfig.json": JSON.stringify({
				compilerOptions: { strict: true },
				include: ["src/**/*.ts"],
			}),
			"package.json": JSON.stringify({
				name: "export-liveness-policy",
				main: "./dist/index.js",
			}),
			"src/index.ts": 'export { publicValue } from "./value";\n',
			"src/value.ts": [
				"export const publicValue = 1;",
				"export const internalOnly = 2;",
				"console.log(internalOnly);",
			].join("\n"),
			"src/app/api/route.ts": "export const GET = () => new Response();\n",
			"src/wrapper.ts":
				'import { helper } from "./helper";\nexport const wrapper = () => helper();\n',
			"src/helper.ts": "export const helper = () => 1;\n",
		});

		try {
			const project = loadProject(path.join(dir, "tsconfig.json"));
			const graph = await buildDependencyGraph(project);
			const graphProgram = graph.program;
			if (!graphProgram) {
				throw new Error("Expected the project graph to own a Program");
			}
			const selectedPrograms = new Set<object>();
			const prepare = (relativeFile: string): ExportLivenessCandidate => {
				const file = path.join(dir, relativeFile);
				const candidate = withGraphSourceFile<ExportLivenessCandidate | null>(
					graph,
					file,
					(sourceFile, program) => {
						selectedPrograms.add(program);
						return {
							file,
							sourceFile,
							checker: program.getTypeChecker(),
						};
					},
					null
				);
				if (!candidate) {
					throw new Error(`Graph did not own ${file}`);
				}
				return candidate;
			};

			const value = prepare("src/value.ts");
			const candidates = [
				value,
				prepare("src/app/api/route.ts"),
				prepare("src/wrapper.ts"),
				prepare("src/helper.ts"),
			];
			const sharedOptions = {
				graph,
				packageDirectory: dir,
				analysisDirectory: path.join(dir, "src"),
			};
			const [single, batch] = await Promise.all([
				evaluateExportLiveness({ ...sharedOptions, candidates: [value] }),
				evaluateExportLiveness({ ...sharedOptions, candidates }),
			]);

			expect(selectedPrograms.size).toBe(1);
			expect([...selectedPrograms]).toEqual([graphProgram]);
			expect(single.files).toHaveLength(1);
			expect(single.files[0]).toEqual(
				batch.files.find(({ file }) => file === value.file)
			);
			expect(single.files[0]?.publicApiExports.map(({ name }) => name)).toEqual(
				["publicValue"]
			);
			expect(single.files[0]?.unusedExports).toEqual([
				expect.objectContaining({
					name: "internalOnly",
					internalUsage: true,
					internalRefCount: 1,
				}),
			]);
			expect(batch.excludedEntrypointFiles).toEqual([
				path.join(dir, "src/app/api/route.ts"),
			]);
			expect(batch.transitivelyDeadExports).toEqual([
				expect.objectContaining({
					file: path.join(dir, "src/helper.ts"),
					name: "helper",
					deadImporters: [path.join(dir, "src/wrapper.ts")],
				}),
			]);
		} finally {
			await cleanup(dir);
		}
	});
});
