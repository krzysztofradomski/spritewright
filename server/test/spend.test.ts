import { expect, test } from "vitest";
import { DEFAULT_OPENROUTER_IMAGE_COST_USD, estimateCost, PAID_IMAGE_COSTS, spendLimitProblem, summarizeSpend } from "../spend.js";

const now = new Date("2026-09-15T12:00:00");
const job = (fields: { state: string; costUsd?: number; createdAt?: string; provider?: string }) => ({
  provider: "openrouter",
  createdAt: "2026-09-15T09:00:00",
  ...fields,
});

test("estimates each provider from its own real costs once jobs have reported them", () => {
  expect(estimateCost([], "openrouter")).toBe(DEFAULT_OPENROUTER_IMAGE_COST_USD);
  const jobs = [job({ state: "completed", costUsd: 0.03 }), job({ state: "completed", costUsd: 0.05 }), job({ state: "completed", costUsd: 0.2 })];
  expect(estimateCost(jobs, "openrouter")).toBe(0.05);
  // Another provider's history never leaks into this one's estimate.
  expect(estimateCost(jobs, "cloudflare")).toBe(PAID_IMAGE_COSTS.cloudflare);
});

test("counts each provider's spending against its own limit", () => {
  const jobs = [
    job({ state: "completed", costUsd: 0.5 }),
    job({ state: "completed", costUsd: 0.5, createdAt: "2026-09-14T09:00:00" }), // yesterday
    job({ state: "queued" }),
    job({ state: "queued", provider: "cloudflare" }),
    job({ state: "completed", provider: "grok" }),
  ];
  const limits = { openrouter: 1, cloudflare: 1 };
  const { openrouter, cloudflare } = summarizeSpend(jobs, limits, now).providers;
  expect(openrouter).toEqual({ limitUsd: 1, spentTodayUsd: 0.5, pendingUsd: 0.5, estimateUsd: 0.5 });
  expect(cloudflare).toMatchObject({ limitUsd: 1, spentTodayUsd: 0, pendingUsd: PAID_IMAGE_COSTS.cloudflare });
  expect(spendLimitProblem(jobs, ["grok"], limits, now)).toBeNull();
  expect(spendLimitProblem(jobs, ["openrouter"], limits, now, { openrouter: "OpenRouter" })).toContain("Daily OpenRouter limit of $1.00");
  // OpenRouter being full doesn't block Cloudflare, which still has room under its own limit.
  expect(spendLimitProblem(jobs, ["cloudflare"], limits, now)).toBeNull();
  expect(spendLimitProblem(jobs, ["openrouter"], { ...limits, openrouter: 2 }, now)).toBeNull();
});
