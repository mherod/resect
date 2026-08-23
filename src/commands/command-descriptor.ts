import { isInDomain } from "./option-domains.ts";
import type { OptionName } from "./option-flags.ts";

type RawCliValues = Partial<Record<OptionName, boolean | string | string[]>>;

interface OptionDescriptorBase<
	Name extends OptionName = OptionName,
	Key extends string = string,
> {
	name: Name;
	key: Key;
	short?: string;
}

export interface BooleanOptionDescriptor<
	Name extends OptionName = OptionName,
	Key extends string = string,
> extends OptionDescriptorBase<Name, Key> {
	type: "boolean";
	default?: boolean;
}

export interface StringOptionDescriptor<
	Name extends OptionName = OptionName,
	Key extends string = string,
> extends OptionDescriptorBase<Name, Key> {
	type: "string";
	multiple?: true;
	default?: string | readonly string[];
}

export interface NumberOptionDescriptor<
	Name extends OptionName = OptionName,
	Key extends string = string,
> extends OptionDescriptorBase<Name, Key> {
	type: "number";
	multiple?: true;
	min?: number;
	max?: number;
	integer?: boolean;
	default?: number | readonly number[];
}

export interface EnumOptionDescriptor<
	Name extends OptionName = OptionName,
	Key extends string = string,
> extends OptionDescriptorBase<Name, Key> {
	type: "enum";
	domain: readonly string[];
	multiple?: true;
	default?: string | readonly string[];
}

export type OptionDescriptor<
	Name extends OptionName = OptionName,
	Key extends string = string,
> =
	| BooleanOptionDescriptor<Name, Key>
	| StringOptionDescriptor<Name, Key>
	| NumberOptionDescriptor<Name, Key>
	| EnumOptionDescriptor<Name, Key>;

/** Shared declarative command shape; presentation fields remain on CommandSpec. */
export interface CommandDescriptor {
	options?: readonly OptionDescriptor[];
}

type DescriptorShort<Descriptor extends OptionDescriptor> = Descriptor extends {
	short: infer Short extends string;
}
	? { short: Short }
	: Record<never, never>;

type DescriptorMultiple<Descriptor extends OptionDescriptor> =
	Descriptor extends { multiple: true }
		? { multiple: true }
		: Record<never, never>;

export type DescriptorFlagSpec<
	Descriptor extends OptionDescriptor = OptionDescriptor,
> = Descriptor extends { type: "boolean" }
	? { type: "boolean" } & DescriptorShort<Descriptor>
	: { type: "string" } & DescriptorShort<Descriptor> &
			DescriptorMultiple<Descriptor>;

/** Convert a semantic option descriptor into node:util parseArgs metadata. */
export function toFlagSpec<const Descriptor extends OptionDescriptor>(
	descriptor: Descriptor
): DescriptorFlagSpec<Descriptor> {
	const short = descriptor.short ? { short: descriptor.short } : {};
	if (descriptor.type === "boolean") {
		return { type: "boolean", ...short } as DescriptorFlagSpec<Descriptor>;
	}
	const multiple = descriptor.multiple ? { multiple: true as const } : {};
	return {
		type: "string",
		...short,
		...multiple,
	} as DescriptorFlagSpec<Descriptor>;
}

type DescriptorScalar<Descriptor extends OptionDescriptor> =
	Descriptor extends { type: "boolean" }
		? boolean
		: Descriptor extends { type: "number" }
			? number
			: Descriptor extends {
						type: "enum";
						domain: readonly (infer Member extends string)[];
					}
				? Member
				: string;

type DescriptorValue<Descriptor extends OptionDescriptor> = Descriptor extends {
	multiple: true;
}
	? DescriptorScalar<Descriptor>[]
	: DescriptorScalar<Descriptor>;

export type RegistryOptions<Descriptors extends readonly OptionDescriptor[]> = {
	[Descriptor in Descriptors[number] as Descriptor["key"]]?: DescriptorValue<Descriptor>;
};

export type RegistryDefaults<Descriptors extends readonly OptionDescriptor[]> =
	{
		[Descriptor in Descriptors[number] as Descriptor extends {
			default: unknown;
		}
			? Descriptor["key"]
			: never]: Descriptor extends { default: infer Default } ? Default : never;
	};

export type RegistryOptionsResult<
	Descriptors extends readonly OptionDescriptor[],
> =
	| { ok: true; value: RegistryOptions<Descriptors> }
	| { ok: false; message: string };

function numberExpectation(descriptor: NumberOptionDescriptor): string {
	const kind = descriptor.integer ? "an integer" : "a finite number";
	if (descriptor.min !== undefined && descriptor.max !== undefined) {
		return `${kind} between ${descriptor.min} and ${descriptor.max}`;
	}
	if (descriptor.min !== undefined) {
		return `${kind} >= ${descriptor.min}`;
	}
	if (descriptor.max !== undefined) {
		return `${kind} <= ${descriptor.max}`;
	}
	return kind;
}

