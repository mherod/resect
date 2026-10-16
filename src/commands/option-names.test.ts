import { expect, test } from "bun:test";
import ts from "typescript";
import type { OptionDescriptor } from "./command-descriptor.ts";
import {
	type OptionName as LegacyOptionName,
	OPTION_FLAGS,
} from "./option-flags.ts";
import type { OptionName } from "./option-names.ts";

test("option names retain the legacy type export and exactly match runtime flags", () => {
	// Both directions are checked by tsc; widening either union fails compilation.
	const sameLegacyType: [OptionName, LegacyOptionName] extends [
		LegacyOptionName,
		OptionName,
	]
		? true
		: false = true;
	const sameRuntimeKeys: [OptionName, keyof typeof OPTION_FLAGS] extends [
		keyof typeof OPTION_FLAGS,
		OptionName,
	]
		? true
		: false = true;
	expect(sameLegacyType).toBeTrue();
	expect(sameRuntimeKeys).toBeTrue();
	const option: OptionDescriptor = {
		name: "dry-run",
		key: "dryRun",
		type: "boolean",
	};
	expect(OPTION_FLAGS[option.name].type).toBe("boolean");
	// @ts-expect-error Arbitrary option names must not become valid during extraction.
	const invalidName: OptionName = "not-a-resect-option";
	expect(invalidName in OPTION_FLAGS).toBeFalse();
	const invalidDescriptor: OptionDescriptor = {
		// @ts-expect-error Descriptor names must retain the same closed option domain.
		name: "not-a-resect-option",
		key: "unknown",
		type: "string",
	};
	expect(invalidDescriptor.name in OPTION_FLAGS).toBeFalse();
});

test("option name ownership has no dependencies and descriptors have no return edge to flags", async () => {
	const namesSource = await Bun.file(
		`${import.meta.dir}/option-names.ts`
	).text();
	expect(ts.preProcessFile(namesSource).importedFiles).toEqual([]);
	const descriptorSource = await Bun.file(
		`${import.meta.dir}/command-descriptor.ts`
	).text();
	const imports = ts
		.preProcessFile(descriptorSource)
		.importedFiles.map(({ fileName }) => fileName);
	expect(imports).toContain("./option-names.ts");
	expect(imports).not.toContain("./option-flags.ts");
});
