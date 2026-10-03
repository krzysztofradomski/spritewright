import { randomUUID } from "node:crypto";
import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import {
  copyFile,
  mkdir,
  readdir,
  readFile,
  rename,
  stat,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import sharp from "sharp";
import { AssetStore } from "./asset-store.js";
import { resolveAssetRelativePath } from "./paths.js";
import { runGemini } from "./gemini.js";
import { runOpenRouter } from "./openrouter.js";
import { antigravityImageQuota, planGenerator, type GeneratorPlan } from "./providers.js";
import { isPaidProvider, readDailyLimits, spendLimitProblem } from "./spend.js";
import { runCloudflareImage } from "./cloudflare.js";
import { readFrameSize, runComfyUI } from "./comfyui.js";
import { runOpenAIImage } from "./openai.js";
import { runSvgPixel, svgSidecarPath } from "./svg-pixel.js";
import { requestedGridLayout } from "./animation.js";
import { readImageModels } from "./image-models.js";
import type { AssetRecord, GameId } from "./types.js";

export type MatteBackground = "white" | "black";
export type JobOperation = "generate" | "repair" | "remix" | "animate";
/** Every generator a job can ask for; routes validate against this exact list. */
export const GENERATOR_PROVIDERS = ["delegate-antigravity", "grok", "openrouter", "codex", "gemini", "openai", "cloudflare", "svg-pixel", "comfyui"] as const;
export type GeneratorProvider = (typeof GENERATOR_PROVIDERS)[number];
/** A running job: a child process, or an HTTP request dressed as one so cancel works the same. */
type Stoppable = { kill(signal?: NodeJS.Signals): unknown; killed: boolean };
export type AssetBrief = {
  gameId: GameId;
  family: string;
  name: string;
  /** The full generation prompt, with the project's art direction in front. */
  prompt: string;
  /** What was asked for, as typed; job cards show this instead of the prompt. */
  brief?: string;
  transparent: boolean;
  tags?: string[];
  width?: number;
  height?: number;
  references?: string[];
  matteBackground?: MatteBackground;
  operation?: JobOperation;
  provider?: GeneratorProvider;
};
export type JobState =
  "queued" | "running" | "completed" | "failed" | "cancelled";
export type Job = AssetBrief & {
  id: string;
  state: JobState;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  output?: string;
  error?: string;
  assetId?: string;
  /** What this paid job cost in USD: OpenRouter's reported charge, or the provider's list price. */
  costUsd?: number;
  /** Set when the job ran on a different generator than requested, and why. */
  generatorNote?: string;
};

/** API image generators, all called the same way. */
const PAID_LABELS: Record<string, string> = { openrouter: "OpenRouter", gemini: "Google AI Studio", openai: "OpenAI", cloudflare: "Cloudflare" };
const PAID_RUNNERS = { openrouter: runOpenRouter, gemini: runGemini, openai: runOpenAIImage, cloudflare: runCloudflareImage };

export const JOB_TIMEOUT_MS = 5 * 60 * 1000;
const COMFYUI_TIMEOUT_MS = 30 * 60 * 1000;
export const DEFAULT_ASSET_SIZE = 1_024;

export class JobStore {
  private readonly dataPath: string;
  private mutation = Promise.resolve();
  private queue: string[] = [];
  private processing = false;
  private readonly activeProcesses = new Map<string, Stoppable>();
  private readonly cancelledJobs = new Set<string>();
  private readonly removedJobs = new Set<string>();

  constructor(
    private readonly rootDir: string,
    private readonly assets: AssetStore,
  ) {
    this.dataPath = join(rootDir, "data/jobs.json");
  }

  private async write(jobs: Job[]) {
    await mkdir(dirname(this.dataPath), { recursive: true });
    const temp = `${this.dataPath}.tmp`;
    await writeFile(temp, JSON.stringify(jobs, null, 2));
    await rename(temp, this.dataPath);
  }
  private async mutate<T>(action: (jobs: Job[]) => Promise<T> | T): Promise<T> {
    const next = this.mutation.then(async () => action(await this.list()));
    this.mutation = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }
  async list() {
    try {
      return JSON.parse(await readFile(this.dataPath, "utf8")) as Job[];
    } catch {
      return [];
    }
  }
  async submit(briefs: AssetBrief[]) {
    const limits = await readDailyLimits(this.rootDir);
    return this.mutate(async (jobs) => {
      // Checked inside the lock so two submissions can't both squeeze under the limit.
      const problem = spendLimitProblem(jobs, briefs.map((brief) => brief.provider), limits, new Date(), PAID_LABELS);
      if (problem) throw new Error(problem);
      const now = new Date().toISOString();
      const newJobs = briefs.map((brief) => ({
        ...brief,
        id: randomUUID(),
        state: "queued" as const,
        createdAt: now,
        updatedAt: now,
      }));
      await this.write([...jobs, ...newJobs]);
      return newJobs;
    });
  }

  /**
   * A job still marked running when the server starts was interrupted by the last shutdown: its
   * child process died with the old process and nothing is left to finish it or time it out, so
   * it would sit at "running" forever — and Retry only accepts failed jobs. Fail it so it can be.
   */
  async recoverInterrupted() {
    return this.mutate(async (jobs) => {
      const stranded = jobs.filter((job) => job.state === "running");
      for (const job of stranded) {
        job.state = "failed";
        job.error = "Interrupted: the server restarted while this job was running. Retry it.";
        job.updatedAt = new Date().toISOString();
      }
      if (stranded.length) await this.write(jobs);
      return stranded.map((job) => job.id);
    });
  }

  enqueue(jobIds: string[]) {
    for (const jobId of jobIds)
      if (!this.queue.includes(jobId)) this.queue.push(jobId);
    void this.processQueue();
  }
  private async processQueue() {
    if (this.processing) return;
    this.processing = true;
    try {
      while (this.queue.length) {
        const jobId = this.queue.shift();
        if (jobId) await this.run(jobId);
      }
    } finally {
      this.processing = false;
    }
  }

  async cancel(jobId: string) {
    const cancelled = await this.mutate(async (jobs) => {
      const job = jobs.find((item) => item.id === jobId);
      if (!job) throw new Error("Job not found.");
      if (job.state !== "queued" && job.state !== "running")
        throw new Error(
          `Only queued or running jobs can be cancelled (this job is ${job.state}).`,
        );
      job.state = "cancelled";
      job.error = "Cancelled by user.";
      job.updatedAt = new Date().toISOString();
      await this.write(jobs);
      return { ...job };
    });
    this.cancelledJobs.add(jobId);
    const process = this.activeProcesses.get(jobId);
    if (process) {
      process.kill("SIGTERM");
      setTimeout(() => {
        if (!process.killed) process.kill("SIGKILL");
      }, 1_500).unref();
    }
    return cancelled;
  }

  async retry(jobId: string) {
    const limits = await readDailyLimits(this.rootDir);
    return this.mutate(async (jobs) => {
      const job = jobs.find((item) => item.id === jobId);
      if (!job) throw new Error("Job not found.");
      if (job.state !== "failed")
        throw new Error(`Only failed jobs can be retried (this job is ${job.state}).`);
      const problem = spendLimitProblem(jobs, [job.provider], limits, new Date(), PAID_LABELS);
      if (problem) throw new Error(problem);
      job.state = "queued";
      delete job.error;
      delete job.output;
      delete job.assetId;
      delete job.startedAt;
      delete job.generatorNote;
      job.updatedAt = new Date().toISOString();
      await this.write(jobs);
      return { ...job };
    });
  }

  async remove(jobId: string) {
    let removed: Job | undefined;
    try {
      await this.mutate(async (jobs) => {
        const index = jobs.findIndex((item) => item.id === jobId);
        if (index < 0) throw new Error("Job not found.");
        const [job] = jobs.splice(index, 1);
        removed = job;
        this.removedJobs.add(jobId);
        this.cancelledJobs.add(jobId);
        await this.write(jobs);
      });
    } catch (error) {
      this.removedJobs.delete(jobId);
      this.cancelledJobs.delete(jobId);
      throw error;
    }
    this.queue = this.queue.filter((id) => id !== jobId);
    const process = this.activeProcesses.get(jobId);
    if (process) {
      process.kill("SIGTERM");
      setTimeout(() => {
        if (!process.killed) process.kill("SIGKILL");
      }, 1_500).unref();
    }
    return removed;
  }

  /**
   * The SVG source of the asset a pixel job is working from. A text model can't look at a PNG, so
   * without this a "repair" or "animate" job has no subject and draws whatever the art direction
   * describes instead. Refusing is better than silently making something unrelated.
   */
  private async referenceSvg(job: Job): Promise<{ sourceSvg?: string }> {
    const reference = job.references?.[0];
    if (!reference) return {};
    const source = svgSidecarPath(resolveAssetRelativePath(this.rootDir, job.gameId, reference));
    const svg = await readFile(source, "utf8").catch(() => null);
    if (!svg)
      throw new Error(
        `Pixel art can't work from ${basename(reference)}: a text model can't see an image, and that asset has no SVG source saved beside it. Only assets this generator drew can be repaired, remixed or animated here.`,
      );
    return { sourceSvg: svg };
  }

  async run(jobId: string) {
    const claim = await this.mutate(async (jobs) => {
      const candidate = jobs.find((item) => item.id === jobId);
      if (!candidate) throw new Error("Job not found.");
      if (candidate.state !== "queued")
        return { job: { ...candidate }, claimed: false };
      candidate.state = "running";
      candidate.startedAt = new Date().toISOString();
      candidate.updatedAt = candidate.startedAt;
      await this.write(jobs);
      return { job: { ...candidate }, claimed: true };
    });
    const job = claim.job;
    if (
      !claim.claimed ||
      this.cancelledJobs.has(jobId) ||
      this.removedJobs.has(jobId)
    )
      return job;
    // Check quota before spending minutes on a generator that is known to be out.
    const plan: GeneratorPlan = await planGenerator(this.rootDir, job.provider ?? "delegate-antigravity").catch(
      () => ({ provider: job.provider ?? "delegate-antigravity" }),
    );
    if ("error" in plan) {
      job.state = "failed";
      job.error = plan.error;
      return this.mutate(async (jobs) => {
        const current = jobs.find((candidate) => candidate.id === jobId);
        if (current) Object.assign(current, job, { updatedAt: new Date().toISOString() });
        await this.write(jobs);
        return job;
      });
    }
    if (plan.provider !== job.provider) {
      job.provider = plan.provider as GeneratorProvider;
      if (plan.note) job.generatorNote = plan.note;
    }
    const output = join(
      this.rootDir,
      "data",
      "jobs",
      `${job.id}.png`,
    );
    await mkdir(dirname(output), { recursive: true });
    const stagedReferences = job.references?.length
      ? await stageJobReferences(
          this.rootDir,
          job.gameId,
          job.references,
          dirname(output),
        )
      : undefined;
    // SVG comes out transparent already, so it skips the matte: no matte colour to pick, and none
    // of the flat-background wording that buildGenerationPrompt adds for raster generators.
    const svgPixel = job.provider === "svg-pixel";
    // The reference shows the subject's real colours, which beats guessing from words in the prompt.
    const matte = svgPixel
      ? "white"
      : job.matteBackground ?? (stagedReferences?.[0] ? await referenceMatte(stagedReferences[0]) : null) ?? selectMatteBackground(job.brief ?? job.prompt);
    const prompt = svgPixel
      ? job.prompt
      : buildGenerationPrompt({
          ...job,
          matteBackground: matte,
          ...(stagedReferences ? { references: stagedReferences } : {}),
        });
    let model: string | undefined;
    let drawnSvg: string | undefined;
    try {
      const onStart = (process: ChildProcess) =>
        this.activeProcesses.set(jobId, process);
      if (svgPixel) {
        // ponytail: a text call can't be killed mid-flight, so cancelling only discards the result;
        // give runText an AbortSignal if a stuck pixel job ever needs to stop early.
        const width = job.width ?? DEFAULT_ASSET_SIZE;
        const height = job.height ?? DEFAULT_ASSET_SIZE;
        const layout = job.tags?.includes("animation-spritemap") ? requestedGridLayout(prompt, width, height) : null;
        // One call draws the whole sheet: at 256px frames it is a single ordinary-sized canvas.
        const result = await runSvgPixel(this.rootDir, {
          subject: job.brief ?? prompt,
          width,
          height,
          layout,
          ...(await this.referenceSvg(job)),
        }, output);
        model = result.model;
        drawnSvg = result.svg;
      } else if (job.provider === "comfyui") {
        if (!stagedReferences?.[0]) throw new Error("ComfyUI redraws an existing image, so this job needs a reference: use the button on a sprite map.");
        const controller = new AbortController();
        const request: Stoppable = { killed: false, kill: () => { request.killed = true; controller.abort(); } };
        this.activeProcesses.set(jobId, request);
        // Every frame is its own run, so this is far longer than the single-call generators' timeout.
        const timeout = setTimeout(() => controller.abort(), COMFYUI_TIMEOUT_MS);
        try {
          const sheet = Boolean(job.tags?.includes("animation-spritemap"));
          await runComfyUI(
            { reference: stagedReferences[0], sheet, layout: sheet ? requestedGridLayout(prompt, job.width ?? DEFAULT_ASSET_SIZE, job.height ?? DEFAULT_ASSET_SIZE) : null, matte, size: await readFrameSize(this.rootDir) },
            output,
            controller.signal,
          );
        } finally {
          clearTimeout(timeout);
        }
      } else if (job.provider === "grok") await runGrok(prompt, output, this.rootDir, onStart);
      else if (isPaidProvider(job.provider)) {
        const controller = new AbortController();
        const request: Stoppable = { killed: false, kill: () => { request.killed = true; controller.abort(); } };
        this.activeProcesses.set(jobId, request);
        const timeout = setTimeout(() => controller.abort(), JOB_TIMEOUT_MS);
        try {
          const paid = job.provider as keyof typeof PAID_RUNNERS;
          model = (await readImageModels(this.rootDir))[paid];
          const { costUsd } = await PAID_RUNNERS[paid](prompt, output, stagedReferences ?? [], controller.signal, model, {
            width: job.width ?? DEFAULT_ASSET_SIZE,
            height: job.height ?? DEFAULT_ASSET_SIZE,
          });
          if (costUsd !== undefined) job.costUsd = costUsd;
        } catch (error) {
          // A call that returned no image may still have been billed; keep what it cost.
          const costUsd = (error as { costUsd?: number }).costUsd;
          if (costUsd !== undefined) job.costUsd = costUsd;
          throw error;
        } finally {
          clearTimeout(timeout);
        }
      } else if (job.provider === "codex") await runCodex(prompt, output, onStart);
      else
        await runDelegate(prompt, output, onStart).catch(async (error: unknown) => {
          // delegate.sh hides agy's output; recover the usual real cause so the job says it.
          const quota = await antigravityImageQuota();
          if (!quota) throw error;
          throw new Error(`Antigravity image quota exhausted (${quota.model}); resets ${new Date(quota.resetsAt).toLocaleString()}. Pick another generator or wait. ${error instanceof Error ? error.message : String(error)}`);
        });
      if (!svgPixel) {
        await removeSolidMatte(output, matte);
        // The sheet is already an exact grid of pixel-art cells; resizing it would blur them.
        if (job.provider !== "comfyui") await normalizeGeneratedImage(output, job.width, job.height);
      }
      if (this.cancelledJobs.has(jobId) || this.removedJobs.has(jobId))
        return (
          (await this.list()).find((candidate) => candidate.id === jobId) ?? job
        );
      const provenance: AssetRecord["provenance"] = {
        provider: svgPixel ? "svg-pixel" : job.provider === "grok" ? "grok-build" : job.provider === "codex" || job.provider === "comfyui" || isPaidProvider(job.provider) ? job.provider! : "delegate-antigravity",
        prompt,
      };
      if (model) provenance.model = model;
      if (job.references) provenance.referencePaths = job.references;
      const asset = await this.assets.importAsset({
        gameId: job.gameId,
        family: job.family,
        sourcePath: output,
        filename: `${job.name}.png`,
        ...(job.tags ? { tags: job.tags } : {}),
        provenance,
      });
      // Keep the drawing beside the PNG so it can be rescaled, recoloured, or redrawn from later.
      if (drawnSvg) await writeFile(svgSidecarPath(resolveAssetRelativePath(this.rootDir, job.gameId, asset.relativePath)), drawnSvg);
      job.state = "completed";
      job.output = output;
      job.assetId = asset.id;
    } catch (error) {
      if (this.removedJobs.has(jobId)) {
        return job;
      }
      if (this.cancelledJobs.has(jobId)) {
        job.state = "cancelled";
        job.error = "Cancelled by user.";
      } else {
        job.state = "failed";
        job.error = error instanceof Error ? error.message : String(error);
      }
    } finally {
      this.activeProcesses.delete(jobId);
    }
    if (this.removedJobs.has(jobId)) return job;
    return this.mutate(async (jobs) => {
      const current = jobs.find((candidate) => candidate.id === jobId);
      if (!current || this.removedJobs.has(jobId)) return job;
      Object.assign(current, job, { updatedAt: new Date().toISOString() });
      await this.write(jobs);
      return current;
    });
  }
}

export function selectMatteBackground(prompt: string): MatteBackground {
  const paleSubjectTerms =
    /\b(white|ivory|cream|pale|light[- ]colored|snow|frost|glass|crystal|translucent|transparent|dew|mist|cloud|moon|star|luminous)\b/i;
  return paleSubjectTerms.test(prompt) ? "black" : "white";
}

/**
 * The matte the reference subject has fewer pixels near, or null when it can't be read. A knight in
 * dark steel is half near-black, so a black matte would eat into it; a pale fairy is the reverse.
 */
export async function referenceMatte(path: string): Promise<MatteBackground | null> {
  const image = await sharp(path).ensureAlpha().resize(256, 256, { fit: "inside" }).raw().toBuffer({ resolveWithObject: true }).catch(() => null);
  if (!image) return null;
  let nearWhite = 0;
  let nearBlack = 0;
  const { data } = image;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3]! < 128) continue;
    if (Math.min(data[i]!, data[i + 1]!, data[i + 2]!) >= 175) nearWhite++;
    if (Math.max(data[i]!, data[i + 1]!, data[i + 2]!) <= 80) nearBlack++;
  }
  return nearWhite + nearBlack === 0 ? null : nearBlack > nearWhite ? "white" : "black";
}

