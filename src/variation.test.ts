import { expect, test } from "vitest";
import { variationDraft } from "./variation.js";
import { animationDraft } from "./animation-draft.js";
import { requestedGridLayout } from "./sprite-layout.js";

test("creates a generation draft that keeps the selected asset as its reference", () => {
  expect(
    variationDraft({
      filename: "kettle-v2.png",
      family: "utils",
      relativePath: "approved/utils/kettle-v2.png",
      tags: ["utils"],
      inspection: { width: 1254, height: 1254 },
    }),
  ).toMatchObject({
    name: "kettle-v2-variation",
    family: "utils",
    references: ["approved/utils/kettle-v2.png"],
    width: 1254,
    height: 1254,
    tags: [],
  });
});

test("a sprite-map remix stays a sprite map with the same readable grid", () => {
  const source = animationDraft({ filename: "kingfisher.png", family: "animals", relativePath: "a/kingfisher.png" });
  const draft = variationDraft({
    filename: "kingfisher-sway-spritemap.png",
    family: "animals",
    relativePath: "candidates/animals/kingfisher-sway-spritemap.png",
    tags: ["animation-spritemap"],
    inspection: { width: 2048, height: 1536 },
    provenance: { prompt: source.prompt },
  });
  expect(draft).toMatchObject({ width: 2048, height: 1536, tags: ["animation-spritemap"] });
  // The Animation Lab reads the grid of the remix from its own brief.
  expect(requestedGridLayout(draft.brief, draft.width, draft.height)).toEqual({ columns: 4, rows: 4 });
});
