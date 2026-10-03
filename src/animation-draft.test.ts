import { expect, test } from "vitest";
import { animationDraft, manifestName, motionPoses } from "./animation-draft.js";

test("creates a tagged sprite-sheet draft with appropriate animal motion", () => {
  expect(
    animationDraft({
      filename: "duck.png",
      family: "animals",
      relativePath: "candidates/animals/duck.png",
    }),
  ).toMatchObject({
    name: "duck-walk-spritemap",
    // 4x4 cells of 256: sixteen frames on the 1024 canvas every image model draws natively.
    width: 1024,
    height: 1024,
    tags: ["animation-spritemap"],
    references: ["candidates/animals/duck.png"],
  });
});

test("sizes every cell to the source, capped so the sheet stays one native canvas", () => {
  const small = animationDraft({ filename: "knight.png", family: "characters", relativePath: "a/knight.png", inspection: { width: 128, height: 128 } });
  expect(small).toMatchObject({ width: 4 * 128, height: 4 * 128 });
  const large = animationDraft({ filename: "knight.png", family: "characters", relativePath: "a/knight.png", inspection: { width: 1024, height: 1024 } });
  expect(large).toMatchObject({ width: 1024, height: 1024 });
  expect(large.prompt).toContain("16 frames arranged in a 4 columns × 4 rows grid");
});

test("names every frame, key poses on odd frames and in-betweens on even ones", () => {
  const poses = motionPoses("walk");
  expect(poses).toContain("left contact");
  expect(poses).toContain("Draw all 16 frames");
  expect(poses).toContain("frame 1 = key pose 1;");
  expect(poses).toContain("frame 2 = halfway between key pose 1 and key pose 2;");
  expect(poses).toContain("frame 15 = key pose 8;");
  expect(poses).toContain("frame 16 = halfway between key pose 8 and key pose 1.");
  // Flow has no key poses to interleave; it steps evenly instead.
  expect(motionPoses("flow")).not.toContain("key pose");
});

test("spells out a different pose per frame and picks the motion from the name first", () => {
  const pixie = animationDraft({ filename: "pixie.png", family: "plants", relativePath: "candidates/plants/pixie.png" });
  expect(pixie.name).toBe("pixie-fly-spritemap");
  expect(pixie.prompt).toContain("wings raised fully up");
  expect(pixie.prompt).not.toContain("{poses}");
  expect(animationDraft({ filename: "knight-fixed.png", family: "characters", relativePath: "a/knight-fixed.png" }, undefined, "idle").name).toBe("knight-fixed-idle-spritemap");
});

test("names a manifest from the first words of the brief, then the sheet", () => {
  expect(manifestName("Animate knight-claude-v1.png", "x")).toBe("animate-knight-claude-v1");
  expect(manifestName("A slow, sleepy idle loop for the owl", "x")).toBe("a-slow-sleepy-idle");
  expect(manifestName("  ", "owl-idle-spritemap.png")).toBe("owl-idle-spritemap");
  expect(manifestName(undefined, "!!!")).toBe("animation");
});
