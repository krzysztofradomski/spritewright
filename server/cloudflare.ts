import sharp from "sharp";
import { readKey } from "./api-keys.js";

export const CLOUDFLARE_IMAGE_MODEL = process.env.CLOUDFLARE_IMAGE_MODEL ?? "@cf/black-forest-labs/flux-1-schnell";
// ponytail: Workers AI bills neurons; 4 512px tiles plus 8 steps of flux-1-schnell is about this much
// past the free daily allocation. Update when the model or pricing changes.
export const CLOUDFLARE_IMAGE_COST_USD = Number(process.env.CLOUDFLARE_IMAGE_COST_USD ?? 0.0011);
// flux-1-schnell rejects longer prompts outright.
const MAX_PROMPT_LENGTH = 2_048;

/** The saved key is "<account id>:<API token>", since Workers AI needs both. */
export function parseCloudflareKey(value: string) {
  const [accountId, token, ...rest] = value.trim().split(":");
  if (!accountId || !token || rest.length || !/^[a-f0-9]{32}$/i.test(accountId))
    throw new Error("Use the form <account id>:<API token>; the account ID is 32 hex characters.");
  return { accountId, token };
}

async function credentials(value?: string) {
  const saved = value ?? (await readKey("cloudflare"))?.key;
  if (!saved) throw new Error("No Cloudflare key. Add one in Settings → Image providers.");
  return parseCloudflareKey(saved);
}

type Envelope<T> = { success?: boolean; result?: T; errors?: Array<{ message?: string }> };

async function call<T>(value: string | undefined, path: string, init: RequestInit = {}) {
  const { accountId, token } = await credentials(value);
  const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
  });
  const body = (await response.json().catch(() => null)) as Envelope<T> | null;
  if (!response.ok || !body?.success) throw new Error(body?.errors?.map((error) => error.message).join("; ") || `HTTP ${response.status}`);
  return body.result as T;
}

/** Searches the model catalog, which is free, to prove the account ID and token work. */
export async function listCloudflareModels(value?: string, task = "Text Generation") {
  const models = await call<Array<{ name: string }>>(value, `/ai/models/search?per_page=200&task=${encodeURIComponent(task)}`, { signal: AbortSignal.timeout(15_000) });
  return models.map((model) => model.name).sort();
}

/** Text-to-image only: these models take no image input, so references can't be used. */
export async function runCloudflareImage(prompt: string, output: string, _references: string[], signal: AbortSignal, model = CLOUDFLARE_IMAGE_MODEL) {
  const { accountId, token } = await credentials();
  const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${model}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    // steps is flux-1-schnell's own knob (max 8); other models reject or ignore it.
    body: JSON.stringify({ prompt: prompt.slice(0, MAX_PROMPT_LENGTH), ...(model === CLOUDFLARE_IMAGE_MODEL ? { steps: 8 } : {}) }),
    signal,
  });
  // flux answers with base64 JSON; the SDXL family streams the image itself.
  let image: Buffer | undefined;
  if (response.ok && response.headers.get("content-type")?.startsWith("image/")) image = Buffer.from(await response.arrayBuffer());
  else {
    const body = (await response.json().catch(() => null)) as Envelope<{ image?: string }> | null;
    if (!response.ok || !body?.success)
      throw new Error(`Cloudflare image generation failed: ${body?.errors?.map((error) => error.message).join("; ") || `HTTP ${response.status}`}`);
    if (body.result?.image) image = Buffer.from(body.result.image, "base64");
  }
  if (!image) throw Object.assign(new Error("Cloudflare returned no image."), { costUsd: CLOUDFLARE_IMAGE_COST_USD });
  // Models answer with JPEG or PNG; the rest of the pipeline expects a PNG.
  await sharp(image).png().toFile(output);
  return { costUsd: CLOUDFLARE_IMAGE_COST_USD };
}

export async function cloudflareText(model: string, prompt: string, signal: AbortSignal) {
  const result = await call<{ response?: unknown; choices?: Array<{ message?: { content?: string } }> }>(undefined, `/ai/run/${model}`, {
    method: "POST",
    body: JSON.stringify({ messages: [{ role: "user", content: prompt }] }),
    signal,
  });
  return typeof result.response === "string" ? result.response : result.choices?.[0]?.message?.content ?? "";
}
