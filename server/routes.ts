import { createReadStream } from "node:fs";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { AssetStore } from "./asset-store.js";
import { GENERATOR_PROVIDERS, JobStore } from "./jobs.js";
import { createGame, deleteTrashedGame, listGames, listTrashedGames, resolveAssetRelativePath, resolveGameAssetsDir, restoreGame, trashGame } from "./paths.js";
import { exportAnimation } from "./sprite-export.js";
import { detectFrameAnchors, detectSpriteGrid, renderSpriteFrame, requestedGridLayout } from "./animation.js";
import { ASSET_STATES } from "./types.js";
import { AnimationStore, retargetFrames, splitForTransfer } from "./animation-store.js";
import { SettingsStore } from "./settings-store.js";
import { checkProvider, checkProviders, PROVIDER_IDS, probeProvider, runSetupStep } from "./providers.js";
import { KEY_PROVIDERS, readKey, removeKey, saveKey, type KeyProvider } from "./api-keys.js";
import { listCloudflareModels, parseCloudflareKey } from "./cloudflare.js";
import { listOpenAIModels } from "./openai.js";
import { updateAppSettings } from "./app-settings.js";
import { DEFAULT_FRAME_SIZE, FRAME_SIZES, readFrameSize } from "./comfyui.js";
import { DEFAULT_PIXEL_STYLE, pixelize } from "./pixelize.js";
import { IMAGE_MODEL_DEFAULTS, IMAGE_MODEL_PROVIDERS, listImageModels, readImageModels, writeImageModel } from "./image-models.js";
import { readMotions, resetMotions, writeMotions } from "./motions.js";
import { listTextModels, readTextModel, runText, TEXT_MODEL_ROLES, TEXT_PROVIDER_IDS, TEXT_PROVIDERS, writeTextModel } from "./text.js";

import { checkGeminiKey } from "./gemini.js";
import { openRouterCredits } from "./openrouter.js";
import { PAID_IMAGE_COSTS, readDailyLimits, summarizeSpend, writeDailyLimit, type SpendSummary } from "./spend.js";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import sharp from "sharp";
import { extname, join } from "node:path";

const game = z.string().regex(/^[a-z0-9-]+$/);
const brief = z.object({
  gameId: game,
  family: z.string().regex(/^[a-z0-9-]+$/),
  name: z.string().regex(/^[a-z0-9-]+$/),
  prompt: z.string().min(3),
  /** What the user asked for, shown on the job card; prompt may carry a locked template in front. */
  brief: z.string().max(4_000).optional(),
  transparent: z.boolean().default(true),
  tags: z
    .array(z.string().regex(/^[a-z0-9-]+$/))
    .max(20)
    .optional(),
  width: z.number().int().min(256).max(2048).default(1024),
  height: z.number().int().min(256).max(2048).default(1024),
  references: z.array(z.string()).optional(),
  operation: z.enum(["generate", "repair", "remix", "animate"]).default("generate"),
  provider: z.enum(GENERATOR_PROVIDERS).default("delegate-antigravity"),
});
const MAX_GLOBAL_PROMPT_LENGTH = 1_400;
// Zod's own message for a failed regex is just "Invalid"; say which field it was.
const describeIssue = (error: z.ZodError) => {
  const issue = error.issues[0];
  return issue && (issue.path.length ? `${issue.path.join(".")}: ${issue.message}` : issue.message);
};
const MAX_ENHANCED_BRIEF_LENGTH = 1_000;

