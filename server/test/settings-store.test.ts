import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { SettingsStore } from "../settings-store.js";

test("saving the art direction keeps saved briefs, and saving briefs keeps the art direction", async () => {
  const rootDir = await mkdtemp(join(tmpdir(), "asset-studio-settings-"));
  await mkdir(join(rootDir, "games", "pocket-river", "assets"), { recursive: true });
  try {
    const store = new SettingsStore(rootDir);
    await store.set("pocket-river", { briefs: { animation: "custom {motion}" } });
    await store.set("pocket-river", { globalPrompt: "painterly river" });
    expect(await store.get("pocket-river")).toEqual({ globalPrompt: "painterly river", briefs: { animation: "custom {motion}" } });
    await store.set("pocket-river", { briefs: {} });
    expect((await store.get("pocket-river")).globalPrompt).toBe("painterly river");
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});
