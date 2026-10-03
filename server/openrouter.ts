import { readFile, writeFile } from "node:fs/promises";
import { extname } from "node:path";
import { readKey } from "./api-keys.js";

const API = "https://openrouter.ai/api/v1";
// Same model delegate.sh uses for its paid fallback; override without a code change.
export const OPENROUTER_IMAGE_MODEL = process.env.OPENROUTER_IMAGE_MODEL ?? "google/gemini-2.5-flash-image";

/** Same lookup as delegate.sh: environment first, then ~/.config/openrouter/key. */
export const openRouterKey = async () => (await readKey("openrouter"))?.key ?? null;

const headers = (key: string) => ({ Authorization: `Bearer ${key}`, "Content-Type": "application/json" });

async function readError(response: Response) {
  const body = (await response.json().catch(() => null)) as { error?: { message?: string } } | null;
  return body?.error?.message ?? `HTTP ${response.status}`;
}

export type OpenRouterCredits = {
  keyLimit: number | null;
  keyUsage: number;
  keyRemaining: number | null;
  totalCredits: number | null;
  totalUsage: number | null;
};

/** Reads the key's own limit and the account balance; neither call costs anything. */
export async function openRouterCredits(key: string): Promise<OpenRouterCredits> {
  const keyResponse = await fetch(`${API}/key`, { headers: headers(key), signal: AbortSignal.timeout(15_000) });
  if (!keyResponse.ok) throw new Error(await readError(keyResponse));
  const keyData = ((await keyResponse.json()) as { data: { limit: number | null; usage: number; limit_remaining?: number | null } }).data;
  // /credits needs a key with account access; a narrower key still reports its own limit above.
  const credits = await fetch(`${API}/credits`, { headers: headers(key), signal: AbortSignal.timeout(15_000) })
    .then(async (response) => (response.ok ? ((await response.json()) as { data: { total_credits: number; total_usage: number } }).data : null))
    .catch(() => null);
  return {
    keyLimit: keyData.limit,
    keyUsage: keyData.usage,
    keyRemaining: keyData.limit_remaining ?? (keyData.limit === null ? null : keyData.limit - keyData.usage),
    totalCredits: credits?.total_credits ?? null,
    totalUsage: credits?.total_usage ?? null,
  };
}

/**
 * Image models take an aspect ratio from a short list, not pixel dimensions. Asking for the
 * closest one keeps the canvas the right shape; a sheet asked for in an unsupported ratio comes
 * back square, with the model inventing its own grid to fill it.
 */
const ASPECT_RATIOS = ["1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9"] as const;
export function nearestAspectRatio(ratio: number) {
  return ASPECT_RATIOS.reduce((best, candidate) => {
    const value = (parts: string) => Number(parts.split(":")[0]) / Number(parts.split(":")[1]);
    return Math.abs(value(candidate) - ratio) < Math.abs(value(best) - ratio) ? candidate : best;
  });
}

