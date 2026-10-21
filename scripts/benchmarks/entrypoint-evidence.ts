import { readdir } from "node:fs/promises";
import path from "node:path";
import { outputHash } from "./process.ts";

// This comparison permits only the exact additive explanation introduced by
// Job 4. Every prior field, verdict, score, order and warning must still match.
const baseline = path.resolve(Bun.argv[2] ?? "");
const candidate = path.resolve(Bun.argv[3] ?? "");
const before = await Bun.file(path.join(baseline, "receipts.json")).json();
const after = await Bun.file(path.join(candidate, "receipts.json")).json();
if (after.failures.length !== 0) {
	throw new Error("Candidate benchmark failed");
}
const expectedReason = `Could not resolve package entrypoint "./out/main.js" from ${path.join(after.metadata.fixture, "package.json")}; external usage remains unknown.`;
const files = (await readdir(candidate)).filter((file) =>
	file.endsWith(".stdout")
);
if (files.length !== 35) {
	throw new Error(`Expected 35 reports, got ${files.length}`);
}
let explained = 0;
for (const file of files) {
	const previous = await Bun.file(path.join(baseline, file)).json();
	const current = await Bun.file(path.join(candidate, file)).json();
	if (file.includes("-analyze-")) {
		if (
			JSON.stringify(current.publicApiTraceReasons) !==
			JSON.stringify([expectedReason])
		) {
			throw new Error(`${file}: wrong trace explanation`);
		}
		current.publicApiTraceReasons = undefined;
		explained++;
	}
	if (file.includes("-unused-")) {
		if (current.warnings.at(-1) !== expectedReason) {
			throw new Error(`${file}: missing exact unresolved target`);
		}
		current.warnings.pop();
		explained++;
	}
	if (
		outputHash(JSON.stringify(current), after.metadata.fixture) !==
		outputHash(JSON.stringify(previous), before.metadata.fixture)
	) {
		throw new Error(`${file}: prior report content changed`);
	}
}
console.log(
	JSON.stringify({
		reports: files.length,
		additiveExplanations: explained,
		priorFieldsExact: true,
	})
);
