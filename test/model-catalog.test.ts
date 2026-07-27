import assert from "node:assert/strict";
import test from "node:test";
import {
	compareCodexModelStrength,
	parseCodexModelCatalog,
} from "../model-catalog.ts";

test("live Codex catalog follows server priority: Sol beats Terra and Luna", () => {
	const models = parseCodexModelCatalog({
		models: [
			{
				slug: "gpt-5.6-luna",
				display_name: "5.6 Luna",
				visibility: "list",
				priority: 30,
				supported_reasoning_levels: [{ effort: "high" }, { effort: "xhigh" }],
				context_window: 272_000,
			},
			{
				slug: "gpt-5.6-sol",
				display_name: "5.6 Sol",
				visibility: "list",
				priority: 10,
				supported_reasoning_levels: [
					{ effort: "low" },
					{ effort: "medium" },
					{ effort: "high" },
					{ effort: "xhigh" },
				],
				input_modalities: ["text", "image"],
			},
			{
				slug: "gpt-5.6-terra",
				display_name: "5.6 Terra",
				visibility: "list",
				priority: 20,
				supported_reasoning_levels: [{ effort: "medium" }, { effort: "high" }],
			},
			{
				slug: "retired-hidden-model",
				display_name: "Hidden",
				visibility: "hide",
				priority: 0,
			},
		],
	});

	assert.deepEqual(
		models.map((model) => model.id),
		["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"],
	);
	assert.equal(models[0].thinkingLevelMap?.xhigh, "xhigh");
	assert.equal(models[0].thinkingLevelMap?.minimal, "low");
	assert.deepEqual(models[0].input, ["text", "image"]);
});

test("unknown future Codex generations rank without an extension release", () => {
	const ids = [
		"gpt-5.6-sol",
		"gpt-5.7-luna",
		"gpt-5.7-sol",
		"gpt-5.7-mini",
	].map((id) => ({ id }));
	ids.sort(compareCodexModelStrength);
	assert.deepEqual(
		ids.map((model) => model.id),
		["gpt-5.7-sol", "gpt-5.7-luna", "gpt-5.7-mini", "gpt-5.6-sol"],
	);
});
