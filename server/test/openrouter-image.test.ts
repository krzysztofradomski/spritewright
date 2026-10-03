import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nearestAspectRatio, runOpenRouter } from "../openrouter.js";

const PIXEL = Buffer.from("89504e470d0a1a0a", "hex").toString("base64");
let dir = "";
let output = "";

beforeEach(async () => {
  process.env.OPENROUTER_API_KEY = "test-key";
  dir = await mkdtemp(join(tmpdir(), "openrouter-"));
  output = join(dir, "out.png");
});
afterEach(async () => {
  delete process.env.OPENROUTER_API_KEY;
  vi.unstubAllGlobals();
  await rm(dir, { recursive: true, force: true });
});

const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

test("generates through the images endpoint, which every image model accepts", async () => {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  vi.stubGlobal("fetch", vi.fn((url: string, init: RequestInit) => {
    calls.push({ url: String(url), body: JSON.parse(String(init.body)) as Record<string, unknown> });
    return Promise.resolve(reply({ data: [{ b64_json: PIXEL }], usage: { cost: 0.031 } }));
  }));

  const result = await runOpenRouter("a reed", output, [], AbortSignal.timeout(5_000), "openai/gpt-image-2", { width: 2048, height: 1536 });

  expect(calls[0]?.url).toBe("https://openrouter.ai/api/v1/images");
  // A sheet asked for in a ratio the model doesn't offer comes back square, with an invented grid.
  expect(calls[0]?.body).toMatchObject({ model: "openai/gpt-image-2", prompt: "a reed", aspect_ratio: "4:3" });
  expect(nearestAspectRatio(2048 / 1024)).toBe("16:9");
  expect(result.costUsd).toBe(0.031);
  expect((await readFile(output)).toString("base64")).toBe(PIXEL);
});

test("falls back to chat for models the images endpoint doesn't serve", async () => {
  const urls: string[] = [];
  vi.stubGlobal("fetch", vi.fn((url: string) => {
    urls.push(String(url));
    return Promise.resolve(
      String(url).endsWith("/images")
        ? reply({ error: { message: "model is not supported on this endpoint" } }, 400)
        : reply({ choices: [{ message: { images: [{ image_url: { url: `data:image/png;base64,${PIXEL}` } }] } }], usage: { cost: 0.04 } }),
    );
  }));

  const result = await runOpenRouter("a reed", output, [], AbortSignal.timeout(5_000));

  expect(urls).toEqual(["https://openrouter.ai/api/v1/images", "https://openrouter.ai/api/v1/chat/completions"]);
  expect(result.costUsd).toBe(0.04);
});

test("reports a real failure instead of retrying it on the other endpoint", async () => {
  const fetchMock = vi.fn(() => Promise.resolve(reply({ error: { message: "No auth credentials found" } }, 401)));
  vi.stubGlobal("fetch", fetchMock);

  await expect(runOpenRouter("a reed", output, [], AbortSignal.timeout(5_000))).rejects.toThrow(/No auth credentials/);
  expect(fetchMock).toHaveBeenCalledTimes(1);
});
