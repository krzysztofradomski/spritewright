import { spawn } from "node:child_process";
import { access, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { listAnthropicModels } from "./anthropic.js";
import { describeKey, readKey, type KeyInfo } from "./api-keys.js";
import { CLOUDFLARE_IMAGE_COST_USD, listCloudflareModels } from "./cloudflare.js";
import { COMFYUI_HOST, findComfyDir, inspectComfyUI, pickCheckpoint, pickControlnet } from "./comfyui.js";
import { checkGeminiKey, GEMINI_IMAGE_COST_USD } from "./gemini.js";
import { readImageModels } from "./image-models.js";
import { listOllamaModels, OLLAMA_HOST } from "./ollama.js";
import { listOpenAIModels, OPENAI_IMAGE_COST_USD } from "./openai.js";
import { openRouterCredits, openRouterKey } from "./openrouter.js";

export type ProviderId = "antigravity" | "grok" | "codex" | "claude-cli" | "ollama" | "openrouter" | "gemini" | "openai" | "cloudflare" | "anthropic" | "comfyui";
/** One thing to do before a provider works: a command to run, a page to visit, or both. */
export type SetupStep = { id: string; label: string; command?: string; url?: string; runnable?: boolean };
export type QuotaWindow = { label: string; usedPercent: number; remaining?: string; resetsAt?: string };
export type ProviderStatus = {
  id: ProviderId;
  label: string;
  role: string;
  state: "ready" | "limited" | "unavailable" | "unknown";
  summary: string;
  details: string[];
  quota?: QuotaWindow[];
  /** A test request is the only way to learn this provider's quota; it may spend a little of it. */
  canProbe: boolean;
  /** What is still missing, in order; absent when nothing is. */
  setup?: SetupStep[];
  /** For API-key providers: where the key comes from, never the key. */
  key?: KeyInfo;
  checkedAt: string;
};

const ROLES: Record<ProviderId, { label: string; role: string }> = {
  antigravity: { label: "Antigravity", role: "Default image provider (via delegate.sh)." },
  grok: { label: "Grok Build", role: "Alternative image provider." },
  codex: { label: "Codex", role: "Image provider (imagegen); also Antigravity's fallback." },
  // checkProvider appends the image model chosen in Settings to each paid role.
  openrouter: { label: "OpenRouter", role: "Paid image provider." },
  gemini: { label: "Google AI Studio", role: "Paid image provider, billed by Google." },
  openai: { label: "OpenAI", role: "Paid image provider, medium quality." },
  comfyui: { label: "ComfyUI (local)", role: "Image provider running on this machine: free and private. Redraws each frame of a sprite map with the sd15-openpose-game-asset workflow." },
  cloudflare: { label: "Cloudflare Workers AI", role: "Paid image provider with a free daily allowance; text-to-image only, references are ignored." },
  // No image endpoint: Claude earns its place here by writing prompts and drawing pixel-art SVG.
  anthropic: { label: "Claude API", role: "Paid text provider, billed per prompt: writes prompts and draws the Pixel art (SVG) generator's assets." },
  "claude-cli": { label: "Claude", role: "Text provider on your Claude subscription: writes prompts and draws the Pixel art (SVG) generator's assets." },
  ollama: { label: "Ollama (local)", role: "Text provider running on this machine: free and private, but only as good as the model you pull." },
};

// Only these commands can run from the page; a request names a step id, never a command.
const RUNNABLE: Record<string, { label: string; command: string }> = {
  "codex-install": { label: "Install the Codex CLI", command: "npm install -g @openai/codex" },
  "delegate-install": {
    label: "Install delegate.sh",
    command: "curl -fsSL https://raw.githubusercontent.com/krzysztofradomski/skills/main/install.sh | bash -s delegate",
  },
};
const runnable = (id: keyof typeof RUNNABLE & string): SetupStep => ({ id, ...RUNNABLE[id]!, runnable: true });

export type RunResult = { code: number | null; output: string };

function run(command: string, args: string[], timeoutMs: number): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd: tmpdir(), stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
    child.stdout.on("data", (chunk) => { output += String(chunk); });
    child.stderr.on("data", (chunk) => { output += String(chunk); });
    child.on("error", (error) => { clearTimeout(timer); resolve({ code: null, output: error.message }); });
    child.on("close", (code) => { clearTimeout(timer); resolve({ code, output }); });
  });
}

