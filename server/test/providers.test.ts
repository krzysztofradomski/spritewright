import { expect, test } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { antigravityImageQuota, interpretProbe, openRouterQuota, parseCodexLimits, planGenerator, type ProviderStatus } from "../providers.js";

test("reads Codex rate-limit windows and flags a spent weekly limit", () => {
  const { quota, limited } = parseCodexLimits({
    rateLimits: {
      primary: { usedPercent: 0, windowDurationMins: 300, resetsAt: 1789444567 },
      secondary: { usedPercent: 100, windowDurationMins: 10080, resetsAt: 1789834538 },
      rateLimitReachedType: "rate_limit_reached",
    },
  });
  expect(quota.map((window) => window.label)).toEqual(["5-hour window", "7-day window"]);
  expect(quota[1]).toMatchObject({ usedPercent: 100, resetsAt: "2026-09-19T16:15:38.000Z" });
  expect(limited).toBe(true);
});

test("turns test-request output into a provider state", () => {
  const grokExhausted = '{"type":"error","message":"Internal error: {\\n  \\"message\\": \\"API error (status 402 Payment Required): Grok Build usage balance exhausted\\",\\n  \\"http_status\\": 402\\n}"}';
  expect(interpretProbe("grok", { code: 1, output: grokExhausted })).toMatchObject({
    state: "limited",
    detail: "API error (status 402 Payment Required): Grok Build usage balance exhausted",
  });
  expect(interpretProbe("antigravity", { code: 0, output: '{"status":"SUCCESS","response":"ok"}' }).state).toBe("ready");
  expect(interpretProbe("grok", { code: 1, output: "You are not authenticated." }).state).toBe("unavailable");
});

test("shows OpenRouter credit in dollars and flags an empty balance", () => {
  const healthy = openRouterQuota({ keyLimit: null, keyUsage: 8.16, keyRemaining: null, totalCredits: 10, totalUsage: 8.16 });
  expect(healthy).toEqual({ exhausted: false, quota: [{ label: "Account credit", usedPercent: 82, remaining: "$1.84 of $10.00 left" }] });
  const capped = openRouterQuota({ keyLimit: 5, keyUsage: 5, keyRemaining: 0, totalCredits: null, totalUsage: null });
  expect(capped.exhausted).toBe(true);
  expect(capped.quota[0]).toMatchObject({ label: "Key spending limit", remaining: "$0.00 of $5.00 left" });
});

test("finds an unexpired Antigravity image-quota error in its conversation logs", async () => {
  const brain = await mkdtemp(join(tmpdir(), "asset-studio-brain-"));
  const write = async (conversation: string, body: string) => {
    const dir = join(brain, conversation, ".system_generated", "steps", "2");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "output.txt"), body);
  };
  const quotaError = (model: string, resetsAt: string) =>
    `Encountered error in step execution: failed to generate content: 429 Too Many Requests, body: {"error": {"code": 429, "message": "You have exhausted your capacity on this model.", "status": "RESOURCE_EXHAUSTED", "details": [{"reason": "QUOTA_EXHAUSTED", "metadata": {"model": "${model}", "quotaResetTimeStamp": "${resetsAt}"}}]}}`;
  try {
    await write("text-only", quotaError("gemini-3.7-flash-low", "2999-01-01T00:00:00Z"));
    await write("expired", quotaError("gemini-3.1-flash-image", "2000-01-01T00:00:00Z"));
    expect(await antigravityImageQuota(brain)).toBeNull();
    await write("current", quotaError("gemini-3.1-flash-image", "2999-01-01T00:00:00Z"));
    expect(await antigravityImageQuota(brain)).toMatchObject({ model: "gemini-3.1-flash-image", resetsAt: "2999-01-01T00:00:00Z" });
  } finally {
    await rm(brain, { recursive: true, force: true });
  }
});

test("reroutes a job to the next free generator with quota, never to a paid one", async () => {
  const provider = (id: ProviderStatus["id"], state: ProviderStatus["state"]): ProviderStatus =>
    ({ id, label: id, role: "", state, summary: `${id} is ${state}`, details: [], canProbe: false, checkedAt: new Date().toISOString() });
  const imageOut = async () => ({ model: "gemini-3.1-flash-image", resetsAt: "2999-01-01T00:00:00Z", message: "" });
  const grokOut = async () => provider("grok", "limited");

  // Antigravity out of images but Codex fine: delegate.sh still works through its fallback.
  expect(await planGenerator("/unused", "delegate-antigravity", { imageQuota: imageOut, codex: async () => provider("codex", "ready"), grokProbe: grokOut }))
    .toEqual({ provider: "delegate-antigravity" });
  // Antigravity and Codex out, Grok untested: move to Grok and say why.
  const moved = await planGenerator("/unused", "delegate-antigravity", { imageQuota: imageOut, codex: async () => provider("codex", "limited"), grokProbe: async () => undefined });
  expect(moved).toMatchObject({ provider: "grok" });
  expect("note" in moved && moved.note).toContain("Switched from Antigravity to Grok Build");
  // Everything free is out: fail fast rather than switching to OpenRouter.
  const none = await planGenerator("/unused", "grok", { imageQuota: imageOut, codex: async () => provider("codex", "limited"), grokProbe: grokOut });
  expect(none).toMatchObject({ error: expect.stringContaining("No free image generator") });
  // A paid request is left alone.
  expect(await planGenerator("/unused", "openrouter")).toEqual({ provider: "openrouter" });
});
