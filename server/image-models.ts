import { readKey } from "./api-keys.js";
import { readAppSettings, updateAppSettings } from "./app-settings.js";
import { CLOUDFLARE_IMAGE_MODEL, listCloudflareModels } from "./cloudflare.js";
import { GEMINI_IMAGE_MODEL, listGeminiImageModels } from "./gemini.js";
import { listOpenAIModels, OPENAI_IMAGE_MODEL } from "./openai.js";
import { listOpenRouterModels, OPENROUTER_IMAGE_MODEL } from "./openrouter.js";

/** The API image providers whose model can be picked; plan providers use their CLI's own image tool. */
export const IMAGE_MODEL_DEFAULTS = {
  openrouter: OPENROUTER_IMAGE_MODEL,
  gemini: GEMINI_IMAGE_MODEL,
  openai: OPENAI_IMAGE_MODEL,
  cloudflare: CLOUDFLARE_IMAGE_MODEL,
};
export type ImageModelProvider = keyof typeof IMAGE_MODEL_DEFAULTS;
export type ImageModels = Record<ImageModelProvider, string>;
export const IMAGE_MODEL_PROVIDERS = Object.keys(IMAGE_MODEL_DEFAULTS) as [ImageModelProvider, ...ImageModelProvider[]];

export async function readImageModels(rootDir: string): Promise<ImageModels> {
  const saved = (await readAppSettings(rootDir)).imageModels ?? {};
  return Object.fromEntries(IMAGE_MODEL_PROVIDERS.map((id) => [id, saved[id]?.trim() || IMAGE_MODEL_DEFAULTS[id]])) as ImageModels;
}

/** An empty model goes back to the provider's default. */
export async function writeImageModel(rootDir: string, provider: ImageModelProvider, model: string) {
  const next = { ...(await readImageModels(rootDir)), [provider]: model.trim() || IMAGE_MODEL_DEFAULTS[provider] };
  await updateAppSettings(rootDir, { imageModels: next });
  return next;
}

/** Image-output models a provider offers, for the picker. */
export async function listImageModels(provider: ImageModelProvider): Promise<string[]> {
  if (provider === "openrouter") return listOpenRouterModels("image");
  if (provider === "cloudflare") return listCloudflareModels(undefined, "Text-to-Image");
  const key = (await readKey(provider))?.key;
  if (!key) throw new Error("No API key saved. Add one in Settings → Image providers.");
  if (provider === "gemini") return listGeminiImageModels(key);
  // dall-e models take different quality values and no edits with several references.
  return (await listOpenAIModels(key)).filter((id) => id.startsWith("gpt-image"));
}
