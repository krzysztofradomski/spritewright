import { expect, test } from "vitest";
import { DEFAULT_BRIEFS, briefWarnings, fillBrief } from "./brief-templates.js";
import { animationDraft } from "./animation-draft.js";
import { requestedGridLayout } from "./sprite-layout.js";

test("a project's saved brief replaces the default and keeps its grid readable", () => {
  const custom = "Make a slow {motion} loop: {frames} frames, {columns} columns × {rows} rows, {width}×{height}.";
  const draft = animationDraft({ filename: "reed.png", family: "plants", relativePath: "a/reed.png" }, { animation: custom });
  expect(draft.prompt).toBe("Make a slow sway loop: 16 frames, 4 columns × 4 rows, 1024×1024.");
  expect(requestedGridLayout(draft.prompt, draft.width, draft.height)).toEqual({ columns: 4, rows: 4 });
  // An empty saved brief falls back to the default rather than sending nothing.
  expect(fillBrief("variation", { variation: "" }, {})).toBe(DEFAULT_BRIEFS.variation);
});

test("warns when an edit would break grid detection or uses an unknown placeholder", () => {
  expect(briefWarnings("animation", DEFAULT_BRIEFS.animation)).toEqual([]);
  expect(briefWarnings("animation", "Eight frames of {motion} in a {size} grid.")).toHaveLength(2);
  expect(briefWarnings("variation", DEFAULT_BRIEFS.variation)).toEqual([]);
});