const mimeFor = (path: string) => ({ ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp" })[extname(path).toLowerCase()] ?? "image/png";

/**
 * OpenRouter has two paths: the images endpoint, which every image model accepts, and
 * chat/completions, which only multimodal chat models accept. Dedicated image models
 * (gpt-image, muse, FLUX) are refused outright by chat, so the images endpoint comes first and
 * chat is the fallback for models that are only reachable that way.
 */
export async function runOpenRouter(prompt: string, output: string, references: string[], signal: AbortSignal, model = OPENROUTER_IMAGE_MODEL, size?: { width: number; height: number }) {
  const key = await openRouterKey();
  if (!key) throw new Error("No OpenRouter key. Set OPENROUTER_API_KEY or save it to ~/.config/openrouter/key.");
  const images = await Promise.all(
    references.map(async (path) => ({
      type: "image_url",
      image_url: { url: `data:${mimeFor(path)};base64,${(await readFile(path)).toString("base64")}` },
    })),
  );
  const viaImages = await fetch(`${API}/images`, {
    method: "POST",
    headers: headers(key),
    signal,
    body: JSON.stringify({
      model,
      prompt,
      ...(size ? { aspect_ratio: nearestAspectRatio(size.width / size.height) } : {}),
      ...(images.length ? { input_references: images } : {}),
    }),
  });
  if (viaImages.ok) {
    const body = (await viaImages.json()) as { data?: Array<{ b64_json?: string }>; usage?: { cost?: number } };
    const costUsd = typeof body.usage?.cost === "number" ? body.usage.cost : undefined;
    const data = body.data?.[0]?.b64_json;
    if (!data) throw Object.assign(new Error("OpenRouter returned no image."), { costUsd });
    await writeFile(output, Buffer.from(data, "base64"));
    return { costUsd };
  }
  const imagesError = await readError(viaImages);
  // Only a model this endpoint doesn't serve is worth retrying; a bad key or a refusal is not.
  if (!/not.*(support|available|found)|chat.?completions|unsupported|no endpoints/i.test(imagesError) || viaImages.status === 401 || viaImages.status === 403)
    throw new Error(`OpenRouter image generation failed: ${imagesError}`);
  const request = (modalities: string[]) => fetch(`${API}/chat/completions`, {
    method: "POST",
    headers: headers(key),
    signal,
    body: JSON.stringify({
      model,
      modalities,
      // Ask OpenRouter to report what this call cost, so spending is tracked from real numbers.
      usage: { include: true },
      messages: [{ role: "user", content: [{ type: "text", text: prompt }, ...images] }],
    }),
  });
  let response = await request(["image", "text"]);
  // Image-only models (FLUX, Seedream) refuse a text modality; a refused request isn't billed.
  if (response.status === 400 || response.status === 404) {
    const message = await readError(response);
    if (!/modalit|output/i.test(message)) throw new Error(`OpenRouter image generation failed: ${message}`);
    response = await request(["image"]);
  }
  if (!response.ok) throw new Error(`OpenRouter image generation failed: ${await readError(response)}`);
  const body = (await response.json()) as {
    choices?: Array<{ message?: { content?: string; images?: Array<{ image_url?: { url?: string } }> } }>;
    usage?: { cost?: number };
  };
  const costUsd = typeof body.usage?.cost === "number" ? body.usage.cost : undefined;
  const url = body.choices?.[0]?.message?.images?.[0]?.image_url?.url;
  const data = url?.match(/^data:image\/[a-z+.-]+;base64,(.+)$/)?.[1];
  if (!data)
    throw Object.assign(new Error(`OpenRouter returned no image. ${body.choices?.[0]?.message?.content?.slice(0, 300) ?? ""}`.trim()), { costUsd });
  await writeFile(output, Buffer.from(data, "base64"));
  return { costUsd };
}

/** OpenRouter's public model list, which needs no key, narrowed to one output modality. */
export async function listOpenRouterModels(output: "text" | "image" = "text") {
  const response = await fetch(`${API}/models?output_modalities=${output}`, { signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(await readError(response));
  const { data } = (await response.json()) as { data: Array<{ id: string; architecture?: { output_modalities?: string[] } }> };
  // Models that don't declare modalities are text models.
  return data.filter((model) => model.architecture?.output_modalities?.includes(output) ?? output === "text").map((model) => model.id).sort();
}

export async function openRouterText(model: string, prompt: string, signal: AbortSignal) {
  const key = await openRouterKey();
  if (!key) throw new Error("No OpenRouter key. Add one in Settings → Image providers.");
  const response = await fetch(`${API}/chat/completions`, {
    method: "POST",
    headers: headers(key),
    body: JSON.stringify({ model, messages: [{ role: "user", content: prompt }] }),
    signal,
  });
  if (!response.ok) throw new Error(`OpenRouter: ${await readError(response)}`);
  return ((await response.json()) as { choices?: Array<{ message?: { content?: string } }> }).choices?.[0]?.message?.content ?? "";
}
