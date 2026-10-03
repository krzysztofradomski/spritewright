import { readFile, writeFile } from "node:fs/promises";
import { extname } from "node:path";
import { readKey } from "./api-keys.js";

const API = "https://generativelanguage.googleapis.com/v1beta";
// Same model delegate.sh uses for AI Studio; override without a code change.
export const GEMINI_IMAGE_MODEL = process.env.GEMINI_IMAGE_MODEL ?? "gemini-2.5-flash-image";
// ponytail: Google returns no price, so each image is charged at list price (1290 output tokens
// at $30/M). Update when the model or its pricing changes.
export const GEMINI_IMAGE_COST_USD = Number(process.env.GEMINI_IMAGE_COST_USD ?? 0.039);

async function readError(response: Response) {
  const body = (await response.json().catch(() => null)) as { error?: { message?: string } } | null;
  return body?.error?.message ?? `HTTP ${response.status}`;
}

/** Lists models, which is free, to prove the key works and can see the image model. */
export async function checkGeminiKey(key: string, model = GEMINI_IMAGE_MODEL) {
  const response = await fetch(`${API}/models?pageSize=1000`, { headers: { "x-goog-api-key": key }, signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(await readError(response));
  const { models = [] } = (await response.json()) as { models?: Array<{ name: string }> };
  return { hasImageModel: models.some((item) => item.name === `models/${model}`) };
}

/** Image models this key can call through generateContent (Imagen's predict API isn't supported). */
export async function listGeminiImageModels(key: string) {
  const response = await fetch(`${API}/models?pageSize=1000`, { headers: { "x-goog-api-key": key }, signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(await readError(response));
  const { models = [] } = (await response.json()) as { models?: Array<{ name: string; supportedGenerationMethods?: string[] }> };
  return models
    .filter((model) => model.supportedGenerationMethods?.includes("generateContent") && /image/.test(model.name))
    .map((model) => model.name.replace(/^models\//, ""))
    .sort();
}

const mimeFor = (path: string) => ({ ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp" })[extname(path).toLowerCase()] ?? "image/png";

/** One generateContent call with image output; reference images travel inline. */
export async function runGemini(prompt: string, output: string, references: string[], signal: AbortSignal, model = GEMINI_IMAGE_MODEL) {
  const key = (await readKey("gemini"))?.key;
  if (!key) throw new Error("No Google AI Studio key. Add one in Settings → Image providers.");
  const images = await Promise.all(
    references.map(async (path) => ({ inlineData: { mimeType: mimeFor(path), data: (await readFile(path)).toString("base64") } })),
  );
  const response = await fetch(`${API}/models/${encodeURIComponent(model)}:generateContent`, {
    method: "POST",
    headers: { "x-goog-api-key": key, "Content-Type": "application/json" },
    signal,
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }, ...images] }],
      generationConfig: { responseModalities: ["TEXT", "IMAGE"] },
    }),
  });
  if (!response.ok) throw new Error(`Gemini image generation failed: ${await readError(response)}`);
  const body = (await response.json()) as {
    candidates?: Array<{ finishReason?: string; content?: { parts?: Array<{ text?: string; inlineData?: { data?: string } }> } }>;
    promptFeedback?: { blockReason?: string };
  };
  const parts = body.candidates?.[0]?.content?.parts ?? [];
  const data = parts.find((part) => part.inlineData?.data)?.inlineData?.data;
  if (!data) {
    const reason = body.promptFeedback?.blockReason ?? body.candidates?.[0]?.finishReason ?? "";
    const text = parts.map((part) => part.text ?? "").join(" ").slice(0, 300);
    throw new Error(`Gemini returned no image. ${[reason, text].filter(Boolean).join(": ")}`.trim());
  }
  await writeFile(output, Buffer.from(data, "base64"));
  return { costUsd: GEMINI_IMAGE_COST_USD };
}

/** Chat models this key can call, without the image and embedding ones. */
export async function listGeminiTextModels(key: string) {
  const response = await fetch(`${API}/models?pageSize=1000`, { headers: { "x-goog-api-key": key }, signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(await readError(response));
  const { models = [] } = (await response.json()) as { models?: Array<{ name: string; supportedGenerationMethods?: string[] }> };
  return models
    .filter((model) => model.supportedGenerationMethods?.includes("generateContent") && !/image|embedding|tts|audio/.test(model.name))
    .map((model) => model.name.replace(/^models\//, ""))
    .sort();
}

export async function geminiText(model: string, prompt: string, signal: AbortSignal) {
  const key = (await readKey("gemini"))?.key;
  if (!key) throw new Error("No Google AI Studio key. Add one in Settings → Image providers.");
  const response = await fetch(`${API}/models/${model}:generateContent`, {
    method: "POST",
    headers: { "x-goog-api-key": key, "Content-Type": "application/json" },
    body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
    signal,
  });
  if (!response.ok) throw new Error(`Gemini: ${await readError(response)}`);
  const body = (await response.json()) as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
  return (body.candidates?.[0]?.content?.parts ?? []).map((part) => part.text ?? "").join("");
}
