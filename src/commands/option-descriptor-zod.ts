import { z } from "zod";
import {
	descriptorText,
	type McpPresentation,
	type OptionDescriptor,
	type PositionalDescriptor,
} from "./command-descriptor.ts";

type InputDescriptor = OptionDescriptor | PositionalDescriptor;

type ScalarSchema<Descriptor extends InputDescriptor> = Descriptor extends {
	type: "boolean";
}
	? z.ZodBoolean
	: Descriptor extends { type: "number" }
		? z.ZodNumber
		: Descriptor extends {
					type: "enum";
					domain: readonly (infer Member extends string)[];
				}
			? z.ZodEnum<{ [Value in Member]: Value }>
			: z.ZodString;

type ValueSchema<Descriptor extends InputDescriptor> = Descriptor extends {
	multiple: true;
}
	? z.ZodArray<ScalarSchema<Descriptor>>
	: ScalarSchema<Descriptor>;

type InputSchema<Descriptor extends InputDescriptor> = Descriptor extends {
	mcp: { required: true };
}
	? ValueSchema<Descriptor>
	: z.ZodOptional<ValueSchema<Descriptor>>;

export type DescriptorZodShape<Descriptors extends readonly InputDescriptor[]> =
	{
		[Descriptor in Descriptors[number] as Descriptor extends {
			mcp: McpPresentation;
		}
			? Descriptor["key"]
			: never]: InputSchema<Descriptor>;
	};

function scalarSchema(descriptor: InputDescriptor): z.ZodType {
	switch (descriptor.type) {
		case "boolean":
			return z.boolean();
		case "string":
			return z.string();
		case "number":
			return z.number();
		case "enum":
			return z.enum(descriptor.domain);
		default:
			throw new Error("Unsupported MCP input descriptor");
	}
}

/**
 * MCP-only generator: production consumers must be registration modules.
 * CLI bounds/defaults are intentionally not applied to existing MCP contracts.
 */
export function toZodShape<
	const Descriptors extends readonly InputDescriptor[],
>(descriptors: Descriptors): DescriptorZodShape<Descriptors> {
	const shape = new Map<string, z.ZodType>();
	for (const descriptor of descriptors) {
		if (!descriptor.mcp) {
			continue;
		}
		if (shape.has(descriptor.key)) {
			throw new Error(`Duplicate MCP input key: ${descriptor.key}`);
		}
		let schema = scalarSchema(descriptor);
		if ("multiple" in descriptor && descriptor.multiple) {
			schema = z.array(schema);
		}
		if (!descriptor.mcp.required) {
			schema = schema.optional();
		}
		const defaultValue =
			"default" in descriptor ? descriptor.default : undefined;
		shape.set(
			descriptor.key,
			schema.describe(descriptorText(descriptor.mcp.description, defaultValue))
		);
	}
	return Object.fromEntries(shape) as DescriptorZodShape<Descriptors>;
}
