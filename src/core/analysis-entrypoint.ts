// Bundled library chunks sit at the output root; bundled worker entrypoints
// retain these subdirectories and inline their own copy of this module.
const NESTED_ENTRYPOINTS = [
	"core/analysis-worker.js",
	"core/analysis-process-host.js",
	"commands/mutation-worker.js",
	"mcp-tools/read-only-worker.js",
];

export function resolveAnalysisEntrypoint(
	sourcePath: string,
	bundledPath: string,
	moduleUrl: string
): URL {
	if (moduleUrl.endsWith(".ts")) {
		return new URL(sourcePath, moduleUrl);
	}
	const nested = NESTED_ENTRYPOINTS.some((entry) =>
		moduleUrl.endsWith(`/${entry}`)
	);
	return new URL(bundledPath, nested ? new URL("../", moduleUrl) : moduleUrl);
}
