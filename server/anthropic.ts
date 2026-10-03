import Anthropic from "@anthropic-ai/sdk";
import { readKey } from "./api-keys.js";

export const ANTHROPIC_DEFAULT_MODEL = "claude-opus-5";
/**
 * Pixel art is one long reply — thousands of rects — so every call streams and asks for room.
 * Streaming is not a nicety here: a buffered reply sends no bytes until it finishes, and the
 * HTTP client gives up long before that.
 */
const MAX_TOKENS = 64_000;

async function client() {
  const key = (await readKey("anthropic"))?.key;
  if (!key) throw new Error("No Anthropic key. Add one in Settings → Image providers.");
  return new Anthropic({ apiKey: key });
}

/** Lists models, which is free, to prove the key works; returns the model ids it can use. */
export async function listAnthropicModels(key: string) {
  const models = await new Anthropic({ apiKey: key }).models.list({ limit: 100 });
  return models.data.map((model) => model.id);
}

/** One prompt, one reply. Thinking is left adaptive, which is the default on current models. */
export async function anthropicText(model: string, prompt: string, signal: AbortSignal) {
  const stream = (await client()).messages.stream(
    { model: model || ANTHROPIC_DEFAULT_MODEL, max_tokens: MAX_TOKENS, messages: [{ role: "user", content: prompt }] },
    { signal },
  );
  const message = await stream.finalMessage();
  if (message.stop_reason === "refusal")
    throw new Error(`Claude declined this request (${message.stop_details?.category ?? "no category"}).`);
  return message.content
    .filter((block): block is Anthropic.TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("");
}
