import { readAppSettings, updateAppSettings } from "./app-settings.js";
import { CLOUDFLARE_IMAGE_COST_USD } from "./cloudflare.js";
import { GEMINI_IMAGE_COST_USD } from "./gemini.js";
import { OPENAI_IMAGE_COST_USD } from "./openai.js";

// ponytail: rough list price for one google/gemini-2.5-flash-image render on OpenRouter, used only
// until a real job has reported its cost; after that the median of actual costs replaces it.
export const DEFAULT_OPENROUTER_IMAGE_COST_USD = 0.04;
export const DEFAULT_DAILY_LIMIT_USD = 2;

/** Every generator that bills per image, with what one image costs before any job has reported. */
export const PAID_IMAGE_COSTS: Record<string, number> = {
  openrouter: DEFAULT_OPENROUTER_IMAGE_COST_USD,
  gemini: GEMINI_IMAGE_COST_USD,
  openai: OPENAI_IMAGE_COST_USD,
  cloudflare: CLOUDFLARE_IMAGE_COST_USD,
};

export type SpendJob = { provider?: string; state: string; createdAt: string; costUsd?: number };
export type ProviderSpend = { limitUsd: number; spentTodayUsd: number; pendingUsd: number; estimateUsd: number };
/** Today's spending, one entry per paid provider. */
export type SpendSummary = { providers: Record<string, ProviderSpend> };
export type DailyLimits = Record<string, number>;

export const isPaidProvider = (provider?: string) => provider !== undefined && provider in PAID_IMAGE_COSTS;
const sameLocalDay = (iso: string, now: Date) => new Date(iso).toDateString() === now.toDateString();

/** Median of what this provider's finished jobs actually cost; its list price until there are any. */
export function estimateCost(jobs: SpendJob[], provider: string) {
  const costs = jobs.filter((job) => job.provider === provider && (job.costUsd ?? 0) > 0).map((job) => job.costUsd!).sort((a, b) => a - b);
  if (!costs.length) return PAID_IMAGE_COSTS[provider] ?? 0;
  const middle = Math.floor(costs.length / 2);
  return costs.length % 2 ? costs[middle]! : (costs[middle - 1]! + costs[middle]!) / 2;
}

export function summarizeSpend(jobs: SpendJob[], limits: DailyLimits, now = new Date()): SpendSummary {
  return {
    providers: Object.fromEntries(Object.keys(PAID_IMAGE_COSTS).map((provider) => {
      const estimateUsd = estimateCost(jobs, provider);
      const today = jobs.filter((job) => job.provider === provider && sameLocalDay(job.createdAt, now));
      return [provider, {
        limitUsd: limits[provider] ?? DEFAULT_DAILY_LIMIT_USD,
        spentTodayUsd: today.reduce((total, job) => total + (job.costUsd ?? 0), 0),
        // Jobs not yet charged are reserved at the estimate, so a burst can't overshoot the limit.
        pendingUsd: today.filter((job) => job.state === "queued" || job.state === "running").length * estimateUsd,
        estimateUsd,
      }];
    })),
  };
}

/** Returns why adding jobs on these providers would break one of their daily limits, or null if they fit. */
export function spendLimitProblem(jobs: SpendJob[], providers: Array<string | undefined>, limits: DailyLimits, now = new Date(), labels: Record<string, string> = {}) {
  const counts = new Map<string, number>();
  for (const provider of providers) if (isPaidProvider(provider)) counts.set(provider!, (counts.get(provider!) ?? 0) + 1);
  if (!counts.size) return null;
  const summary = summarizeSpend(jobs, limits, now).providers;
  for (const [provider, count] of counts) {
    const { limitUsd, spentTodayUsd, pendingUsd, estimateUsd } = summary[provider]!;
    const adding = count * estimateUsd;
    if (spentTodayUsd + pendingUsd + adding <= limitUsd + 1e-9) continue;
    return `Daily ${labels[provider] ?? provider} limit of $${limitUsd.toFixed(2)} would be exceeded: $${spentTodayUsd.toFixed(2)} spent and $${pendingUsd.toFixed(2)} queued today, and this adds about $${adding.toFixed(2)}. Raise the limit in Settings or wait until tomorrow.`;
  }
  return null;
}

const validLimit = (value: unknown): value is number => typeof value === "number" && value >= 0;

/** Every paid provider's limit; OpenRouter falls back to the single limit this app used to have. */
export async function readDailyLimits(rootDir: string): Promise<DailyLimits> {
  const settings = await readAppSettings(rootDir);
  return Object.fromEntries(Object.keys(PAID_IMAGE_COSTS).map((provider) => {
    const saved = settings.dailyLimitsUsd?.[provider];
    const legacy = provider === "openrouter" ? settings.openRouterDailyLimitUsd : undefined;
    return [provider, validLimit(saved) ? saved : validLimit(legacy) ? legacy : DEFAULT_DAILY_LIMIT_USD];
  }));
}

export async function writeDailyLimit(rootDir: string, provider: string, limitUsd: number) {
  const limits = { ...(await readDailyLimits(rootDir)), [provider]: limitUsd };
  await updateAppSettings(rootDir, { dailyLimitsUsd: limits });
  return limits;
}