export function buildGenerationPrompt(
  input: Pick<
    AssetBrief,
    "prompt" | "name" | "references" | "matteBackground" | "width" | "height" | "tags"
  >,
) {
  const matte = input.matteBackground ?? selectMatteBackground(input.prompt);
  const width = input.width ?? DEFAULT_ASSET_SIZE;
  const height = input.height ?? DEFAULT_ASSET_SIZE;
  const referenceInstruction = input.references?.length
    ? `\nReference image files (use as inspiration or edit targets while preserving requested invariants):\n${input.references.map((path) => `- ${path}`).join("\n")}`
    : "";
  const sheet = input.tags?.includes("animation-spritemap")
    ? " The whole canvas, including every gap between frames, is that one colour: no panels, cards, tiles or differently coloured cells."
    : "";
  return `${input.prompt}\nAsset name: ${input.name}. Requested canvas: exactly ${width}×${height} pixels. Background (this overrides any other background, matte or transparency mentioned above): a perfectly flat, solid ${matte} (#${matte === "white" ? "FFFFFF" : "000000"}) for post-processing extraction.${sheet} Do not add shadows, gradients, glow, floor, labels, checkerboard, or unrelated scenery.${referenceInstruction}`;
}

export function buildGrokInstruction(prompt: string) {
  return `Generate exactly one image asset using Grok's image generation. ${prompt}\nIf reference image files are listed, use image editing or reference-aware generation to preserve the requested invariants. Save the resulting image through Grok's normal image tool, then respond only with the saved image path.`;
}

