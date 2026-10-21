import { expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import path from "node:path";
import { cleanup, makeFixture } from "../commands/__test-helpers.ts";
import { bunRuntime, setRuntime } from "../runtime/index.ts";
import { loadProject } from "./project.ts";
import { runTypeCheckDetailed } from "./verify.ts";

test("missing explicit type dependencies fail before a full compiler allocation and refresh after installation or removal", async () => {
	const dir = await makeFixture(
		"verify-type-preflight",
		{
			"tsconfig.json": JSON.stringify({
				compilerOptions: {
					noEmit: true,
					types: ["available", "missing"],
					typeRoots: ["./types"],
				},
				include: ["src/*.ts"],
			}),
			"src/value.ts": "export const value = 1;",
			"types/available/index.d.ts": "declare const available: string;",
		},
		{ outsideRepo: true }
	);
	let compilerRuns = 0;
	setRuntime({
		...bunRuntime,
		process: {
			exec: async () => {
				compilerRuns++;
				return {
					stdout: "",
					stderr: "",
					exitCode: 0,
					termination: { kind: "exit", exitCode: 0 },
					outputTruncated: false,
				};
			},
		},
	});
	try {
		const project = loadProject(path.join(dir, "tsconfig.json"));
		expect(await runTypeCheckDetailed(project)).toEqual({
			errors: ["error TS2688: Cannot find type definition file for 'missing'."],
			incomplete: true,
		});
		expect(compilerRuns).toBe(0);
		await Bun.write(
			path.join(dir, "types/missing/index.d.ts"),
			"declare const present: string;"
		);
		expect(await runTypeCheckDetailed(project)).toEqual({
			errors: [],
			incomplete: false,
		});
		expect(compilerRuns).toBe(1);
		await unlink(path.join(dir, "types/available/index.d.ts"));
		expect(await runTypeCheckDetailed(project)).toEqual({
			errors: [
				"error TS2688: Cannot find type definition file for 'available'.",
			],
			incomplete: true,
		});
		expect(compilerRuns).toBe(1);
		await Bun.write(
			path.join(dir, "node_modules/@types/excluded/index.d.ts"),
			"declare const excluded: string;"
		);
		project.compilerOptions.types = ["excluded"];
		expect(await runTypeCheckDetailed(project)).toEqual({
			errors: [
				"error TS2688: Cannot find type definition file for 'excluded'.",
			],
			incomplete: true,
		});
		expect(compilerRuns).toBe(1);
	} finally {
		setRuntime(bunRuntime);
		await cleanup(dir);
	}
});
