import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type KeyProvider = "openrouter" | "gemini" | "openai" | "cloudflare" | "anthropic";
export const KEY_PROVIDERS: KeyProvider[] = ["openrouter", "gemini", "openai", "cloudflare", "anthropic"];
export type KeyInfo = { source: "environment" | "file" | null; hint?: string; path: string; envVar: string };

// OpenRouter and Gemini use the files delegate.sh reads, so a key saved here works there too.
const LOCATIONS: Record<KeyProvider, { envVar: string; file: string }> = {
  openrouter: { envVar: "OPENROUTER_API_KEY", file: ".config/openrouter/key" },
  gemini: { envVar: "GEMINI_API_KEY", file: ".config/google-ai/key" },
  openai: { envVar: "OPENAI_API_KEY", file: ".config/openai/key" },
  // Stored as "<account id>:<API token>"; from the environment it takes both variables.
  cloudflare: { envVar: "CLOUDFLARE_API_TOKEN", file: ".config/cloudflare/workers-ai-key" },
  anthropic: { envVar: "ANTHROPIC_API_KEY", file: ".config/anthropic/key" },
};

const fromEnvironment = (provider: KeyProvider) => {
  const value = process.env[LOCATIONS[provider].envVar]?.trim();
  if (provider !== "cloudflare" || !value) return value;
  const account = process.env.CLOUDFLARE_ACCOUNT_ID?.trim();
  return account ? `${account}:${value}` : undefined;
};

const keyPath = (provider: KeyProvider) => join(homedir(), LOCATIONS[provider].file);

/** Environment first, then the key file. */
export async function readKey(provider: KeyProvider) {
  const fromEnv = fromEnvironment(provider);
  if (fromEnv) return { key: fromEnv, source: "environment" as const };
  const fromFile = (await readFile(keyPath(provider), "utf8").catch(() => "")).trim();
  return fromFile ? { key: fromFile, source: "file" as const } : null;
}

/** Where the key comes from and its last four characters; never the key itself. */
export async function describeKey(provider: KeyProvider): Promise<KeyInfo> {
  const found = await readKey(provider);
  return {
    source: found?.source ?? null,
    ...(found ? { hint: `…${found.key.slice(-4)}` } : {}),
    path: `~/${LOCATIONS[provider].file}`,
    envVar: LOCATIONS[provider].envVar,
  };
}

export async function saveKey(provider: KeyProvider, key: string) {
  const path = keyPath(provider);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, `${key.trim()}\n`, { mode: 0o600 });
  await chmod(path, 0o600);
}

export const removeKey = (provider: KeyProvider) => rm(keyPath(provider), { force: true });
