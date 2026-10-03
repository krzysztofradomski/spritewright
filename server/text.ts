import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { ANTHROPIC_DEFAULT_MODEL, anthropicText, listAnthropicModels } from "./anthropic.js";
import { readKey } from "./api-keys.js";
import { readAppSettings, updateAppSettings } from "./app-settings.js";
import { cloudflareText, listCloudflareModels } from "./cloudflare.js";
import { geminiText, listGeminiTextModels } from "./gemini.js";
import { listOpenAIModels, openAIText } from "./openai.js";
import { listOllamaModels, ollamaText } from "./ollama.js";
import { listOpenRouterModels, openRouterText } from "./openrouter.js";

export type TextProviderId = "antigravity" | "codex" | "claude-cli" | "ollama" | "openrouter" | "gemini" | "openai" | "cloudflare" | "anthropic";

export const CLAUDE_CLI_DEFAULT_MODEL = "claude-opus-5";
/** Models the CLI accepts; it has no list command, so this is the current family. */
export const CLAUDE_CLI_MODELS = ["claude-opus-5", "claude-sonnet-5", "claude-haiku-4-5", "claude-opus-4-8", "claude-fable-5-1"];
export type TextModelChoice = { provider: TextProviderId; model: string };

/** Everything that can write a prompt. Plan providers cost nothing extra; API ones bill per call. */
export const TEXT_PROVIDERS: Array<{ id: TextProviderId; label: string; defaultModel: string; paid: boolean }> = [
  // Same model delegate.sh's "cheap" tier uses, which is what prompt help ran on before this setting.
  { id: "antigravity", label: "Antigravity", defaultModel: "gemini-3.7-flash-low", paid: false },
  { id: "codex", label: "Codex", defaultModel: "", paid: false },
  // The Claude Code CLI, on your Claude subscription — same models as the API, no key, no billing.
  { id: "claude-cli", label: "Claude", defaultModel: CLAUDE_CLI_DEFAULT_MODEL, paid: false },
  // Local, so it costs nothing and needs no key — but only as good as the model that's pulled.
  { id: "ollama", label: "Ollama (local)", defaultModel: "", paid: false },
  { id: "openrouter", label: "OpenRouter", defaultModel: "google/gemini-2.5-flash", paid: true },
  { id: "gemini", label: "Google AI Studio", defaultModel: "gemini-2.5-flash", paid: true },
  { id: "openai", label: "OpenAI", defaultModel: "gpt-4.1-mini", paid: true },
  { id: "cloudflare", label: "Cloudflare Workers AI", defaultModel: "@cf/meta/llama-3.3-70b-instruct-fp8-fast", paid: true },
  { id: "anthropic", label: "Claude", defaultModel: ANTHROPIC_DEFAULT_MODEL, paid: true },
];
export const TEXT_PROVIDER_IDS = TEXT_PROVIDERS.map((provider) => provider.id) as [TextProviderId, ...TextProviderId[]];

const TEXT_TIMEOUT_MS = 3 * 60 * 1000;
/** Drawing hundreds of rects takes far longer than writing a prompt, so pixel art gets its own. */
export const PIXEL_TIMEOUT_MS = 10 * 60 * 1000;

/** Prompt help and pixel-art drawing each pick their own model, from the same provider list. */
export type TextModelRole = "prompt" | "pixel";
export const TEXT_MODEL_ROLES = ["prompt", "pixel"] as const;
const ROLE_SETTING = { prompt: "textModel", pixel: "pixelModel" } as const;

export async function readTextModel(rootDir: string, role: TextModelRole = "prompt"): Promise<TextModelChoice> {
  const saved = (await readAppSettings(rootDir))[ROLE_SETTING[role]];
  const provider = TEXT_PROVIDERS.find((item) => item.id === saved?.provider) ?? TEXT_PROVIDERS[0]!;
  return { provider: provider.id, model: saved?.provider === provider.id ? saved.model : provider.defaultModel };
}

export const writeTextModel = (rootDir: string, choice: TextModelChoice, role: TextModelRole = "prompt") =>
  updateAppSettings(rootDir, { [ROLE_SETTING[role]]: choice }).then(() => choice);

/** Runs a CLI and resolves with its stdout; stderr only goes into the error. */
function runCli(command: string, args: string[], env: NodeJS.ProcessEnv = {}, timeoutMs = TEXT_TIMEOUT_MS) {
  return new Promise<string>((resolve, reject) => {
    const child = spawn(command, args, { cwd: tmpdir(), stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, ...env } });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout);
      else reject(new Error(`exited ${code}: ${(stderr || stdout).trim().slice(-1000)}`));
    });
  });
}

