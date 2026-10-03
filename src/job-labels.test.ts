import { expect, test } from "vitest";
import { jobBrief } from "./job-labels.js";

test("job cards show the brief, not the art direction in front of it", () => {
  expect(jobBrief({ brief: "A mossy stone", prompt: "Cozy isometric style.\n\nAsset-specific request:\nA mossy stone" })).toBe("A mossy stone");
  expect(jobBrief({ prompt: "Cozy isometric style.\n\nAsset-specific request:\nA reed bed\nswaying" })).toBe("A reed bed\nswaying");
  expect(jobBrief({ prompt: "A lantern" })).toBe("A lantern");
  const template = "Style.\n\nAsset-specific request:\nCreate a production-ready sway animation sprite map from this reference asset.";
  expect(jobBrief({ operation: "animate", references: ["candidates/plants/pixie.png"], prompt: template })).toBe("Animate pixie.png");
  expect(jobBrief({ operation: "animate", prompt: `${template}\n\nAdditional production notes:\nslower wings` })).toBe("slower wings");
  expect(jobBrief({ operation: "repair", references: ["candidates/plants/reed.png"], prompt: "Original request:\nreed\n\nRepair this existing game-asset candidate. Correct every validation issue below:\n- Opaque edges\n- No padding\nReturn a clean PNG." })).toBe("Fix reed.png: Opaque edges; No padding");
  expect(jobBrief({})).toBeUndefined();
});