/** Same lookup order as delegate.sh: PATH first, then the known install location. */
async function locate(command: string, fallback: string) {
  const found = await run("/bin/sh", ["-c", `command -v ${command}`], 5_000);
  if (found.code === 0 && found.output.trim()) return found.output.trim();
  try {
    await access(fallback);
    return fallback;
  } catch {
    return null;
  }
}

const status = (id: ProviderId, fields: Omit<ProviderStatus, "id" | "label" | "role" | "checkedAt">): ProviderStatus => ({
  id, ...ROLES[id], ...fields, checkedAt: new Date().toISOString(),
});

const windowLabel = (minutes: number) =>
  minutes % 1440 === 0 ? `${minutes / 1440}-day window` : minutes % 60 === 0 ? `${minutes / 60}-hour window` : `${minutes}-minute window`;

type CodexWindow = { usedPercent: number; windowDurationMins: number; resetsAt?: number } | null | undefined;
export function parseCodexLimits(result: {
  rateLimits?: { primary?: CodexWindow; secondary?: CodexWindow; rateLimitReachedType?: string | null };
}) {
  const limits = result.rateLimits;
  const quota: QuotaWindow[] = [limits?.primary, limits?.secondary]
    .filter((window): window is NonNullable<CodexWindow> => Boolean(window))
    .map((window) => ({
      label: windowLabel(window.windowDurationMins),
      usedPercent: window.usedPercent,
      ...(window.resetsAt ? { resetsAt: new Date(window.resetsAt * 1000).toISOString() } : {}),
    }));
  const limited = Boolean(limits?.rateLimitReachedType) || quota.some((window) => window.usedPercent >= 100);
  return { quota, limited };
}

type RpcMessage = { id?: number; result?: Record<string, unknown>; error?: { message?: string } };

/** Asks Codex's own app-server for the account and its rate limits; spends nothing. */
async function checkCodex(): Promise<ProviderStatus> {
  const binary = await locate("codex", join(homedir(), ".codex/plugins/.plugin-appserver/codex"));
  const login: SetupStep = { id: "codex-login", label: "Sign in with your ChatGPT account in a terminal", command: "codex login" };
  if (!binary) return status("codex", { state: "unavailable", summary: "Not installed.", details: [], canProbe: false, setup: [runnable("codex-install"), login] });
  const responses = await new Promise<Record<number, RpcMessage>>((resolve) => {
    const child = spawn(binary, ["app-server"], { cwd: tmpdir(), stdio: ["pipe", "pipe", "ignore"] });
    const received: Record<number, RpcMessage> = {};
    const send = (message: object) => child.stdin.write(`${JSON.stringify(message)}\n`);
    const finish = () => { clearTimeout(timer); child.kill(); resolve(received); };
    const timer = setTimeout(finish, 20_000);
    let buffer = "";
    child.on("error", finish);
    child.stdout.on("data", (chunk) => {
      buffer += String(chunk);
      for (let index = buffer.indexOf("\n"); index >= 0; index = buffer.indexOf("\n")) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        let message: RpcMessage;
        try {
          message = JSON.parse(line) as RpcMessage;
        } catch {
          continue;
        }
        if (typeof message.id !== "number") continue;
        received[message.id] = message;
        if (message.id === 1) {
          send({ method: "initialized" });
          send({ id: 2, method: "account/read", params: {} });
          send({ id: 3, method: "account/rateLimits/read" });
        }
        if (received[2] && received[3]) finish();
      }
    });
    send({ id: 1, method: "initialize", params: { clientInfo: { name: "spritewright", version: "1" } } });
  });
  if (!responses[1]) return status("codex", { state: "unknown", summary: "Codex did not answer.", details: [binary], canProbe: false });
  const account = responses[2]?.result?.account as { type?: string; planType?: string } | null | undefined;
  if (!account) return status("codex", { state: "unavailable", summary: "Installed but not signed in.", details: [binary], canProbe: false, setup: [login] });
  const details = [`Signed in with ${account.type === "chatgpt" ? "ChatGPT" : account.type ?? "an account"}${account.planType ? ` (${account.planType} plan)` : ""}.`];
  const limits = responses[3]?.result;
  if (!limits)
    return status("codex", { state: "unknown", summary: "Signed in; quota unavailable.", details: [...details, responses[3]?.error?.message ?? ""].filter(Boolean), canProbe: false });
  const { quota, limited } = parseCodexLimits(limits as Parameters<typeof parseCodexLimits>[0]);
  return status("codex", { state: limited ? "limited" : "ready", summary: limited
    ? `${quota.filter((window) => window.usedPercent >= 100).map((window) => window.label).join(" and ") || "Rate limit"} used up.`
    : "Available.", details, quota, canProbe: false });
}

