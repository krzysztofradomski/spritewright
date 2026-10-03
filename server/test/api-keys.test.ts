import { mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { describeKey, readKey, removeKey, saveKey } from "../api-keys.js";

const saved = { HOME: process.env.HOME, GEMINI_API_KEY: process.env.GEMINI_API_KEY };
beforeEach(async () => {
  process.env.HOME = await mkdtemp(join(tmpdir(), "keys-"));
  delete process.env.GEMINI_API_KEY;
});
afterEach(() => {
  process.env.HOME = saved.HOME;
  if (saved.GEMINI_API_KEY === undefined) delete process.env.GEMINI_API_KEY;
  else process.env.GEMINI_API_KEY = saved.GEMINI_API_KEY;
});

test("saves a key privately, masks it, lets the environment win, and removes it", async () => {
  expect((await describeKey("gemini")).source).toBeNull();
  await saveKey("gemini", "  AIzaSyEXAMPLEKEY1234 \n");
  expect(await readKey("gemini")).toEqual({ key: "AIzaSyEXAMPLEKEY1234", source: "file" });
  const info = await describeKey("gemini");
  expect(info).toMatchObject({ source: "file", hint: "…1234", path: "~/.config/google-ai/key" });
  expect(JSON.stringify(info)).not.toContain("AIzaSyEXAMPLE");
  expect((await stat(join(process.env.HOME!, ".config/google-ai/key"))).mode & 0o777).toBe(0o600);

  process.env.GEMINI_API_KEY = "from-env-9999";
  expect(await describeKey("gemini")).toMatchObject({ source: "environment", hint: "…9999" });
  delete process.env.GEMINI_API_KEY;

  await removeKey("gemini");
  expect(await readKey("gemini")).toBeNull();
});

test("Cloudflare needs both the account ID and the token", async () => {
  const { parseCloudflareKey } = await import("../cloudflare.js");
  const account = "0123456789abcdef0123456789abcdef";
  expect(parseCloudflareKey(`${account}:tok_abc`)).toEqual({ accountId: account, token: "tok_abc" });
  expect(() => parseCloudflareKey("tok_abc")).toThrow(/account id/);
  expect(() => parseCloudflareKey("not-hex:tok_abc")).toThrow(/32 hex/);

  const saved = { token: process.env.CLOUDFLARE_API_TOKEN, account: process.env.CLOUDFLARE_ACCOUNT_ID };
  try {
    process.env.CLOUDFLARE_API_TOKEN = "tok_env1";
    delete process.env.CLOUDFLARE_ACCOUNT_ID;
    // A token without its account can't be used, so it doesn't count as a key.
    expect(await readKey("cloudflare")).toBeNull();
    process.env.CLOUDFLARE_ACCOUNT_ID = account;
    expect(await readKey("cloudflare")).toEqual({ key: `${account}:tok_env1`, source: "environment" });
  } finally {
    for (const [name, value] of [["CLOUDFLARE_API_TOKEN", saved.token], ["CLOUDFLARE_ACCOUNT_ID", saved.account]] as const)
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
  }
});
