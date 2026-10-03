/** A model served by Ollama on this machine. No key, no billing, no request leaves the box. */
export const OLLAMA_HOST = process.env.OLLAMA_HOST ?? "http://localhost:11434";
/**
 * Ollama defaults to a small context and silently truncates past it, which for pixel art means a
 * drawing that stops mid-tag. Big enough for a 64-cell drawing and its prompt; raise it for a
 * finer grid, but the model has to have the room.
 */
const NUM_CTX = Number(process.env.OLLAMA_NUM_CTX ?? 16_384);

async function ollama(path: string, init: RequestInit = {}) {
  const response = await fetch(`${OLLAMA_HOST}${path}`, init);
  if (!response.ok) throw new Error(`Ollama ${path} failed (HTTP ${response.status}): ${(await response.text()).slice(0, 200)}`);
  return response;
}

/** Model names this machine has pulled; empty when Ollama is running but has none yet. */
export async function listOllamaModels() {
  const response = await ollama("/api/tags", { signal: AbortSignal.timeout(10_000) });
  const { models } = (await response.json()) as { models?: Array<{ name: string }> };
  return (models ?? []).map((model) => model.name).sort();
}

/**
 * One prompt, one reply, streamed. Streaming is required rather than tidy: a buffered reply sends
 * no bytes until the model finishes, and fetch gives up after 300s of silence — which a local
 * model drawing pixel art will always exceed.
 */
export async function ollamaText(model: string, prompt: string, signal: AbortSignal) {
  const response = await ollama("/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: prompt }],
      stream: true,
      options: { num_ctx: NUM_CTX, num_predict: -1 },
    }),
    signal,
  });
  if (!response.body) throw new Error("Ollama returned no response body.");
  let reply = "";
  let buffer = "";
  // /api/chat streams newline-delimited JSON, one object per token batch.
  for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
    buffer += Buffer.from(chunk).toString("utf8");
    for (let nl = buffer.indexOf("\n"); nl >= 0; nl = buffer.indexOf("\n")) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      const event = JSON.parse(line) as { message?: { content?: string }; error?: string };
      if (event.error) throw new Error(`Ollama: ${event.error}`);
      reply += event.message?.content ?? "";
    }
  }
  return reply;
}