/** Reads a test request's outcome; both CLIs report quota errors as text. */
export function interpretProbe(id: "antigravity" | "grok", result: RunResult) {
  const text = result.output;
  const succeeded = result.code === 0 && (id === "grok" ? !/"type":"error"/.test(text) : /"status":"SUCCESS"/.test(text));
  if (succeeded) return { state: "ready" as const, summary: "Test request succeeded; quota available.", detail: "" };
  // Errors nest JSON inside a message string; the innermost message is the readable one.
  const innermost = text.replace(/\\"/g, '"').split('"message":').at(-1)?.match(/^\s*"([^"]*)"/)?.[1];
  const message = (innermost ?? text.trim().split("\n").at(-1) ?? "").replace(/\\n\s*/g, " ").slice(0, 300);
  if (/402|usage (balance|limit)|exhausted|quota|429|rate.?limit/i.test(text))
    return { state: "limited" as const, summary: id === "grok" ? "Usage balance exhausted." : "Quota exhausted.", detail: message };
  if (/not authenticated|not logged in|sign in|log in/i.test(text))
    return { state: "unavailable" as const, summary: "Not signed in.", detail: message };
  return { state: "unknown" as const, summary: "Test request failed.", detail: message };
}

export type ImageQuotaError = { model: string; resetsAt: string; message: string };

/** Pulls the model and reset time out of a Cloud Code 429 body, if it is an image-model quota error. */
export function parseImageQuotaError(text: string): ImageQuotaError | null {
  if (!/RESOURCE_EXHAUSTED|QUOTA_EXHAUSTED/.test(text)) return null;
  const model = text.match(/"model":\s*"([^"]*image[^"]*)"/)?.[1];
  const resetsAt = text.match(/"quotaResetTimeStamp":\s*"([^"]+)"/)?.[1];
  if (!model || !resetsAt) return null;
  return { model, resetsAt, message: text.match(/"message":\s*"([^"]+)"/)?.[1] ?? "Quota exhausted." };
}

/**
 * Antigravity never reports image quota, and delegate.sh discards agy's output, but every tool
 * error is kept in ~/.gemini/antigravity-cli/brain. Reading the newest image-quota 429 is free.
 * ponytail: scans conversations touched in the last 3 days; an early quota reset shows as
 * exhausted until the stated reset time passes.
 */
export async function antigravityImageQuota(brainDir = join(homedir(), ".gemini/antigravity-cli/brain")): Promise<ImageQuotaError | null> {
  const cutoff = Date.now() - 3 * 24 * 60 * 60 * 1000;
  let conversations: string[];
  try {
    conversations = await readdir(brainDir);
  } catch {
    return null;
  }
  const found: ImageQuotaError[] = [];
  await Promise.all(conversations.map(async (conversation) => {
    const stepsDir = join(brainDir, conversation, ".system_generated", "steps");
    const touched = await stat(stepsDir).catch(() => null);
    if (!touched || touched.mtimeMs < cutoff) return;
    for (const step of await readdir(stepsDir).catch(() => [] as string[])) {
      const file = join(stepsDir, step, "output.txt");
      const text = await readFile(file, "utf8").catch(() => "");
      const error = parseImageQuotaError(text);
      if (error) found.push(error);
    }
  }));
  // Any error whose reset is still ahead means the quota is out; report the furthest reset.
  return found.filter((error) => Date.parse(error.resetsAt) > Date.now()).sort((a, b) => b.resetsAt.localeCompare(a.resetsAt))[0] ?? null;
}

