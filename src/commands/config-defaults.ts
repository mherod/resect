import type { ResolvedResectConfig } from "../core/project-config.ts";
import type { CliValues } from "./option-flags.ts";

export function applyResectConfigToCliValues(
	values: CliValues,
	defaults: ResolvedResectConfig
): CliValues {
	if (values.verify && values["no-verify"]) {
		throw new Error("--verify and --no-verify cannot be used together");
	}
	let explicitVerify: boolean | undefined;
	if (values.verify) {
		explicitVerify = true;
	} else if (values["no-verify"]) {
		explicitVerify = false;
	}
	const verify = explicitVerify ?? defaults.verify;

	return {
		...values,
		prefer: values.prefer ?? defaults.prefer,
		ignore: values.ignore ?? defaults.ignore,
		transform: values.transform ?? defaults.transformConfigPath,
		...(verify === undefined ? {} : { "no-verify": !verify }),
	};
}