export async function registerRoutes(app: FastifyInstance, rootDir: string) {
  const assets = new AssetStore(rootDir);
  const jobs = new JobStore(rootDir, assets);
  const animations = new AnimationStore(rootDir);
  const settings = new SettingsStore(rootDir);
  // Nothing survives a restart mid-job, so clear the wreckage before serving.
  const stranded = await jobs.recoverInterrupted();
  if (stranded.length) app.log.warn(`Failed ${stranded.length} job(s) interrupted by the last restart.`);
  app.get("/api/games", async () =>
    listGames(rootDir).map(({ id, label }) => ({ id, label })),
  );
  app.post("/api/games", async (request, reply) => {
    const parsed = z.object({ name: z.string().min(1).max(60) }).safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: describeIssue(parsed.error) });
    try {
      const { id, label } = createGame(rootDir, parsed.data.name);
      return { id, label };
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });
  app.delete("/api/games/:id", async (request, reply) => {
    const id = (request.params as { id: string }).id;
    if ((await jobs.list()).some((job) => job.gameId === id && (job.state === "queued" || job.state === "running")))
      return reply.code(409).send({ error: "Wait for this project's running jobs to finish first." });
    try {
      const { label, trashedPath } = trashGame(rootDir, id);
      return { id, label, trashedPath };
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });
  app.post("/api/assets/:id/transfer", async (request, reply) => {
    const parsed = z.object({ gameId: game, targetGameId: game }).safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: describeIssue(parsed.error) });
    const assetId = (request.params as { id: string }).id;
    try {
      const moved = await assets.transferAsset(parsed.data.gameId, assetId, parsed.data.targetGameId);
      const { travelling, broken } = splitForTransfer(await animations.list(parsed.data.gameId), assetId);
      if (travelling.length) {
        const carried = retargetFrames(travelling, assetId, moved.relativePath).map((record) => ({ ...record, gameId: parsed.data.targetGameId }));
        await animations.update(parsed.data.targetGameId, (records) => [...records, ...carried]);
        await animations.update(parsed.data.gameId, (records) => records.filter((record) => !travelling.some((item) => item.id === record.id)));
      }
      return { ...moved, movedAnimations: travelling.map((record) => record.name), brokenAnimations: broken.map((record) => record.name) };
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });
  app.get("/api/trash", async (request, reply) => {
    const parsed = game.safeParse((request.query as { gameId?: string }).gameId);
    if (!parsed.success) return reply.code(400).send({ error: "A valid gameId is required." });
    return { assets: await assets.listTrash(parsed.data), projects: listTrashedGames(rootDir).map(({ name, label, trashedAt }) => ({ name, label, trashedAt })) };
  });
  app.get("/api/trash/file", async (request, reply) => {
    const parsed = z.object({ gameId: game, path: z.string().regex(/^\.trash\/[a-z0-9-]+\/[^/]+\.(png|webp|jpe?g)$/i) }).safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid trash file." });
    try {
      const path = resolveAssetRelativePath(rootDir, parsed.data.gameId, parsed.data.path);
      await stat(path);
      reply.type(extname(path) === ".webp" ? "image/webp" : extname(path) === ".png" ? "image/png" : "image/jpeg");
      return reply.send(createReadStream(path));
    } catch {
      return reply.code(404).send({ error: "Not in the trash." });
    }
  });
  app.post("/api/trash/assets/restore", async (request, reply) => {
    const parsed = z.object({ gameId: game, path: z.string().min(1).max(400) }).safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: describeIssue(parsed.error) });
    try {
      return await assets.restoreTrashed(parsed.data.gameId, parsed.data.path);
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });
  app.post("/api/trash/assets/delete", async (request, reply) => {
    const parsed = z.object({ gameId: game, paths: z.array(z.string().min(1).max(400)).min(1).max(500) }).safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: describeIssue(parsed.error) });
    try {
      return { deleted: await assets.deleteTrashed(parsed.data.gameId, parsed.data.paths) };
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });
  app.post("/api/trash/projects/delete", async (request, reply) => {
    const parsed = z.object({ names: z.array(z.string().min(1).max(200)).min(1).max(100) }).safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: describeIssue(parsed.error) });
    try {
      return { deleted: parsed.data.names.map((name) => deleteTrashedGame(rootDir, name).name) };
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });
  app.post("/api/trash/projects/restore", async (request, reply) => {
    const parsed = z.object({ name: z.string().min(1).max(200) }).safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: describeIssue(parsed.error) });
    try {
      const { id, label } = restoreGame(rootDir, parsed.data.name);
      return { id, label };
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });
  /** Marks which paid providers have a key, so the page only offers limits for ones that can run. */
  const withKeys = async (summary: SpendSummary) => ({
    providers: Object.fromEntries(await Promise.all(Object.entries(summary.providers).map(async ([id, spend]) =>
      [id, { ...spend, configured: Boolean(await readKey(id as KeyProvider)) }] as const))),
  });
  app.get("/api/spend", async () => withKeys(summarizeSpend(await jobs.list(), await readDailyLimits(rootDir))));
  app.put("/api/spend", async (request, reply) => {
    const parsed = z.object({ provider: z.enum(Object.keys(PAID_IMAGE_COSTS) as [string, ...string[]]), limitUsd: z.number().min(0).max(1000) }).safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: describeIssue(parsed.error) });
    return withKeys(summarizeSpend(await jobs.list(), await writeDailyLimit(rootDir, parsed.data.provider, parsed.data.limitUsd)));
  });
  // Prompt help and pixel art each keep their own saved model; the role says which one is meant.
  const roleOf = (input: unknown) => z.enum(TEXT_MODEL_ROLES).safeParse(input).data ?? "prompt";
  app.get("/api/text-model", async (request) => {
    const role = roleOf((request.query as { role?: string }).role);
    return { ...(await readTextModel(rootDir, role)), role, providers: TEXT_PROVIDERS };
  });
  app.put("/api/text-model", async (request, reply) => {
    const parsed = z.object({
      provider: z.enum(TEXT_PROVIDER_IDS),
      model: z.string().trim().max(200).regex(/^[\w@./:-]*$/, "A model id has no spaces."),
      role: z.enum(TEXT_MODEL_ROLES).optional(),
    }).safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: describeIssue(parsed.error) });
    if (!parsed.data.model && parsed.data.provider !== "codex") return reply.code(400).send({ error: "Pick a model." });
    const role = parsed.data.role ?? "prompt";
    return { ...(await writeTextModel(rootDir, { provider: parsed.data.provider, model: parsed.data.model }, role)), role, providers: TEXT_PROVIDERS };
  });
  app.get("/api/image-models", async () => ({ models: await readImageModels(rootDir), defaults: IMAGE_MODEL_DEFAULTS }));
  app.put("/api/image-models", async (request, reply) => {
    const parsed = z.object({ provider: z.enum(IMAGE_MODEL_PROVIDERS), model: z.string().max(200).regex(/^[\w@./:-]*$/) }).safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: describeIssue(parsed.error) });
    return { models: await writeImageModel(rootDir, parsed.data.provider, parsed.data.model), defaults: IMAGE_MODEL_DEFAULTS };
  });
  const comfyFrame = async () => ({ frameSize: await readFrameSize(rootDir), default: DEFAULT_FRAME_SIZE, sizes: FRAME_SIZES });
  app.get("/api/comfyui-settings", comfyFrame);
  app.put("/api/comfyui-settings", async (request, reply) => {
    const parsed = z.object({ frameSize: z.number().refine((size) => (FRAME_SIZES as readonly number[]).includes(size), "Pick one of the listed sizes.") }).safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: describeIssue(parsed.error) });
    await updateAppSettings(rootDir, { comfyuiFrameSize: parsed.data.frameSize });
    return comfyFrame();
  });
  app.get("/api/motions", async (request, reply) => {
    const query = request.query as { gameId?: string } | undefined;
    const parsedGameId = query?.gameId ? game.safeParse(query.gameId) : undefined;
    if (query?.gameId && !parsedGameId?.success) return reply.code(400).send({ error: "A valid gameId is required." });
    return readMotions(rootDir, parsedGameId?.data);
  });
  app.put("/api/motions", async (request, reply) => {
    const body = request.body as Record<string, unknown> | undefined;
    const isWrapped = body && typeof body === "object" && "motions" in body;
    const motionsPayload = isWrapped ? body.motions : body;
    const gameIdCandidate = (isWrapped && typeof body.gameId === "string" ? body.gameId : undefined) ?? (request.query as { gameId?: string } | undefined)?.gameId;
    const parsedGameId = gameIdCandidate ? game.safeParse(gameIdCandidate) : undefined;
    if (gameIdCandidate && !parsedGameId?.success) return reply.code(400).send({ error: "A valid gameId is required." });
    const parsed = z.record(z.string().regex(/^[a-z0-9-_]+$/i).max(64), z.string().min(1).max(4000)).safeParse(motionsPayload);
    if (!parsed.success) return reply.code(400).send({ error: describeIssue(parsed.error) });
    return writeMotions(rootDir, parsed.data, parsedGameId?.data);
  });
  app.post("/api/motions/reset", async (request, reply) => {
    const query = request.query as { gameId?: string } | undefined;
    const body = request.body as { gameId?: string } | undefined;
    const gameIdCandidate = query?.gameId ?? body?.gameId;
    const parsedGameId = gameIdCandidate ? game.safeParse(gameIdCandidate) : undefined;
    if (gameIdCandidate && !parsedGameId?.success) return reply.code(400).send({ error: "A valid gameId is required." });
    return resetMotions(rootDir, parsedGameId?.data);
  });

  app.get("/api/image-models/:provider", async (request, reply) => {
    const parsed = z.enum(IMAGE_MODEL_PROVIDERS).safeParse((request.params as { provider: string }).provider);
    if (!parsed.success) return reply.code(404).send({ error: "Unknown image provider." });
    try {
      return { models: await listImageModels(parsed.data) };
    } catch (error) {
      return { models: [], error: error instanceof Error ? error.message : String(error) };
    }
  });
  app.get("/api/text-models/:provider", async (request, reply) => {
    const parsed = z.enum(TEXT_PROVIDER_IDS).safeParse((request.params as { provider: string }).provider);
    if (!parsed.success) return reply.code(404).send({ error: "Unknown text provider." });
    try {
      return { models: await listTextModels(parsed.data) };
    } catch (error) {
      return { models: [], error: error instanceof Error ? error.message : String(error) };
    }
  });
  app.post("/api/text-model/test", async (request, reply) => {
    const choice = await readTextModel(rootDir, roleOf((request.query as { role?: string }).role));
    const startedAt = Date.now();
    try {
      const answer = await runText(choice, "Reply with just the word: ok");
      return { ...choice, reply: answer.slice(0, 200), ms: Date.now() - startedAt };
    } catch (error) {
      return reply.code(502).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });
  app.get("/api/providers", async () => checkProviders(rootDir));
  app.post("/api/providers/:id/probe", async (request, reply) => {
    const parsed = z.enum(["antigravity", "grok"]).safeParse((request.params as { id: string }).id);
    if (!parsed.success) return reply.code(400).send({ error: "Only Antigravity and Grok need a test request." });
    return probeProvider(rootDir, parsed.data);
  });
  app.get("/api/providers/:id", async (request, reply) => {
    const parsed = z.enum(PROVIDER_IDS as [string, ...string[]]).safeParse((request.params as { id: string }).id);
    if (!parsed.success) return reply.code(404).send({ error: "Unknown provider." });
    return checkProvider(rootDir, parsed.data as (typeof PROVIDER_IDS)[number]);
  });
  // Setup and key routes change this machine, so they only take JSON: a cross-site page can't send
  // that without a CORS preflight, which this server never answers.
  app.post("/api/providers/:id/setup/:step", async (request, reply) => {
    const { id, step } = request.params as { id: string; step: string };
    const parsed = z.enum(PROVIDER_IDS as [string, ...string[]]).safeParse(id);
    if (!parsed.success || !request.headers["content-type"]?.startsWith("application/json")) return reply.code(400).send({ error: "Bad request." });
    const result = await runSetupStep(step);
    if (!result) return reply.code(404).send({ error: "That step can't run from here; follow its instructions instead." });
    return { ...result, status: await checkProvider(rootDir, parsed.data as (typeof PROVIDER_IDS)[number]) };
  });
  app.put("/api/providers/:id/key", async (request, reply) => {
    const id = z.enum(KEY_PROVIDERS as [KeyProvider, ...KeyProvider[]]).safeParse((request.params as { id: string }).id);
    const body = z.object({ key: z.string().trim().min(10).max(500).regex(/^\S+$/, "A key has no spaces.") }).safeParse(request.body);
    if (!id.success) return reply.code(404).send({ error: "This provider doesn't use an API key." });
    if (!body.success) return reply.code(400).send({ error: describeIssue(body.error) });
    // Verify before saving, so a typo never replaces a working key.
    try {
      if (id.data === "gemini") await checkGeminiKey(body.data.key);
      else if (id.data === "openai") await listOpenAIModels(body.data.key);
      else if (id.data === "cloudflare") {
        parseCloudflareKey(body.data.key);
        await listCloudflareModels(body.data.key, "Text-to-Image");
      }
      else await openRouterCredits(body.data.key);
    } catch (error) {
      return reply.code(400).send({ error: `Key rejected: ${error instanceof Error ? error.message : String(error)}` });
    }
    await saveKey(id.data, body.data.key);
    return checkProvider(rootDir, id.data);
  });
  app.delete("/api/providers/:id/key", async (request, reply) => {
    const id = z.enum(KEY_PROVIDERS as [KeyProvider, ...KeyProvider[]]).safeParse((request.params as { id: string }).id);
    if (!id.success) return reply.code(404).send({ error: "This provider doesn't use an API key." });
    await removeKey(id.data);
    return checkProvider(rootDir, id.data);
  });
  app.get("/api/assets", async (request, reply) => {
    const parsed = game.safeParse(
      (request.query as { gameId?: string }).gameId,
    );
    if (!parsed.success)
      return reply.code(400).send({ error: "A valid gameId is required." });
    return assets.listAssets(parsed.data);
  });
  app.get("/api/assets/:id/file", async (request, reply) => {
    const parsed = game.safeParse(
      (request.query as { gameId?: string }).gameId,
    );
    if (!parsed.success)
      return reply.code(400).send({ error: "A valid gameId is required." });
    const asset = await assets.getAsset(
      parsed.data,
      (request.params as { id: string }).id,
    );
    if (!asset) return reply.code(404).send({ error: "Asset not found." });
    const path = resolveAssetRelativePath(
      rootDir,
      asset.gameId,
      asset.relativePath,
    );
    reply.type(extname(path) === ".webp" ? "image/webp" : "image/png");
    return reply.send(createReadStream(path));
  });
  app.get("/api/assets/:id/frame", async (request, reply) => {
    const parsed = z.object({
      gameId: game,
      x: z.coerce.number().int().min(0), y: z.coerce.number().int().min(0),
      width: z.coerce.number().int().positive(), height: z.coerce.number().int().positive(),
      offsetX: z.coerce.number().int().default(0), offsetY: z.coerce.number().int().default(0),
      scale: z.coerce.number().min(0.8).max(1.25).default(1),
      boxWidth: z.coerce.number().int().positive().max(8192).optional(),
      boxHeight: z.coerce.number().int().positive().max(8192).optional(),
    }).safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ error: describeIssue(parsed.error) });
    const asset = await assets.getAsset(parsed.data.gameId, (request.params as { id: string }).id);
    if (!asset) return reply.code(404).send({ error: "Asset not found." });
    const inspection = asset.inspection;
    if (!inspection || parsed.data.x + parsed.data.width > inspection.width || parsed.data.y + parsed.data.height > inspection.height)
      return reply.code(400).send({ error: "The frame rectangle extends outside the sprite map." });
    const image = await renderSpriteFrame(
      resolveAssetRelativePath(rootDir, asset.gameId, asset.relativePath),
      parsed.data,
      { x: parsed.data.offsetX, y: parsed.data.offsetY },
      parsed.data.scale,
      { width: parsed.data.boxWidth ?? parsed.data.width, height: parsed.data.boxHeight ?? parsed.data.height },
    );
    return reply.type("image/png").send(image);
  });
  app.get("/api/assets/:id/detect-grid", async (request, reply) => {
    const parsed = z.object({
      gameId: game,
      columns: z.coerce.number().int().min(1).max(16).optional(),
      rows: z.coerce.number().int().min(1).max(16).optional(),
    }).safeParse(request.query);
    if (!parsed.success)
      return reply.code(400).send({ error: describeIssue(parsed.error) });
    const asset = await assets.getAsset(parsed.data.gameId, (request.params as { id: string }).id);
    if (!asset) return reply.code(404).send({ error: "Asset not found." });
    if (!asset.tags.includes("animation-spritemap"))
      return reply.code(400).send({ error: "Grid detection is available only for animation sprite maps." });
    // A layout the user typed beats the one read from the generation prompt.
    const prompted = asset.inspection && requestedGridLayout(asset.provenance.prompt, asset.inspection.width, asset.inspection.height);
    const columns = parsed.data.columns ?? prompted?.columns;
    const rows = parsed.data.rows ?? prompted?.rows;
    try {
      return await detectSpriteGrid(
        resolveAssetRelativePath(rootDir, asset.gameId, asset.relativePath),
        columns && rows ? { columns, rows } : null,
      );
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });
  // A cleaned sprite map from the Animation Lab becomes the next version; the original stays.
  app.post("/api/assets/:id/cleaned", { bodyLimit: 48 * 1024 * 1024 }, async (request, reply) => {
    const parsed = z.object({ gameId: game, png: z.string().min(1) }).safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: describeIssue(parsed.error) });
    const asset = await assets.getAsset(parsed.data.gameId, (request.params as { id: string }).id);
    if (!asset) return reply.code(404).send({ error: "Asset not found." });
    if (!asset.tags.includes("animation-spritemap"))
      return reply.code(400).send({ error: "Cleanup is available only for animation sprite maps." });
    const image = Buffer.from(parsed.data.png, "base64");
    const source = resolveAssetRelativePath(rootDir, asset.gameId, asset.relativePath);
    const [meta, original] = await Promise.all([sharp(image).metadata().catch(() => null), sharp(source).metadata()]);
    if (meta?.format !== "png" || meta.width !== original.width || meta.height !== original.height)
      return reply.code(400).send({ error: "The cleaned image must be a PNG the same size as the sprite map." });
    const dir = await mkdtemp(join(tmpdir(), "studio-clean-"));
    try {
      const sourcePath = join(dir, "clean.png");
      await writeFile(sourcePath, image);
      const created = await assets.importAsset({
        gameId: asset.gameId,
        family: asset.family,
        sourcePath,
        filename: asset.filename.replace(/-v\d+(?=\.[^.]+$)/, ""),
        state: asset.state,
        tags: asset.tags,
        provenance: { provider: "cleanup", parentId: asset.id, ...(asset.provenance.prompt ? { prompt: asset.provenance.prompt } : {}) },
      });
      return reply.code(201).send(created);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  // Pixelizing an asset saves a native-resolution sibling; the original stays.
  app.post("/api/assets/:id/pixelize", async (request, reply) => {
    const parsed = z.object({
      gameId: game,
      grid: z.number().int().min(8).max(512).optional(),
      colors: z.number().int().min(2).max(256).optional(),
      outline: z.boolean().optional(),
    }).safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: describeIssue(parsed.error) });
    const asset = await assets.getAsset(parsed.data.gameId, (request.params as { id: string }).id);
    if (!asset) return reply.code(404).send({ error: "Asset not found." });
    const saved = await settings.get(parsed.data.gameId);
    const style = {
      ...DEFAULT_PIXEL_STYLE,
      ...saved.pixelStyle,
      ...(parsed.data.grid !== undefined ? { grid: parsed.data.grid } : {}),
      ...(parsed.data.colors !== undefined ? { colors: parsed.data.colors } : {}),
      ...(parsed.data.outline !== undefined ? { outline: parsed.data.outline } : {}),
    };
    const dir = await mkdtemp(join(tmpdir(), "studio-pixelize-"));
    try {
      const source = await readFile(resolveAssetRelativePath(rootDir, asset.gameId, asset.relativePath));
      const { image, palette } = await pixelize(source, style, saved.palette);
      const target = join(dir, "pixel.png");
      await writeFile(target, image);
      // The first derived palette becomes the project's, so later assets match this one.
      if (!saved.palette?.length) await settings.set(parsed.data.gameId, { palette });
      const created = await assets.importAsset({
        gameId: asset.gameId,
        family: asset.family,
        sourcePath: target,
        filename: asset.filename.replace(/-v\d+(?=\.[^.]+$)/, ""),
        state: asset.state,
        tags: asset.tags,
        pixel: { palette },
        provenance: { provider: "pixelize", parentId: asset.id, ...(asset.provenance.prompt ? { prompt: asset.provenance.prompt } : {}) },
      });
      return reply.code(201).send(created);
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  app.post("/api/assets/:id/frame-anchors", async (request, reply) => {
    const parsed = z.object({
      gameId: game,
      rects: z.array(z.object({
        x: z.number().int().min(0), y: z.number().int().min(0),
        width: z.number().int().positive(), height: z.number().int().positive(),
      })).min(1).max(64),
      mode: z.enum(["subject", "base"]).default("subject"),
    }).safeParse(request.body);
    if (!parsed.success)
      return reply.code(400).send({ error: describeIssue(parsed.error) });
    const asset = await assets.getAsset(parsed.data.gameId, (request.params as { id: string }).id);
    if (!asset) return reply.code(404).send({ error: "Asset not found." });
    if (!asset.tags.includes("animation-spritemap"))
      return reply.code(400).send({ error: "Frame alignment is available only for animation sprite maps." });
    const image = asset.inspection;
    if (!image || parsed.data.rects.some((rect) => rect.x + rect.width > image.width || rect.y + rect.height > image.height))
      return reply.code(400).send({ error: "A frame rectangle extends outside the sprite map." });
    try {
      return await detectFrameAnchors(resolveAssetRelativePath(rootDir, asset.gameId, asset.relativePath), parsed.data.rects, parsed.data.mode);
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });
  app.post("/api/assets/:id/move", async (request, reply) => {
    const parsed = z
      .object({ gameId: game, state: z.enum(ASSET_STATES) })
      .safeParse(request.body);
    if (!parsed.success)
      return reply.code(400).send({ error: describeIssue(parsed.error) });
    try {
      const moved = await assets.moveAsset(
        parsed.data.gameId,
        (request.params as { id: string }).id,
        parsed.data.state,
      );
      // Approving moves the file from candidates/ to approved/; keep animation manifests pointing at it.
      await animations.update(parsed.data.gameId, (records) => retargetFrames(records, moved.id, moved.relativePath));
      return moved;
    } catch (error) {
      return reply.code(400).send({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });
  app.delete("/api/assets/:id", async (request, reply) => {
    const parsed = game.safeParse(
      (request.query as { gameId?: string }).gameId,
    );
    if (!parsed.success)
      return reply.code(400).send({ error: "A valid gameId is required." });
    try {
      return await assets.removeAsset(
        parsed.data,
        (request.params as { id: string }).id,
      );
    } catch (error) {
      return reply.code(400).send({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });
  app.post("/api/assets/:id/fix", async (request, reply) => {
    const parsed = z
      .object({
        gameId: game,
        provider: z.enum(GENERATOR_PROVIDERS).default("delegate-antigravity"),
      })
      .safeParse(request.body);
    if (!parsed.success)
      return reply.code(400).send({ error: "A valid gameId is required." });
    const asset = await assets.getAsset(
      parsed.data.gameId,
      (request.params as { id: string }).id,
    );
    if (!asset) return reply.code(404).send({ error: "Asset not found." });
    const issues = asset.inspection?.warnings ?? [];
    if (!issues.length)
      return reply.code(400).send({
        error: "This asset has no automated inspection issues to fix.",
      });
    const stem = asset.filename.slice(
      0,
      asset.filename.length - extname(asset.filename).length,
    );
    const originalRequest = asset.provenance.prompt
      ? `Original request:\n${asset.provenance.prompt}\n\n`
      : "";
    const prompt = `${originalRequest}Repair this existing game-asset candidate. Preserve its subject, painterly fixed-isometric 2.5D style, and intended use. Correct every validation issue below:\n${issues.map((issue) => `- ${issue}`).join("\n")}\nReturn a clean PNG cutout with genuine transparency and comfortable transparent padding. Do not add a checkerboard, solid backdrop, labels, or unrelated scenery.`;
    const submitted = await jobs.submit([
      {
        gameId: asset.gameId,
        family: asset.family,
        name: `${stem}-fixed`,
        prompt,
        brief: `Fix ${asset.filename}: ${issues.join("; ")}`,
        transparent: true,
        references: [asset.relativePath],
        operation: "repair",
        provider: parsed.data.provider,
      },
    ]).catch((error: unknown) => (error instanceof Error ? error : new Error(String(error))));
    if (submitted instanceof Error) return reply.code(402).send({ error: submitted.message });
    const [created] = submitted;
    if (!created)
      return reply.code(500).send({ error: "Could not create repair job." });
    jobs.enqueue([created.id]);
    return reply.code(202).send(created);
  });
  app.get("/api/jobs", async () => jobs.list());
  app.get("/api/settings", async (request, reply) => {
    const parsed = game.safeParse(
      (request.query as { gameId?: string }).gameId,
    );
    if (!parsed.success)
      return reply.code(400).send({ error: "A valid gameId is required." });
    return settings.get(parsed.data);
  });
  app.put("/api/settings", async (request, reply) => {
    const parsed = z
      .object({
        gameId: game,
        globalPrompt: z.string().max(12_000).optional(),
        briefs: z.record(z.enum(["animation", "variation", "spriteMapVariation"]), z.string().max(4_000)).optional(),
      })
      .safeParse(request.body);
    if (!parsed.success)
      return reply.code(400).send({ error: describeIssue(parsed.error) });
    if (parsed.data.globalPrompt === undefined)
      // Only saved briefs are stored; a brief left at its default follows future default changes.
      return settings.set(parsed.data.gameId, { briefs: Object.fromEntries(Object.entries(parsed.data.briefs ?? {}).filter(([, text]) => text.trim())) });
    let globalPrompt = parsed.data.globalPrompt.trim();
    let synthesized = false;
    if (globalPrompt.length > MAX_GLOBAL_PROMPT_LENGTH) {
      try {
        globalPrompt = await runPromptAssistant(rootDir, 
          `Condense this image-generation art direction to at most ${MAX_GLOBAL_PROMPT_LENGTH} characters. Preserve concrete visual constraints, output only the condensed prompt, and remove repetition: ${globalPrompt}`,
        );
        synthesized = true;
      } catch (error) {
        return reply.code(502).send({
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    if (globalPrompt.length > MAX_GLOBAL_PROMPT_LENGTH)
      globalPrompt = globalPrompt.slice(0, MAX_GLOBAL_PROMPT_LENGTH).trimEnd();
    return {
      ...(await settings.set(parsed.data.gameId, { globalPrompt })),
      synthesized,
      maxLength: MAX_GLOBAL_PROMPT_LENGTH,
    };
  });
  app.post("/api/settings/condense", async (request, reply) => {
    const parsed = z
      .object({ globalPrompt: z.string().min(1).max(12_000) })
      .safeParse(request.body);
    if (!parsed.success)
      return reply.code(400).send({ error: describeIssue(parsed.error) });
    try {
      const globalPrompt = await runPromptAssistant(rootDir, 
        `Condense this image-generation art direction to at most ${MAX_GLOBAL_PROMPT_LENGTH} characters. Preserve concrete visual constraints, output only the condensed prompt, and remove repetition: ${parsed.data.globalPrompt}`,
      );
      return {
        globalPrompt: globalPrompt.slice(0, MAX_GLOBAL_PROMPT_LENGTH).trimEnd(),
        maxLength: MAX_GLOBAL_PROMPT_LENGTH,
      };
    } catch (error) {
      return reply.code(502).send({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });
  app.post("/api/uploads", async (request, reply) => {
    const parsed = z
      .object({
        gameId: game,
        filename: z.string().regex(/^[a-zA-Z0-9._-]+\.(png|webp|jpg|jpeg)$/i),
        contentBase64: z.string().min(4).max(24_000_000),
      })
      .safeParse(request.body);
    if (!parsed.success)
      return reply.code(400).send({ error: describeIssue(parsed.error) });
    const temporary = join(
      rootDir,
      "data/uploads",
      `${Date.now()}-${parsed.data.filename}`,
    );
    await mkdir(join(rootDir, "data/uploads"), {
      recursive: true,
    });
    await writeFile(
      temporary,
      Buffer.from(parsed.data.contentBase64, "base64"),
    );
    try {
      return reply.code(201).send(
        await assets.importAsset({
          gameId: parsed.data.gameId,
          family: "references",
          sourcePath: temporary,
          filename: parsed.data.filename,
          state: "source",
          provenance: { provider: "user-upload" },
        }),
      );
    } catch (error) {
      return reply.code(400).send({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });
  app.post("/api/prompts/enhance", async (request, reply) => {
    const parsed = z
      .object({
        gameId: game,
        family: z.string().min(1),
        prompt: z.string().min(3).max(2400),
      })
      .safeParse(request.body);
    if (!parsed.success)
      return reply.code(400).send({ error: describeIssue(parsed.error) });
    const profile = await settings.get(parsed.data.gameId);
    const instruction = `Return only a concise improved image-generation prompt of roughly 700–900 characters, never exceeding ${MAX_ENHANCED_BRIEF_LENGTH} characters, for a ${parsed.data.family} game asset. Preserve the user's requested subject and highest-value constraints. Remove repetition and details already supplied by the global art direction. Specify a fixed isometric 2.5D painterly sprite/cutout, coherent upper-left lighting, readable silhouette, no labels, no checkerboard, no unrelated scenery. Never name a background, matte or backdrop colour; the studio adds that itself. Global art direction: ${profile.globalPrompt || "(none)"}. User brief: ${parsed.data.prompt}`;
    try {
      return {
        prompt: (await runPromptAssistant(rootDir, instruction))
          .slice(0, MAX_ENHANCED_BRIEF_LENGTH)
          .trimEnd(),
        targetLength: MAX_ENHANCED_BRIEF_LENGTH,
      };
    } catch (error) {
      return reply.code(502).send({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });
  app.post("/api/jobs", async (request, reply) => {
    const parsed = z
      .object({ jobs: z.array(brief).min(1).max(100) })
      .safeParse(request.body);
    if (!parsed.success)
      return reply.code(400).send({ error: describeIssue(parsed.error) });
    const safeBriefs = await Promise.all(
      parsed.data.jobs.map(async ({ references, tags, ...job }) => {
        const profile = await settings.get(job.gameId);
        const prompt = profile.globalPrompt
          ? `${profile.globalPrompt}\n\nAsset-specific request:\n${job.prompt}`
          : job.prompt;
        const safeJob = { ...job, prompt, brief: job.brief?.trim() || job.prompt, ...(tags ? { tags } : {}) };
        return references ? { ...safeJob, references } : safeJob;
      }),
    );
    let created;
    try {
      created = await jobs.submit(safeBriefs);
    } catch (error) {
      return reply.code(402).send({ error: error instanceof Error ? error.message : String(error) });
    }
    jobs.enqueue(created.map((job) => job.id));
    return reply.code(202).send(created);
  });
  app.post("/api/jobs/:id/cancel", async (request, reply) => {
    try {
      return await jobs.cancel((request.params as { id: string }).id);
    } catch (error) {
      return reply.code(400).send({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });
  app.post("/api/jobs/:id/retry", async (request, reply) => {
    try {
      const job = await jobs.retry((request.params as { id: string }).id);
      jobs.enqueue([job.id]);
      return job;
    } catch (error) {
      return reply.code(400).send({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });
  app.delete("/api/jobs/:id", async (request, reply) => {
    try {
      return await jobs.remove((request.params as { id: string }).id);
    } catch (error) {
      return reply.code(400).send({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });
  app.get("/api/animations", async (request, reply) => {
    const parsed = game.safeParse(
      (request.query as { gameId?: string }).gameId,
    );
    if (!parsed.success)
      return reply.code(400).send({ error: "A valid gameId is required." });
    return animations.list(parsed.data);
  });
  app.delete("/api/animations/:id", async (request, reply) => {
    const parsed = game.safeParse((request.query as { gameId?: string }).gameId);
    if (!parsed.success) return reply.code(400).send({ error: "A valid gameId is required." });
    const id = (request.params as { id: string }).id;
    let removed: string | undefined;
    // Only the manifest goes; its sheet and any exported files stay, since a game may ship them.
    const remaining = await animations.update(parsed.data, (records) => {
      removed = records.find((record) => record.id === id)?.name;
      return records.filter((record) => record.id !== id);
    });
    if (!removed) return reply.code(404).send({ error: "Animation not found." });
    return { removed, animations: remaining };
  });
  const exportDir = (gameId: string, name: string) => join(resolveGameAssetsDir(rootDir, gameId), "animations", "exports", name);
  app.post("/api/animations/:id/export", async (request, reply) => {
    const parsed = z.object({ gameId: game }).safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: describeIssue(parsed.error) });
    const record = (await animations.list(parsed.data.gameId)).find((item) => item.id === (request.params as { id: string }).id);
    if (!record) return reply.code(404).send({ error: "Animation not found." });
    try {
      // Resolve through the asset id first, so an animation still exports after its sheet moved.
      const current = new Map((await assets.listAssets(record.gameId)).map((asset) => [asset.id, asset.relativePath]));
      const files = await exportAnimation(
        record,
        (frame) => resolveAssetRelativePath(rootDir, record.gameId, (frame.assetId && current.get(frame.assetId)) || frame.sourcePath),
        exportDir(record.gameId, record.name),
      );
      return { directory: `animations/exports/${record.name}`, files };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return reply.code(400).send({
        error: /ENOENT/.test(message) ? "A source image for this animation is missing (moved or removed). Rebuild it in the Animation Lab." : message,
      });
    }
  });
  app.get("/api/animations/:id/exports/:filename", async (request, reply) => {
    const parsed = z.object({ gameId: game }).safeParse(request.query);
    const { id, filename } = request.params as { id: string; filename: string };
    if (!parsed.success || !/^[a-z0-9-]+\.(png|json|webp)$/.test(filename)) return reply.code(400).send({ error: "Invalid export request." });
    const record = (await animations.list(parsed.data.gameId)).find((item) => item.id === id);
    if (!record || !filename.startsWith(`${record.name}.`)) return reply.code(404).send({ error: "Export not found." });
    const path = join(exportDir(record.gameId, record.name), filename);
    try {
      await stat(path);
    } catch {
      return reply.code(404).send({ error: "Export this animation first." });
    }
    reply.type({ png: "image/png", json: "application/json", webp: "image/webp" }[extname(filename).slice(1)] ?? "application/octet-stream");
    return reply.send(createReadStream(path));
  });
  app.post("/api/animations", async (request, reply) => {
    const parsed = z
      .object({
        gameId: game,
        name: z.string().regex(/^[a-z0-9-]+$/),
        loop: z.enum(["loop", "once", "ping-pong"]),
        fps: z.number().int().min(1).max(60),
        source: z.enum(["sequence", "sheet"]),
        frames: z
          .array(
            z.object({
              assetId: z.string().optional(),
              sourcePath: z.string(),
              durationMs: z.number().int().min(0),
              hidden: z.boolean().optional(),
              rect: z
                .object({
                  x: z.number().int(),
                  y: z.number().int(),
                  width: z.number().int(),
                  height: z.number().int(),
                })
                .optional(),
              anchorOffset: z
                .object({ x: z.number().int(), y: z.number().int() })
                .optional(),
              anchorScale: z.number().min(0.8).max(1.25).optional(),
              box: z
                .object({ width: z.number().int().positive(), height: z.number().int().positive() })
                .optional(),
            }),
          )
          .min(1),
      })
      .safeParse(request.body);
    if (!parsed.success)
      return reply.code(400).send({ error: describeIssue(parsed.error) });
    const frames = parsed.data.frames.map(
      ({ assetId, hidden, rect, anchorOffset, anchorScale, box, ...frame }) => ({
        ...frame,
        ...(assetId ? { assetId } : {}),
        ...(hidden === undefined ? {} : { hidden }),
        ...(rect ? { rect } : {}),
        ...(anchorOffset ? { anchorOffset } : {}),
        ...(anchorScale === undefined ? {} : { anchorScale }),
        ...(box ? { box } : {}),
      }),
    );
    return reply
      .code(201)
      .send(await animations.save({ ...parsed.data, frames }));
  });
}

/** Every prompt-writing request goes to the text model chosen in Settings. */
async function runPromptAssistant(rootDir: string, instruction: string) {
  return runText(await readTextModel(rootDir), instruction);
}