async function checkAntigravity(probe: boolean): Promise<ProviderStatus> {
  const binary = (await locate("agy", join(homedir(), ".local/bin/agy"))) ?? (await locate("antigravity", "/nonexistent"));
  const delegate = await locate("delegate.sh", join(homedir(), ".local/bin/delegate.sh"));
  const setup = delegate ? [] : [runnable("delegate-install")];
  const signIn: SetupStep = { id: "antigravity-login", label: "Open Antigravity and sign in with the Google account that has your AI plan", url: "https://antigravity.google" };
  if (!binary)
    return status("antigravity", {
      state: "unavailable", summary: "Not installed (agy).", details: [], canProbe: false,
      setup: [{ id: "antigravity-install", label: "Install Google Antigravity, which puts the agy CLI on your PATH", url: "https://antigravity.google" }, signIn, ...setup],
    });
  const details = [delegate ? "delegate.sh found." : "delegate.sh is missing, so image jobs cannot run."];
  const models = await run(binary, ["models"], 30_000);
  const modelCount = models.output.split("\n").filter((line) => line.includes("\t")).length;
  if (models.code !== 0 || !modelCount)
    return status("antigravity", { state: "unavailable", summary: "Installed but not signed in, or offline.", details: [...details, models.output.trim().slice(-300)], canProbe: false, setup: [signIn, ...setup] });
  details.push(`Signed in; ${modelCount} models available.`);
  const imageQuota = await antigravityImageQuota();
  if (imageQuota)
    return status("antigravity", {
      state: "limited",
      summary: "Image generation quota exhausted.",
      details: [...details, `Text models still work; ${imageQuota.model} is what makes images.`],
      quota: [{ label: `Image model (${imageQuota.model})`, usedPercent: 100, resetsAt: imageQuota.resetsAt }],
      canProbe: false,
      ...(setup.length ? { setup } : {}),
    });
  if (!probe)
    return status("antigravity", { state: delegate ? "unknown" : "unavailable", summary: "Signed in, no recent image-quota errors. Antigravity doesn't report quota directly.", details, canProbe: true, ...(setup.length ? { setup } : {}) });
  const test = await run(binary, ["-p", "Reply with just: ok", "--output-format", "json", "--model", "gemini-3.8-flash-low", "--print-timeout", "60s"], 90_000);
  const outcome = interpretProbe("antigravity", test);
  // The test is a text prompt: it proves sign-in and text quota, not image quota.
  const summary = outcome.state === "ready" ? "Text test succeeded, no recent image-quota errors." : outcome.summary;
  return status("antigravity", { state: outcome.state, summary, details: [...details, outcome.detail].filter(Boolean), canProbe: true, ...(setup.length ? { setup } : {}) });
}

async function checkGrok(probe: boolean): Promise<ProviderStatus> {
  const binary = await locate("grok", join(homedir(), ".grok/bin/grok"));
  const login: SetupStep = { id: "grok-login", label: "Sign in with your xAI account in a terminal", command: "grok login" };
  if (!binary)
    return status("grok", { state: "unavailable", summary: "Not installed.", details: [], canProbe: false, setup: [{ id: "grok-install", label: "Install Grok Build so the grok CLI is on your PATH" }, login] });
  let signedIn = false;
  try {
    const auth = JSON.parse(await readFile(join(homedir(), ".grok/auth.json"), "utf8")) as Record<string, { refresh_token?: string } | undefined>;
    signedIn = Object.values(auth).some((entry) => Boolean(entry?.refresh_token));
  } catch {
    signedIn = false;
  }
  if (!signedIn) return status("grok", { state: "unavailable", summary: "Installed but not signed in.", details: [binary], canProbe: false, setup: [login] });
  const details = ["Signed in."];
  if (!probe)
    return status("grok", { state: "unknown", summary: "Signed in. Grok shows credits only in its interactive /usage screen; send a test request to check.", details, canProbe: true });
  const test = await run(binary, ["--output-format", "json", "--single", "Reply with just: ok"], 90_000);
  const outcome = interpretProbe("grok", test);
  return status("grok", { state: outcome.state, summary: outcome.summary, details: [...details, outcome.detail].filter(Boolean), canProbe: true });
}

const dollars = (value: number) => `$${value.toFixed(2)}`;

export function openRouterQuota(credits: Awaited<ReturnType<typeof openRouterCredits>>) {
  const quota: QuotaWindow[] = [];
  if (credits.totalCredits !== null && credits.totalUsage !== null) {
    const left = credits.totalCredits - credits.totalUsage;
    quota.push({
      label: "Account credit",
      usedPercent: credits.totalCredits > 0 ? Math.min(100, Math.round((credits.totalUsage / credits.totalCredits) * 100)) : 100,
      remaining: `${dollars(Math.max(0, left))} of ${dollars(credits.totalCredits)} left`,
    });
  }
  if (credits.keyLimit !== null && credits.keyRemaining !== null)
    quota.push({
      label: "Key spending limit",
      usedPercent: credits.keyLimit > 0 ? Math.min(100, Math.round((credits.keyUsage / credits.keyLimit) * 100)) : 100,
      remaining: `${dollars(Math.max(0, credits.keyRemaining))} of ${dollars(credits.keyLimit)} left`,
    });
  const exhausted = quota.some((window) => window.usedPercent >= 100);
  return { quota, exhausted };
}