export async function stageJobReferences(
  rootDir: string,
  gameId: GameId,
  references: string[],
  workspaceDir: string,
) {
  const referencesDir = join(workspaceDir, "references");
  await mkdir(referencesDir, { recursive: true });
  return Promise.all(
    references.map(async (reference, index) => {
      const source = resolveAssetRelativePath(rootDir, gameId, reference);
      const staged = join(referencesDir, `${index}-${basename(source)}`);
      await copyFile(source, staged);
      return staged;
    }),
  );
}

async function normalizeGeneratedImage(
  output: string,
  width = DEFAULT_ASSET_SIZE,
  height = DEFAULT_ASSET_SIZE,
) {
  const temporary = `${output}.normalized`;
  await sharp(output)
    .resize(width, height, {
      fit: "contain",
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    .png()
    .toFile(temporary);
  await rename(temporary, output);
}

/** Edge-connected matte: generous, since anything reachable from the border is background. */
const MATTE_TOLERANCE = 36;
/** Enclosed pockets must be near-exact matte; painted whites are shaded and fall outside this. */
const POCKET_TOLERANCE = 10;
/** Smaller near-matte islands are treated as highlights, not background. */
const MIN_POCKET_PIXELS = 16;
/** Width of the anti-aliased band re-alpha'd along every cut edge. */
const EDGE_BAND = 2;

export async function removeSolidMatte(
  imagePath: string,
  matte: MatteBackground,
) {
  const { data, info } = await sharp(imagePath)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const { width, height, channels } = info;
  const pixelCount = width * height;
  const target = matte === "white" ? 255 : 0;
  const distanceToMatte = (index: number) => {
    const offset = index * channels;
    return Math.max(
      Math.abs(data[offset]! - target),
      Math.abs(data[offset + 1]! - target),
      Math.abs(data[offset + 2]! - target),
    );
  };
  const cleared = new Uint8Array(pixelCount);
  const queue = new Int32Array(pixelCount);
  const neighbours = (index: number, visit: (next: number) => void) => {
    const x = index % width;
    if (x > 0) visit(index - 1);
    if (x < width - 1) visit(index + 1);
    if (index >= width) visit(index - width);
    if (index < pixelCount - width) visit(index + width);
  };

  // 1. Flood the background in from the border.
  let head = 0;
  let tail = 0;
  const enqueue = (index: number) => {
    if (!cleared[index] && distanceToMatte(index) <= MATTE_TOLERANCE) {
      cleared[index] = 1;
      queue[tail++] = index;
    }
  };
  for (let x = 0; x < width; x += 1) {
    enqueue(x);
    enqueue((height - 1) * width + x);
  }
  for (let y = 1; y < height - 1; y += 1) {
    enqueue(y * width);
    enqueue(y * width + width - 1);
  }
  while (head < tail) neighbours(queue[head++]!, enqueue);

  // 2. Matte trapped inside the subject (gaps between blades, under an arm) that the flood can't
  //    reach. Only large, near-exact islands go, so shaded whites and highlights stay painted.
  // ponytail: a large flat pure-white painted area would also be cleared; the generation prompt
  //    asks for a flat matte precisely so subject whites are never exactly #FFFFFF.
  const seen = new Uint8Array(pixelCount);
  for (let start = 0; start < pixelCount; start += 1) {
    if (cleared[start] || seen[start] || distanceToMatte(start) > POCKET_TOLERANCE) continue;
    head = 0;
    tail = 0;
    seen[start] = 1;
    queue[tail++] = start;
    while (head < tail)
      neighbours(queue[head++]!, (next) => {
        if (!cleared[next] && !seen[next] && distanceToMatte(next) <= POCKET_TOLERANCE) {
          seen[next] = 1;
          queue[tail++] = next;
        }
      });
    if (tail >= MIN_POCKET_PIXELS) for (let item = 0; item < tail; item += 1) cleared[queue[item]!] = 1;
  }

  // 3. Distance (in 4-steps) from the nearest cleared pixel, up to the edge band.
  const distance = new Uint8Array(pixelCount).fill(255);
  head = 0;
  tail = 0;
  for (let index = 0; index < pixelCount; index += 1)
    if (cleared[index]) {
      distance[index] = 0;
      queue[tail++] = index;
    }
  while (head < tail) {
    const index = queue[head++]!;
    if (distance[index]! >= EDGE_BAND) continue;
    neighbours(index, (next) => {
      if (distance[next] === 255) {
        distance[next] = distance[index]! + 1;
        queue[tail++] = next;
      }
    });
  }

  // 4. Edge pixels are part subject, part matte. Estimate how much subject each holds by comparing
  //    it with the solid subject colour just inside the edge, then remove the matte from its colour.
  const edited = Buffer.from(data);
  for (let index = 0; index < pixelCount; index += 1) {
    if (cleared[index]) {
      edited[index * channels + 3] = 0;
      continue;
    }
    if (distance[index]! > EDGE_BAND) continue;
    const x = index % width;
    const y = Math.floor(index / width);
    const sum = [0, 0, 0];
    let samples = 0;
    for (let dy = -3; dy <= 3; dy += 1)
      for (let dx = -3; dx <= 3; dx += 1) {
        const sx = x + dx;
        const sy = y + dy;
        if (sx < 0 || sy < 0 || sx >= width || sy >= height) continue;
        const sample = sy * width + sx;
        if (distance[sample]! <= EDGE_BAND || distanceToMatte(sample) <= MATTE_TOLERANCE) continue;
        for (let channel = 0; channel < 3; channel += 1) sum[channel]! += data[sample * channels + channel]!;
        samples += 1;
      }
    if (!samples) continue;
    const subject = sum.map((total) => total / samples);
    // Measure along the channel where subject and matte differ most; if they barely differ (white
    // fur on a white matte) the estimate is unreliable, so leave the pixel alone.
    const channel = [0, 1, 2].reduce((best, candidate) =>
      Math.abs(subject[candidate]! - target) > Math.abs(subject[best]! - target) ? candidate : best, 0);
    const span = Math.abs(subject[channel]! - target);
    if (span < 48) continue;
    const coverage = Math.min(1, Math.abs(data[index * channels + channel]! - target) / span);
    if (coverage >= 0.96) continue;
    const offset = index * channels;
    edited[offset + 3] = Math.round(Math.min(data[offset + 3]!, coverage * 255));
    if (coverage > 0.02)
      for (let c = 0; c < 3; c += 1)
        edited[offset + c] = Math.max(0, Math.min(255, Math.round((data[offset + c]! - (1 - coverage) * target) / coverage)));
  }

  const temporary = `${imagePath}.matte-removed`;
  await sharp(edited, {
    raw: { width, height, channels },
  })
    .png()
    .toFile(temporary);
  await rename(temporary, imagePath);
}

/** Codex's built-in imagegen tool, the same call delegate.sh makes as its fallback. */
async function runCodex(prompt: string, output: string, onStart: (process: ChildProcess) => void) {
  const fallback = join(homedir(), ".codex/plugins/.plugin-appserver/codex");
  const binary = await stat(fallback).then(() => fallback, () => "codex");
  const startedAt = Date.now();
  await runDelegate(prompt, output, onStart, binary, [
    "exec", "--sandbox", "workspace-write", "-C", dirname(output), "--skip-git-repo-check",
    `/imagegen Generate: ${prompt}. Save the final image to ${output}`,
  ], "Codex");
  const written = await stat(output).catch(() => null);
  if (!written || written.mtimeMs < startedAt - 1_000) throw new Error("Codex finished without saving an image.");
}

function runDelegate(
  prompt: string,
  output: string,
  onStart: (process: ChildProcess) => void,
  command = "delegate.sh",
  args = ["image", prompt, output],
  label = "Delegate",
) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
    });
    onStart(child);
    let log = "";
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, JOB_TIMEOUT_MS);
    child.stdout.on("data", (chunk) => {
      log += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      log += String(chunk);
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      if (code === 0) {
        resolve();
      } else {
        reject(
          new Error(
            timedOut
              ? `Image generation timed out after ${Math.round(JOB_TIMEOUT_MS / 60_000)} minutes.`
              : `${label} image generation failed (${code}): ${log.slice(-2000)}`,
          ),
        );
      }
    });
  });
}

