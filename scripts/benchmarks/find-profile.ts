import path from "node:path";
import {
	findReportToJson,
	search,
	searchAsync,
} from "../../src/commands/find.ts";
import {
	exportIndexParseCount,
	exportIndexSize,
} from "../../src/core/export-index.ts";
import { discoverProject } from "../../src/core/tsconfig-discovery.ts";
import { findTool } from "../../src/mcp-tools/read-only.ts";
import { withCancellationSignal } from "../../src/runtime/cancellation.ts";
import { outputHash } from "./process.ts";
import { toolText, validateFixture } from "./vscode.ts";

// Run each mode in a separate fresh process; use the same fixture and query.
const fixture = path.resolve(Bun.argv[2] ?? "");
const mode = Bun.argv[3] ?? "library";
if (!["library", "async", "tool", "cancellation"].includes(mode)) {
	throw new Error("Mode must be library, async, tool, or cancellation");
}
await validateFixture(fixture);
let expected: string | undefined;
for (let trial = 1; trial <= 3; trial++) {
	const before = exportIndexParseCount();
	const start = performance.now();
	let report: string;
	let phases: Record<string, number> = {};
	if (mode === "library" || mode === "async") {
		const discovery = discoverProject(fixture);
		const discovered = performance.now();
		const result = await (mode === "library" ? search : searchAsync)(
			"Disposable",
			discovery.fileOwnership,
			fixture,
			"export"
		);
		const searched = performance.now();
		report = JSON.stringify(findReportToJson("Disposable", result), null, 2);
		phases = {
			discoveryMs: discovered - start,
			searchMs: searched - discovered,
			serializationMs: performance.now() - searched,
		};
	} else {
		const call = () => findTool("Disposable", fixture, "export");
		report = toolText(
			mode === "tool"
				? await call()
				: await withCancellationSignal(new AbortController().signal, call)
		);
	}
	const hash = outputHash(report, fixture);
	if (expected && hash !== expected) {
		throw new Error("Find report changed between repetitions");
	}
	expected = hash;
	console.log(
		JSON.stringify({
			mode,
			trial,
			elapsedMs: performance.now() - start,
			...phases,
			parsedFiles: exportIndexParseCount() - before,
			indexSize: exportIndexSize(),
			hash,
		})
	);
}
