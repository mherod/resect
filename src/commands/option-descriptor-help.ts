import { descriptorText, type OptionDescriptor } from "./command-descriptor.ts";

const DEFAULT_DESCRIPTION_COLUMN = 25;

/** Render only Options body lines; usage, arguments and examples stay authored. */
export function toCliHelpOptions(
	descriptors: readonly OptionDescriptor[]
): string {
	const lines: string[] = [];
	for (const descriptor of descriptors) {
		const help = descriptor.cliHelp;
		if (!help) {
			throw new Error(`Missing CLI help for --${descriptor.name}`);
		}
		const flag = descriptor.short
			? `  -${descriptor.short}, --${descriptor.name}`
			: `  --${descriptor.name}`;
		const column = DEFAULT_DESCRIPTION_COLUMN;
		const [first, ...continuation] = descriptorText(
			help.description,
			descriptor.default
		).split("\n");
		lines.push(`${flag.padEnd(Math.max(column, flag.length + 1))}${first}`);
		for (const line of continuation) {
			lines.push(`${" ".repeat(column)}${line}`);
		}
	}
	return lines.join("\n");
}
