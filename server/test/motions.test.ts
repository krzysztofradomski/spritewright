import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { DEFAULT_MOTIONS, readMotions, writeMotions } from "../motions.js";

test("motions fallback to defaults when unconfigured and persist updates", async () => {
  const rootDir = await mkdtemp(join(tmpdir(), "asset-studio-motions-"));
  try {
    const initial = await readMotions(rootDir);
    expect(initial).toEqual(DEFAULT_MOTIONS);
    expect(initial.walk).toBeDefined();

    const custom = { ...DEFAULT_MOTIONS, jump: "1 squatting low; 2 leaping up; 3 peak jump; 4 landing" };
    await writeMotions(rootDir, custom);

    const saved = await readMotions(rootDir);
    expect(saved.jump).toBe("1 squatting low; 2 leaping up; 3 peak jump; 4 landing");
    expect(saved.walk).toBe(DEFAULT_MOTIONS.walk);

    // Delete a motion
    const deleted = { ...saved };
    delete deleted.rotation;
    await writeMotions(rootDir, deleted);

    const afterDelete = await readMotions(rootDir);
    expect(afterDelete.rotation).toBeUndefined();
    expect(afterDelete.jump).toBeDefined();
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("project-specific motions override defaults for that project and fall back gracefully", async () => {
  const rootDir = await mkdtemp(join(tmpdir(), "asset-studio-project-motions-"));
  await mkdir(join(rootDir, "games", "pocket-river", "assets"), { recursive: true });
  await mkdir(join(rootDir, "games", "the-last-greenhouse", "assets"), { recursive: true });
  try {
    // Project falls back to defaults initially
    const initial = await readMotions(rootDir, "pocket-river");
    expect(initial).toEqual(DEFAULT_MOTIONS);

    // Save project-specific motion
    const projectMotions = { ...DEFAULT_MOTIONS, riverFlow: "1 gentle ripple; 2 surge; 3 settling" };
    await writeMotions(rootDir, projectMotions, "pocket-river");

    const readBack = await readMotions(rootDir, "pocket-river");
    expect(readBack.riverFlow).toBe("1 gentle ripple; 2 surge; 3 settling");

    // Other projects still get defaults
    const other = await readMotions(rootDir, "the-last-greenhouse");
    expect(other.riverFlow).toBeUndefined();
    expect(other.idle).toBeDefined();
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});