function coerceScalar(
	descriptor: OptionDescriptor,
	raw: string | boolean
):
	| { ok: true; value: string | number | boolean }
	| { ok: false; message: string } {
	switch (descriptor.type) {
		case "boolean":
			return typeof raw === "boolean"
				? { ok: true, value: raw }
				: { ok: false, message: `Error: --${descriptor.name} must be boolean` };
		case "string":
			return typeof raw === "string"
				? { ok: true, value: raw }
				: {
						ok: false,
						message: `Error: --${descriptor.name} must be a string`,
					};
		case "enum":
			if (typeof raw === "string" && isInDomain(descriptor.domain, raw)) {
				return { ok: true, value: raw };
			}
			return {
				ok: false,
				message: `Error: --${descriptor.name} must be one of ${descriptor.domain.map((value) => `'${value}'`).join(", ")}`,
			};
		case "number": {
			if (typeof raw !== "string" || raw === "") {
				return {
					ok: false,
					message: `Error: --${descriptor.name} must be ${numberExpectation(descriptor)}`,
				};
			}
			const value = Number(raw);
			const validNumber = descriptor.integer
				? Number.isInteger(value)
				: Number.isFinite(value);
			const withinMinimum =
				descriptor.min === undefined || value >= descriptor.min;
			const withinMaximum =
				descriptor.max === undefined || value <= descriptor.max;
			if (validNumber && withinMinimum && withinMaximum) {
				return { ok: true, value };
			}
			return {
				ok: false,
				message: `Error: --${descriptor.name} must be ${numberExpectation(descriptor)}`,
			};
		}
		default:
			return {
				ok: false,
				message: "Error: unsupported option descriptor",
			};
	}
}

/**
 * Map parseArgs values into a command's camelCase option bag. Validation is
 * pure: callers render a structured failure and retain ownership of exit codes.
 */
export function toRegistryOptions<
	const Descriptors extends readonly OptionDescriptor[],
>(
	descriptors: Descriptors,
	values: RawCliValues
): RegistryOptionsResult<Descriptors> {
	const options: Record<string, unknown> = {};

	for (const descriptor of descriptors) {
		const raw = values[descriptor.name];
		if (raw === undefined || (descriptor.type === "number" && raw === "")) {
			options[descriptor.key] = undefined;
			continue;
		}

		if ("multiple" in descriptor && descriptor.multiple) {
			if (!Array.isArray(raw)) {
				return {
					ok: false,
					message: `Error: --${descriptor.name} must be repeatable`,
				};
			}
			const coercedValues: Array<string | number | boolean> = [];
			for (const item of raw) {
				const coerced = coerceScalar(descriptor, item);
				if (!coerced.ok) {
					return coerced;
				}
				coercedValues.push(coerced.value);
			}
			options[descriptor.key] = coercedValues;
			continue;
		}

		if (Array.isArray(raw)) {
			return {
				ok: false,
				message: `Error: --${descriptor.name} must be provided once`,
			};
		}
		const coerced = coerceScalar(descriptor, raw);
		if (!coerced.ok) {
			return coerced;
		}
		options[descriptor.key] = coerced.value;
	}

	return { ok: true, value: options as RegistryOptions<Descriptors> };
}

/** Extract the descriptor defaults without re-declaring their values. */
export function toRegistryDefaults<
	const Descriptors extends readonly OptionDescriptor[],
>(descriptors: Descriptors): RegistryDefaults<Descriptors> {
	const defaults: Record<string, unknown> = {};
	for (const descriptor of descriptors) {
		if (descriptor.default !== undefined) {
			defaults[descriptor.key] = descriptor.default;
		}
	}
	return defaults as RegistryDefaults<Descriptors>;
}

export const AUDIT_OPTION_DESCRIPTORS = [
	{ name: "project", key: "project", type: "string", short: "p" },
	{ name: "json", key: "json", type: "boolean" },
	{ name: "workspace", key: "workspace", type: "boolean" },
	{
		name: "fan-out-threshold",
		key: "fanOutThreshold",
		type: "number",
		min: 0,
		default: 10,
	},
	{
		name: "fan-in-threshold",
		key: "fanInThreshold",
		type: "number",
		min: 0,
		default: 10,
	},
	{
		name: "export-threshold",
		key: "exportThreshold",
		type: "number",
		min: 0,
		default: 8,
	},
	{ name: "include-ignored", key: "includeIgnored", type: "boolean" },
] as const satisfies readonly OptionDescriptor[];

export const AUDIT_OPTION_DEFAULTS = toRegistryDefaults(
	AUDIT_OPTION_DESCRIPTORS
);
