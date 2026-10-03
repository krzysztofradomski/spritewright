import { readFile, writeFile } from "node:fs/promises";
import { basename, extname } from "node:path";
import { readKey } from "./api-keys.js";

const API = "https://api.openai.com/v1";
export const OPENAI_IMAGE_MODEL = process.env.OPENAI_IMAGE_MODEL ?? "gpt-image-1";
// ponytail: OpenAI bills image tokens, not a flat price; this is list price for one medium-quality
// 1024x1024 gpt-image-1 render. Update when the model, quality or pricing changes.
export const OPENAI_IMAGE_COST_USD = Number(process.env.OPENAI_IMAGE_COST_USD ?? 0.042);

async function openAIKey() {
  const key = (await readKey("openai"))?.key;
  if (!key) throw new Error("No OpenAI key. Add one in Settings → Image providers.");
  return key;
}

async function readError(response: Response) {
  const body = (await response.json().catch(() => null)) as { error?: { message?: string } } | null;
  return body?.error?.message ?? `HTTP ${response.status}`;
}

/** Lists models, which is free, to prove the key works; returns the model ids it can use. */
export async function listOpenAIModels(key: string) {
  const response = await fetch(`${API}/models`, { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(await readError(response));
  return ((await response.json()) as { data: Array<{ id: string }> }).data.map((model) => model.id).sort();
}

const mimeFor = (path: string) => ({ ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp" })[extname(path).toLowerCase()] ?? "image/png";

/** A plain generation, or an edit when there are reference images to work from. */
export async function runOpenAIImage(prompt: string, output: string, references: string[], signal: AbortSignal, model = OPENAI_IMAGE_MODEL) {
  const key = await openAIKey();
  const headers = { Authorization: `Bearer ${key}` };
  let response: Response;
  if (references.length) {
    const form = new FormData();
    form.set("model", model);
    form.set("prompt", prompt);
    form.set("quality", "medium");
    for (const path of references)
      form.append("image[]", new Blob([await readFile(path)], { type: mimeFor(path) }), basename(path));
    response = await fetch(`${API}/images/edits`, { method: "POST", headers, body: form, signal });
  } else {
    response = await fetch(`${API}/images/generations`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ model, prompt, quality: "medium", size: "1024x1024" }),
      signal,
    });
  }
  if (!response.ok) throw new Error(`OpenAI image generation failed: ${await readError(response)}`);
  const data = ((await response.json()) as { data?: Array<{ b64_json?: string }> }).data?.[0]?.b64_json;
  // A request that got this far was billed even if it came back empty.
  if (!data) throw Object.assign(new Error("OpenAI returned no image."), { costUsd: OPENAI_IMAGE_COST_USD });
  await writeFile(output, Buffer.from(data, "base64"));
  return { costUsd: OPENAI_IMAGE_COST_USD };
}

export async function openAIText(model: string, prompt: string, signal: AbortSignal) {
  const response = await fetch(`${API}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${await openAIKey()}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model, messages: [{ role: "user", content: prompt }] }),
    signal,
  });
  if (!response.ok) throw new Error(`OpenAI: ${await readError(response)}`);
  return ((await response.json()) as { choices?: Array<{ message?: { content?: string } }> }).choices?.[0]?.message?.content ?? "";
}
