import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import {
  buildGenerationPrompt,
  buildGrokInstruction,
  JobStore,
  stageJobReferences,
  type Job,
} from "../jobs.js";
import type { AssetStore } from "../asset-store.js";

test("cancels a queued job before it reaches the image generator", async () => {
  const rootDir = await mkdtemp(join(tmpdir(), "asset-studio-jobs-"));
  const store = new JobStore(rootDir, {} as AssetStore);

  try {
    const [job] = await store.submit([
      {
        gameId: "pocket-river",
        family: "plants",
        name: "reed",
        prompt: "A reed sprite.",
        transparent: true,
      },
    ]);
    expect(job).toBeDefined();
    if (!job) throw new Error("Expected a submitted job.");
    const cancelled = await (
      store as JobStore & { cancel(jobId: string): Promise<Job> }
    ).cancel(job.id);

    expect(cancelled.state).toBe("cancelled");
    expect(cancelled.error).toBe("Cancelled by user.");
    expect((await store.list()).find((item) => item.id === job.id)?.state).toBe(
      "cancelled",
    );
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("includes requested dimensions in the generation instruction", () => {
  expect(
    buildGenerationPrompt({
      prompt: "A reed sprite.",
      name: "reed",
      width: 768,
      height: 1024,
      matteBackground: "white",
    }),
  ).toContain("Requested canvas: exactly 768×1024 pixels");
});

test("instructs Grok to retain reference-aware image generation", () => {
  expect(buildGrokInstruction("Reference image files: /tmp/duck.png")).toContain(
    "use image editing or reference-aware generation",
  );
});

test("stages a job reference beside its generated output", async () => {
  const rootDir = await mkdtemp(join(tmpdir(), "asset-studio-reference-"));
  const source = join(
    rootDir,
    "games/pocket-river/assets/candidates/animals/duck.png",
  );
  await mkdir(join(source, ".."), { recursive: true });
  await writeFile(source, "reference-image");

  try {
    const [staged] = await stageJobReferences(
      rootDir,
      "pocket-river",
      ["candidates/animals/duck.png"],
      join(rootDir, "data/jobs/example"),
    );
    expect(staged).toBeDefined();
    if (!staged) throw new Error("Expected a staged reference.");
    expect(staged).toContain("references/0-duck.png");
    expect(await readFile(staged, "utf8")).toBe("reference-image");
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("removes a queued job from the local job history", async () => {
  const rootDir = await mkdtemp(join(tmpdir(), "asset-studio-job-remove-"));
  const store = new JobStore(rootDir, {} as AssetStore);
  try {
    const [job] = await store.submit([
      {
        gameId: "pocket-river",
        family: "plants",
        name: "reed",
        prompt: "A reed sprite.",
        transparent: true,
      },
    ]);
    expect(job).toBeDefined();
    if (!job) throw new Error("Expected a submitted job.");
    await (store as JobStore & { remove(jobId: string): Promise<void> }).remove(
      job.id,
    );
    expect(await store.list()).toEqual([]);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("fails jobs stranded running by a restart, so they can be retried", async () => {
  const rootDir = await mkdtemp(join(tmpdir(), "asset-studio-job-stranded-"));
  const store = new JobStore(rootDir, {} as AssetStore);
  try {
    const [job] = await store.submit([
      { gameId: "pocket-river", family: "characters", name: "knight", prompt: "A knight.", transparent: true },
    ]);
    if (!job) throw new Error("Expected a submitted job.");
    // What the old process leaves behind: still "running", with nothing left to finish it.
    const stored = await store.list();
    const first = stored[0];
    if (!first) throw new Error("Expected stored job.");
    stored[0] = { ...first, state: "running", startedAt: new Date().toISOString() };
    await writeFile(join(rootDir, "data/jobs.json"), JSON.stringify(stored, null, 2));

    expect(await store.recoverInterrupted()).toEqual([job.id]);
    const recovered = (await store.list())[0];
    expect(recovered?.state).toBe("failed");
    expect(recovered?.error).toMatch(/restarted/);
    // Retry only accepts failed jobs — the whole point of the sweep.
    await expect(store.retry(job.id)).resolves.toMatchObject({ state: "queued" });
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("requeues a failed job without retaining its failure details", async () => {
  const rootDir = await mkdtemp(join(tmpdir(), "asset-studio-job-retry-"));
  const store = new JobStore(rootDir, {} as AssetStore);
  const dataPath = join(rootDir, "data/jobs.json");
  try {
    const [job] = await store.submit([
      {
        gameId: "pocket-river",
        family: "plants",
        name: "reed",
        prompt: "A reed sprite.",
        transparent: true,
      },
    ]);
    expect(job).toBeDefined();
    if (!job) throw new Error("Expected a submitted job.");
    const failed = await store.list();
    const first = failed[0];
    if (!first) throw new Error("Expected stored job.");
    failed[0] = { ...first, state: "failed", error: "Generator timed out." };
    await writeFile(dataPath, JSON.stringify(failed));

    const retried = await store.retry(job.id);

    expect(retried.state).toBe("queued");
    expect(retried.error).toBeUndefined();
    expect((await store.list())[0]?.state).toBe("queued");
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});
