import { expect, test } from "vitest";
import { retargetFrames, splitForTransfer } from "../animation-store.js";
import type { AnimationRecord } from "../types.js";

const animation = (id: string, assetIds: string[]): AnimationRecord => ({
  id, gameId: "pocket-river", name: id, loop: "loop", fps: 8, source: "sheet",
  frames: assetIds.map((assetId) => ({ assetId, sourcePath: `candidates/animals/${assetId}.png`, durationMs: 0 })),
});

test("points frames at an asset's new file after it moves", () => {
  const [walk, mixed] = retargetFrames([animation("walk", ["duck", "duck"]), animation("mixed", ["duck", "heron"])], "duck", "approved/animals/duck.png");
  expect(walk!.frames.map((frame) => frame.sourcePath)).toEqual(["approved/animals/duck.png", "approved/animals/duck.png"]);
  expect(mixed!.frames.map((frame) => frame.sourcePath)).toEqual(["approved/animals/duck.png", "candidates/animals/heron.png"]);
});

test("moves single-asset animations with their asset and reports mixed ones", () => {
  const records = [animation("walk", ["duck"]), animation("mixed", ["duck", "heron"]), animation("fly", ["heron"])];
  const { travelling, staying, broken } = splitForTransfer(records, "duck");
  expect(travelling.map((record) => record.id)).toEqual(["walk"]);
  expect(staying.map((record) => record.id)).toEqual(["mixed", "fly"]);
  expect(broken.map((record) => record.id)).toEqual(["mixed"]);
});
