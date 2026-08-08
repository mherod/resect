import { describe, expect, test } from "bun:test";
import path from "node:path";
import {
	hasAppRouterRootSegment,
	isFrameworkConventionFile,
} from "./framework-conventions.ts";

const ROUTE_SEGMENT_CONVENTION_STEMS = [
	"apple-icon",
	"default",
	"error",
	"icon",
	"layout",
	"loading",
	"not-found",
	"opengraph-image",
	"page",
	"route",
	"sitemap",
	"template",
	"twitter-image",
] as const;

const APP_ROOT_CONVENTION_STEMS = [
	"global-error",
	"manifest",
	"robots",
] as const;

describe("framework conventions", () => {
	test("recognizes route-segment conventions throughout an App Router tree", () => {
		for (const stem of ROUTE_SEGMENT_CONVENTION_STEMS) {
			expect(
				isFrameworkConventionFile(
					path.join("repo", "src", "app", "blog", `${stem}.tsx`)
				)
			).toBeTrue();
		}
	});

	test("recognizes root-only conventions only at the App Router root", () => {
		for (const stem of APP_ROOT_CONVENTION_STEMS) {
			expect(
				isFrameworkConventionFile(
					path.join("repo", "src", "app", `${stem}.tsx`)
				)
			).toBeTrue();
			expect(
				isFrameworkConventionFile(
					path.join("repo", "src", "app", "blog", `${stem}.tsx`)
				)
			).toBeFalse();
		}
	});

	test("keeps convention stems ordinary outside an App Router tree", () => {
		for (const stem of [
			...ROUTE_SEGMENT_CONVENTION_STEMS,
			...APP_ROOT_CONVENTION_STEMS,
		]) {
			expect(
				isFrameworkConventionFile(
					path.join("repo", "src", "lib", `${stem}.tsx`)
				)
			).toBeFalse();
		}
	});

	test("does not mistake a workspace package named app for an App Router root", () => {
		const file = path.join("repo", "packages", "app", "lib", "apple-icon.tsx");
		expect(hasAppRouterRootSegment(file)).toBeFalse();
		expect(isFrameworkConventionFile(file)).toBeFalse();
	});
});
