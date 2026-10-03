import { expect, test } from "vitest";
import { matchesSearch, originalBrief, versionGroupKey } from "./library.js";

test("groups versions and searches names and tags", () => {
  expect(versionGroupKey({ family: "plants", filename: "reed-sway-v3.png" })).toBe("plants/reed-sway.png");
  expect(versionGroupKey({ family: "plants", filename: "reed-sway.png" })).toBe("plants/reed-sway.png");
  expect(versionGroupKey({ family: "animals", filename: "reed-sway.png" })).not.toBe("plants/reed-sway.png");
  const duck = { filename: "duck-walk-spritemap.png", tags: ["animals", "transparent"] };
  expect(matchesSearch(duck, "Walk animals")).toBe(true);
  expect(matchesSearch(duck, "heron")).toBe(false);
  expect(matchesSearch(duck, "  ")).toBe(true);
});

test("recovers the typed brief from a saved generation prompt", () => {
  const saved = "Painterly isometric world.\n\nAsset-specific request:\nA reed clump\nswaying gently\nAsset name: reed-sway. Requested canvas: exactly 1024×1024 pixels. Generate against a perfectly flat white background.";
  expect(originalBrief(saved)).toBe("A reed clump\nswaying gently");
  expect(originalBrief("A duck\nAsset name: duck. Requested canvas: 1024")).toBe("A duck");
  expect(originalBrief("Just a brief")).toBe("Just a brief");
});
