import { writeSync } from "node:fs";
import { setAnalysisProcessObserver } from "../../src/core/analysis-process.ts";
import { nativePeakRssBytes } from "./native-rss.ts";

process.on("exit", () => {
	writeSync(
		2,
		`${JSON.stringify({ benchmarkParentMemory: true, peakRssBytes: nativePeakRssBytes() })}\n`
	);
});

setAnalysisProcessObserver((usage) => {
	process.stderr.write(
		`${JSON.stringify({ benchmarkWorkerMemory: true, ...usage })}\n`
	);
});