/**
 * The Claude Code CLI in print mode, spending the Claude subscription rather than API credit.
 * Tools are denied: this asks for one block of text, and an agent that can touch the filesystem
 * would be free to go and do something with it.
 */
function runClaudeCli(model: string, prompt: string, timeoutMs: number) {
  return runCli(
    "claude",
    ["-p", prompt, "--output-format", "text", "--model", model || CLAUDE_CLI_DEFAULT_MODEL,
     "--disallowed-tools", "Bash", "Read", "Write", "Edit", "WebFetch", "WebSearch"],
    {},
    timeoutMs,
  );
}

const codexBinary = () => {
  const fallback = join(homedir(), ".codex/plugins/.plugin-appserver/codex");
  return stat(fallback).then(() => fallback, () => "codex");
};

async function runCodexText(model: string, prompt: string, timeoutMs: number) {
  const dir = await mkdtemp(join(tmpdir(), "studio-text-"));
  const answer = join(dir, "answer.txt");
  try {
    await runCli(await codexBinary(), [
      "exec", "--sandbox", "read-only", "--skip-git-repo-check", "-C", dir,
      ...(model ? ["-m", model] : []), "--output-last-message", answer, "--", prompt,
    ], {}, timeoutMs);
    return await readFile(answer, "utf8");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Sends one prompt to the chosen text model and returns its reply. */
export async function runText(choice: TextModelChoice, prompt: string, timeoutMs = TEXT_TIMEOUT_MS) {
  const signal = AbortSignal.timeout(timeoutMs);
  const label = TEXT_PROVIDERS.find((item) => item.id === choice.provider)?.label ?? choice.provider;
  try {
    const text = await {
      // delegate.sh caps its own CLI calls at DELEGATE_TIMEOUT (240s default), so raising only our
      // timeout does nothing: a long pixel-art draw dies at 4 minutes with "error: interrupted".
      antigravity: () => runCli("delegate.sh", ["agy", prompt, tmpdir()], { AGY_MODEL: choice.model, DELEGATE_TIMEOUT: String(Math.ceil(timeoutMs / 1000)) }, timeoutMs),
      codex: () => runCodexText(choice.model, prompt, timeoutMs),
      "claude-cli": () => runClaudeCli(choice.model, prompt, timeoutMs),
      ollama: () => ollamaText(choice.model, prompt, signal),
      openrouter: () => openRouterText(choice.model, prompt, signal),
      gemini: () => geminiText(choice.model, prompt, signal),
      openai: () => openAIText(choice.model, prompt, signal),
      cloudflare: () => cloudflareText(choice.model, prompt, signal),
      anthropic: () => anthropicText(choice.model, prompt, signal),
    }[choice.provider]();
    if (!text.trim()) throw new Error("returned an empty reply");
    return text.trim();
  } catch (error) {
    throw new Error(`Text model ${label}${choice.model ? ` (${choice.model})` : ""} failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Model ids a provider offers, for the picker; empty when it can't be asked. */
export async function listTextModels(provider: TextProviderId): Promise<string[]> {
  if (provider === "antigravity") {
    const binary = await stat(join(homedir(), ".local/bin/agy")).then(() => join(homedir(), ".local/bin/agy"), () => "agy");
    const output = await runCli(binary, ["models"]).catch(() => "");
    return output.split("\n").filter((line) => line.includes("\t")).map((line) => line.split("\t")[0]!);
  }
  if (provider === "codex") {
    // ponytail: `debug models` is the only catalog the CLI exposes; drop hidden internal slugs.
    const output = await runCli(await codexBinary(), ["debug", "models"]);
    const { models } = JSON.parse(output) as { models: { slug: string; visibility?: string }[] };
    return models.filter((model) => model.visibility !== "hide").map((model) => model.slug);
  }
  if (provider === "claude-cli") return CLAUDE_CLI_MODELS;
  if (provider === "ollama") return listOllamaModels();
  if (provider === "openrouter") return listOpenRouterModels();
  if (provider === "cloudflare") return listCloudflareModels();
  const key = (await readKey(provider))?.key;
  if (!key) throw new Error("No API key saved. Add one in Settings → Image providers.");
  if (provider === "anthropic") return listAnthropicModels(key);
  if (provider === "gemini") return listGeminiTextModels(key);
  // The list mixes every modality; keep the chat-capable families.
  return (await listOpenAIModels(key)).filter((id) => /^(gpt-|o\d|chatgpt-)/.test(id) && !/image|audio|realtime|tts|transcribe|search|embedding/.test(id));
}