async function findLatestGrokImage(rootDir: string, startedAt: number) {
  const sessionRoot = join(homedir(), ".grok", "sessions", encodeURIComponent(rootDir));
  const sessionNames = await readdir(sessionRoot, { withFileTypes: true });
  const candidates = await Promise.all(
    sessionNames
      .filter((entry) => entry.isDirectory())
      .map(async (session) => {
        const imagesDir = join(sessionRoot, session.name, "images");
        try {
          return (await readdir(imagesDir))
            .filter((filename) => /\.(jpe?g|png|webp)$/i.test(filename))
            .map((filename) => join(imagesDir, filename));
        } catch {
          return [] as string[];
        }
      }),
  );
  const images = candidates.flat();
  const dated = await Promise.all(
    images.map(async (path) => ({ path, modifiedAt: (await stat(path)).mtimeMs })),
  );
  const latest = dated
    .filter((image) => image.modifiedAt >= startedAt - 1_000)
    .sort((first, second) => second.modifiedAt - first.modifiedAt)[0];
  if (!latest)
    throw new Error("Grok completed without saving a discoverable image file.");
  return latest.path;
}

function runGrok(
  prompt: string,
  output: string,
  rootDir: string,
  onStart: (process: ChildProcess) => void,
) {
  return new Promise<void>((resolve, reject) => {
    const startedAt = Date.now();
    const child = spawn(
      "grok",
      [
        "--always-approve",
        "--output-format",
        "json",
        "--cwd",
        rootDir,
        "--single",
        buildGrokInstruction(prompt),
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    onStart(child);
    let log = "";
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, JOB_TIMEOUT_MS);
    child.stdout.on("data", (chunk) => {
      log += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      log += String(chunk);
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      if (code !== 0) {
        reject(
          new Error(
            timedOut
              ? `Grok image generation timed out after ${Math.round(JOB_TIMEOUT_MS / 60_000)} minutes.`
              : `Grok image generation failed (${code}): ${log.slice(-2000)}`,
          ),
        );
        return;
      }
      void findLatestGrokImage(rootDir, startedAt)
        .then((source) => copyFile(source, output))
        .then(() => resolve())
        .catch(reject);
    });
  });
}