async function checkOpenRouter(): Promise<ProviderStatus> {
  const key = await openRouterKey();
  const keyInfo = await describeKey("openrouter");
  if (!key)
    return status("openrouter", {
      state: "unavailable", summary: "No API key yet.", details: [], canProbe: false, key: keyInfo,
      setup: [{ id: "openrouter-key", label: "Create a key and add credit, then paste the key below", url: "https://openrouter.ai/settings/keys" }],
    });
  try {
    const credits = await openRouterCredits(key);
    const { quota, exhausted } = openRouterQuota(credits);
    return status("openrouter", {
      state: exhausted ? "limited" : "ready",
      summary: exhausted ? "Out of credit." : "Key valid. Every image spends credit.",
      details: credits.totalCredits === null ? ["This key can't read the account balance; showing its own limit only."] : [],
      quota,
      canProbe: false,
      key: keyInfo,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return status("openrouter", { state: /401|invalid|unauthor/i.test(message) ? "unavailable" : "unknown", summary: `Key check failed: ${message}`, details: [], canProbe: false, key: keyInfo });
  }
}

async function checkGemini(model: string): Promise<ProviderStatus> {
  const found = await readKey("gemini");
  const keyInfo = await describeKey("gemini");
  const billing: SetupStep = { id: "gemini-billing", label: "Image models aren't on the free tier: enable billing for the key's Google Cloud project", url: "https://aistudio.google.com/usage" };
  if (!found)
    return status("gemini", {
      state: "unavailable", summary: "No API key yet.", details: [], canProbe: false, key: keyInfo,
      setup: [{ id: "gemini-key", label: "Create a key in Google AI Studio, then paste it below", url: "https://aistudio.google.com/apikey" }, billing],
    });
  try {
    const { hasImageModel } = await checkGeminiKey(found.key, model);
    if (!hasImageModel)
      return status("gemini", { state: "unavailable", summary: `Key works, but it can't see ${model}.`, details: [], canProbe: false, key: keyInfo, setup: [billing] });
    return status("gemini", {
      state: "ready",
      summary: `Key valid. Every image costs about ${dollars(GEMINI_IMAGE_COST_USD)}.`,
      details: ["Google doesn't report remaining credit to API keys; see AI Studio for usage and billing."],
      canProbe: false,
      key: keyInfo,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return status("gemini", { state: /api key|invalid|permission|401|403/i.test(message) ? "unavailable" : "unknown", summary: `Key check failed: ${message}`, details: [], canProbe: false, key: keyInfo });
  }
}

const failedKeyCheck = (id: ProviderId, error: unknown, keyInfo: KeyInfo) => {
  const message = error instanceof Error ? error.message : String(error);
  return status(id, { state: /api key|invalid|unauthor|authenticat|permission|401|403/i.test(message) ? "unavailable" : "unknown", summary: `Key check failed: ${message}`, details: [], canProbe: false, key: keyInfo });
};

async function checkOpenAI(model: string): Promise<ProviderStatus> {
  const found = await readKey("openai");
  const keyInfo = await describeKey("openai");
  if (!found)
    return status("openai", {
      state: "unavailable", summary: "No API key yet.", details: [], canProbe: false, key: keyInfo,
      setup: [{ id: "openai-key", label: "Create a key with credit on the account, then paste it below", url: "https://platform.openai.com/api-keys" }],
    });
  try {
    const models = await listOpenAIModels(found.key);
    if (!models.includes(model))
      return status("openai", {
        state: "unavailable", summary: `Key works, but it can't see ${model}.`, details: [], canProbe: false, key: keyInfo,
        setup: [{ id: "openai-verify", label: "Image models need a verified organization", url: "https://platform.openai.com/settings/organization/general" }],
      });
    return status("openai", {
      state: "ready",
      summary: `Key valid. Every image costs about ${dollars(OPENAI_IMAGE_COST_USD)}.`,
      details: ["OpenAI doesn't report remaining credit to API keys; see the billing page."],
      canProbe: false,
      key: keyInfo,
    });
  } catch (error) {
    return failedKeyCheck("openai", error, keyInfo);
  }
}

async function checkCloudflare(): Promise<ProviderStatus> {
  const found = await readKey("cloudflare");
  const keyInfo = await describeKey("cloudflare");
  if (!found)
    return status("cloudflare", {
      state: "unavailable", summary: "No API token yet.", details: [], canProbe: false, key: keyInfo,
      setup: [
        { id: "cloudflare-token", label: "Create an API token with the Workers AI (Read) and (Edit) permissions", url: "https://dash.cloudflare.com/profile/api-tokens" },
        { id: "cloudflare-account", label: "Copy your account ID from the dashboard, then paste <account id>:<token> below", url: "https://dash.cloudflare.com" },
      ],
    });
  try {
    await listCloudflareModels(found.key, "Text-to-Image");
    return status("cloudflare", {
      state: "ready",
      summary: `Token valid. Free up to the daily allowance, then about ${dollars(CLOUDFLARE_IMAGE_COST_USD)} per image.`,
      details: ["Cloudflare doesn't report remaining allowance to tokens; see Workers AI in the dashboard."],
      canProbe: false,
      key: keyInfo,
    });
  } catch (error) {
    return failedKeyCheck("cloudflare", error, keyInfo);
  }
}

async function checkAnthropic(): Promise<ProviderStatus> {
  const found = await readKey("anthropic");
  const keyInfo = await describeKey("anthropic");
  if (!found)
    return status("anthropic", {
      state: "unavailable", summary: "No API key yet.", details: [], canProbe: false, key: keyInfo,
      setup: [{ id: "anthropic-key", label: "Create a key with credit on the account, then paste it below", url: "https://console.anthropic.com/settings/keys" }],
    });
  try {
    const models = await listAnthropicModels(found.key);
    return status("anthropic", {
      state: "ready",
      summary: `Key valid. Billed per prompt; a pixel-art drawing is a long reply, so it costs more than prompt help.`,
      details: [`${models.length} models available.`, "Anthropic doesn't report remaining credit to API keys; see the Console for usage."],
      canProbe: false,
      key: keyInfo,
    });
  } catch (error) {
    return failedKeyCheck("anthropic", error, keyInfo);
  }
}

/** The Claude Code CLI, signed in already if you use it; no key to check, so just locate it. */
async function checkClaudeCli(): Promise<ProviderStatus> {
  const binary = await locate("claude", join(homedir(), ".local/bin/claude"));
  if (!binary)
    return status("claude-cli", {
      state: "unavailable", summary: "Not installed.", details: [], canProbe: false,
      setup: [{ id: "claude-cli-install", label: "Install Claude Code, which puts the claude CLI on your PATH", url: "https://claude.com/product/claude-code" }],
    });
  const version = await run(binary, ["--version"], 15_000);
  if (version.code !== 0)
    return status("claude-cli", { state: "unavailable", summary: "Installed but not answering; sign in with `claude` in a terminal.", details: [binary], canProbe: false });
  return status("claude-cli", {
    state: "ready",
    summary: "Runs on your Claude subscription, so drawings cost no API credit.",
    details: [version.output.trim(), "A 96-cell drawing takes a few minutes; that is the model writing every rect."],
    canProbe: false,
  });
}

/** Local models: nothing to authenticate, so the only questions are whether it's up and stocked. */
async function checkOllama(): Promise<ProviderStatus> {
  const setup: SetupStep[] = [{ id: "ollama-pull", label: "Pull a model, for example: ollama pull gemma3", url: "https://ollama.com/library" }];
  try {
    const models = await listOllamaModels();
    if (!models.length)
      return status("ollama", { state: "unavailable", summary: "Running, but no models pulled yet.", details: [OLLAMA_HOST], canProbe: false, setup });
    return status("ollama", {
      state: "ready",
      summary: `${models.length} model${models.length === 1 ? "" : "s"} available, free and local.`,
      details: [OLLAMA_HOST, models.slice(0, 8).join(", ")],
      canProbe: false,
    });
  } catch (error) {
    return status("ollama", {
      state: "unavailable",
      summary: "Not reachable — start it with `ollama serve`.",
      details: [OLLAMA_HOST, error instanceof Error ? error.message : String(error)],
      canProbe: false,
    });
  }
}

/** Local ComfyUI: nothing to sign in to, so the questions are whether it's running and has what the workflow loads. */
async function checkComfyUI(): Promise<ProviderStatus> {
  const found = await findComfyDir();
  const start: SetupStep = { id: "comfyui-start", label: "Start ComfyUI and leave it running", command: found?.start ?? "comfy launch" };
  let models: Awaited<ReturnType<typeof inspectComfyUI>>;
  try {
    models = await inspectComfyUI();
  } catch (error) {
    return status("comfyui", {
      state: "unavailable",
      summary: found ? `Installed but not running at ${COMFYUI_HOST}.` : `Not found. Nothing answers at ${COMFYUI_HOST} and no install was located.`,
      details: [found ? `Install: ${found.root}` : "Looked in COMFYUI_DIR, ~/code/comfy, ~/comfy, ~/ComfyUI.", error instanceof Error ? error.message : String(error)],
      canProbe: false,
      setup: found
        ? [start]
        : [{ id: "comfyui-install", label: "Install ComfyUI (comfy-cli sets up Python and the app), or set COMFYUI_DIR if it lives elsewhere", command: "pip install comfy-cli && comfy install", url: "https://docs.comfy.org/installation" }, start],
    });
  }
  const checkpoint = pickCheckpoint(models.checkpoints);
  const controlnet = pickControlnet(models.controlnets);
  const modelsDir = join(found?.root ?? "<ComfyUI folder>", "models");
  const setup: SetupStep[] = [];
  if (!models.hasOpenposeNode)
    setup.push({ id: "comfyui-openpose-node", label: "Install the ControlNet preprocessors custom node, then restart ComfyUI", command: "comfy node install comfyui_controlnet_aux", url: "https://github.com/Fannovel16/comfyui_controlnet_aux" });
  if (!checkpoint)
    setup.push({ id: "comfyui-checkpoint", label: `Put an SD 1.5 checkpoint such as dreamshaper_8.safetensors in ${join(modelsDir, "checkpoints")}`, url: "https://huggingface.co/Lykon/dreamshaper-8" });
  if (!controlnet)
    setup.push({
      id: "comfyui-controlnet",
      label: "Download the SD 1.5 OpenPose ControlNet",
      command: `curl -L -o "${join(modelsDir, "controlnet/control_v11p_sd15_openpose_fp16.safetensors")}" https://huggingface.co/comfyanonymous/ControlNet-v1-1_fp16_safetensors/resolve/main/control_v11p_sd15_openpose_fp16.safetensors`,
    });
  if (setup.length)
    return status("comfyui", { state: "unavailable", summary: "Running, but the workflow can't load yet.", details: [COMFYUI_HOST], canProbe: false, setup });
  return status("comfyui", {
    state: "ready",
    summary: "Running with everything the sd15-openpose-game-asset workflow needs; free and local.",
    details: [COMFYUI_HOST, `${checkpoint} + ${controlnet}`, "It redraws the frames of a sprite map; the movement comes from the source poses."],
    canProbe: false,
  });
}

const PROBE_TTL_MS = 60 * 60 * 1000;
const probesPath = (rootDir: string) => join(rootDir, "data/provider-tests.json");
async function readProbes(rootDir: string): Promise<Partial<Record<"antigravity" | "grok", ProviderStatus>>> {
  try {
    return JSON.parse(await readFile(probesPath(rootDir), "utf8")) as Partial<Record<"antigravity" | "grok", ProviderStatus>>;
  } catch {
    return {};
  }
}

/** A free check can't see Antigravity/Grok quota, so reuse a test request from the last hour. */
function withLastProbe(probe: ProviderStatus | undefined, fresh: ProviderStatus) {
  if (fresh.state === "unavailable" || fresh.state === "limited" || !probe || Date.now() - Date.parse(probe.checkedAt) > PROBE_TTL_MS) return fresh;
  return { ...fresh, state: probe.state, summary: `${probe.summary} (tested ${new Date(probe.checkedAt).toLocaleTimeString()})`, details: probe.details };
}

export const PROVIDER_IDS: ProviderId[] = ["antigravity", "grok", "codex", "claude-cli", "ollama", "openrouter", "gemini", "openai", "cloudflare", "anthropic", "comfyui"];

/** Checks one provider for free; reuses a recent test request where one exists. */
export async function checkProvider(rootDir: string, id: ProviderId): Promise<ProviderStatus> {
  if (id === "codex") return checkCodex();
  if (id === "comfyui") return checkComfyUI();
  // Text-only, so these have no image model to append to their role.
  if (id === "anthropic") return checkAnthropic();
  if (id === "claude-cli") return checkClaudeCli();
  if (id === "ollama") return checkOllama();
  if (id === "openrouter" || id === "gemini" || id === "openai" || id === "cloudflare") {
    const model = (await readImageModels(rootDir))[id];
    const checked = await { openrouter: checkOpenRouter, gemini: () => checkGemini(model), openai: () => checkOpenAI(model), cloudflare: checkCloudflare }[id]();
    return { ...checked, role: `${checked.role} Model: ${model}.` };
  }
  const [fresh, probes] = await Promise.all([id === "grok" ? checkGrok(false) : checkAntigravity(false), readProbes(rootDir)]);
  return withLastProbe(probes[id], fresh);
}

export const checkProviders = (rootDir: string) => Promise.all(PROVIDER_IDS.map((id) => checkProvider(rootDir, id)));

/** Runs one allow-listed setup command and returns the tail of its output. */
export async function runSetupStep(stepId: string) {
  const step = RUNNABLE[stepId];
  if (!step) return null;
  // A login shell, so npm and ~/.local/bin resolve the same way they do in a terminal.
  const result = await run(process.env.SHELL || "/bin/zsh", ["-lc", step.command], 10 * 60 * 1000);
  return { ok: result.code === 0, output: result.output.trim().split("\n").slice(-15).join("\n") };
}

export async function probeProvider(rootDir: string, id: "antigravity" | "grok") {
  const result = id === "grok" ? await checkGrok(true) : await checkAntigravity(true);
  if (result.canProbe) {
    const path = probesPath(rootDir);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify({ ...(await readProbes(rootDir)), [id]: result }, null, 2));
  }
  return result;
}

export type FreeGenerator = "delegate-antigravity" | "codex" | "grok";
const FREE_GENERATORS: FreeGenerator[] = ["delegate-antigravity", "codex", "grok"];
const GENERATOR_LABELS: Record<FreeGenerator, string> = { "delegate-antigravity": "Antigravity", codex: "Codex", grok: "Grok Build" };

type PlanLookups = {
  codex: () => Promise<ProviderStatus>;
  imageQuota: () => Promise<ImageQuotaError | null>;
  grokProbe: () => Promise<ProviderStatus | undefined>;
};

/**
 * Why a free generator can't produce an image right now, from free signals only, or null.
 * Antigravity counts as blocked only when its Codex fallback is out too, since delegate.sh
 * would otherwise still succeed through Codex.
 */
async function freeGeneratorBlocker(generator: FreeGenerator, lookups: PlanLookups): Promise<string | null> {
  if (generator === "grok") {
    const probe = await lookups.grokProbe();
    const fresh = probe && Date.now() - Date.parse(probe.checkedAt) <= PROBE_TTL_MS;
    return fresh && (probe.state === "limited" || probe.state === "unavailable") ? `Grok Build: ${probe.summary}` : null;
  }
  const codexStatus = await lookups.codex();
  const codexBlocked = codexStatus.state === "limited" || codexStatus.state === "unavailable" ? `Codex: ${codexStatus.summary}` : null;
  if (generator === "codex") return codexBlocked;
  const image = await lookups.imageQuota();
  return image && codexBlocked ? `Antigravity image quota exhausted until ${new Date(image.resetsAt).toLocaleString()}; ${codexBlocked}` : null;
}

export type GeneratorPlan = { provider: string; note?: string } | { error: string };

/**
 * Picks the generator a job should actually run on. Keeps its own choice when usable, otherwise
 * moves to the next free generator that isn't known to be exhausted. Paid providers are never
 * chosen automatically, and a job that asked for one keeps it (its spending guard already ran).
 */
export async function planGenerator(rootDir: string, requested: string, overrides: Partial<PlanLookups> = {}): Promise<GeneratorPlan> {
  if (!FREE_GENERATORS.includes(requested as FreeGenerator)) return { provider: requested };
  let codexStatus: Promise<ProviderStatus> | undefined;
  const lookups: PlanLookups = {
    codex: () => (codexStatus ??= (overrides.codex ?? checkCodex)()),
    imageQuota: overrides.imageQuota ?? (() => antigravityImageQuota()),
    grokProbe: overrides.grokProbe ?? (async () => (await readProbes(rootDir)).grok),
  };
  const blocker = await freeGeneratorBlocker(requested as FreeGenerator, lookups);
  if (!blocker) return { provider: requested };
  const reasons = [blocker];
  for (const candidate of FREE_GENERATORS.filter((generator) => generator !== requested)) {
    const candidateBlocker = await freeGeneratorBlocker(candidate, lookups);
    if (!candidateBlocker)
      return { provider: candidate, note: `Switched from ${GENERATOR_LABELS[requested as FreeGenerator]} to ${GENERATOR_LABELS[candidate]}: ${blocker}` };
    reasons.push(candidateBlocker);
  }
  return { error: `No free image generator has quota right now. ${[...new Set(reasons)].join(" · ")}. Choose a paid provider or retry after a reset.` };
}
