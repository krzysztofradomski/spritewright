export type Asset = {
  id: string;
  gameId: string;
  family: string;
  state: string;
  filename: string;
  relativePath: string;
  tags: string[];
  /** Present only on native pixel art; the palette that was applied. */
  pixel?: { palette: string[] };
  provenance?: { prompt?: string; provider?: string; referencePaths?: string[] };
  createdAt?: string;
  version?: number;
  inspection?: {
    width: number;
    height: number;
    hasAlpha: boolean;
    alphaCoverage: number;
    warnings: string[];
  };
};
export type ProviderStatus = {
  id: "antigravity" | "grok" | "codex" | "openrouter" | "gemini" | "openai" | "cloudflare" | "comfyui";
  label: string;
  role: string;
  state: "ready" | "limited" | "unavailable" | "unknown";
  summary: string;
  details: string[];
  quota?: Array<{ label: string; usedPercent: number; remaining?: string; resetsAt?: string }>;
  canProbe: boolean;
  setup?: Array<{ id: string; label: string; command?: string; url?: string; runnable?: boolean }>;
  key?: { source: "environment" | "file" | null; hint?: string; path: string; envVar: string };
  checkedAt: string;
};
export type ProviderSpend = { limitUsd: number; spentTodayUsd: number; pendingUsd: number; estimateUsd: number; configured: boolean };
export type SpendSummary = { providers: Record<string, ProviderSpend> };
export type ComfyFrameSettings = { frameSize: number; default: number; sizes: number[] };
export type ImageModelSettings = { models: Record<string, string>; defaults: Record<string, string> };
/** Which saved model a text-model call means: the one writing prompts, or the one drawing pixels. */
export type TextModelRole = "prompt" | "pixel";
export type TextModel = {
  provider: string;
  model: string;
  role?: TextModelRole;
  providers: Array<{ id: string; label: string; defaultModel: string; paid: boolean }>;
};
export type TrashContents = {
  assets: Array<{ path: string; family: string; filename: string; removedAt: string; record?: Asset }>;
  projects: Array<{ name: string; label: string; trashedAt: string }>;
};
export const api = {
  async trash(gameId: string) {
    return fetch(`/api/trash?gameId=${encodeURIComponent(gameId)}`).then((response) => response.json() as Promise<TrashContents>);
  },
  trashFileUrl(gameId: string, path: string) {
    return `/api/trash/file?${new URLSearchParams({ gameId, path })}`;
  },
  async restoreAsset(gameId: string, path: string) {
    return fetch("/api/trash/assets/restore", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ gameId, path }),
    }).then((response) => response.json() as Promise<Asset & { error?: string }>);
  },
  async deleteTrashedAssets(gameId: string, paths: string[]) {
    return fetch("/api/trash/assets/delete", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ gameId, paths }),
    }).then((response) => response.json() as Promise<{ deleted?: string[]; error?: string }>);
  },
  async deleteTrashedProjects(names: string[]) {
    return fetch("/api/trash/projects/delete", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ names }),
    }).then((response) => response.json() as Promise<{ deleted?: string[]; error?: string }>);
  },
  async restoreProject(name: string) {
    return fetch("/api/trash/projects/restore", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name }),
    }).then((response) => response.json() as Promise<{ id?: string; label?: string; error?: string }>);
  },
  async spend() {
    return fetch("/api/spend").then((response) => response.json() as Promise<SpendSummary>);
  },
  async saveSpendLimit(provider: string, limitUsd: number) {
    return fetch("/api/spend", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider, limitUsd }),
    }).then((response) => response.json() as Promise<SpendSummary & { error?: string }>);
  },
  async providers() {
    return fetch("/api/providers").then((response) => response.json() as Promise<ProviderStatus[]>);
  },
  async textModel(role: TextModelRole = "prompt") {
    return fetch(`/api/text-model?role=${role}`).then((response) => response.json() as Promise<TextModel>);
  },
  async saveTextModel(provider: string, model: string, role: TextModelRole = "prompt") {
    return fetch("/api/text-model", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ provider, model, role }) }).then(
      (response) => response.json() as Promise<TextModel & { error?: string }>,
    );
  },
  async textModels(provider: string) {
    return fetch(`/api/text-models/${provider}`).then((response) => response.json() as Promise<{ models: string[]; error?: string }>);
  },
  async imageModelSettings() {
    return fetch("/api/image-models").then((response) => response.json() as Promise<ImageModelSettings>);
  },
  async comfyFrameSettings() {
    return fetch("/api/comfyui-settings").then((response) => response.json() as Promise<ComfyFrameSettings>);
  },
  async saveComfyFrameSize(frameSize: number) {
    return fetch("/api/comfyui-settings", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ frameSize }) }).then(
      (response) => response.json() as Promise<ComfyFrameSettings & { error?: string }>,
    );
  },
  async saveImageModel(provider: string, model: string) {
    return fetch("/api/image-models", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ provider, model }) }).then(
      (response) => response.json() as Promise<ImageModelSettings & { error?: string }>,
    );
  },
  async imageModels(provider: string) {
    return fetch(`/api/image-models/${provider}`).then((response) => response.json() as Promise<{ models: string[]; error?: string }>);
  },
  async testTextModel(role: TextModelRole = "prompt") {
    return fetch(`/api/text-model/test?role=${role}`, { method: "POST" }).then(
      (response) => response.json() as Promise<{ reply?: string; ms?: number; error?: string }>,
    );
  },
  async provider(id: string) {
    return fetch(`/api/providers/${id}`).then((response) => response.json() as Promise<ProviderStatus & { error?: string }>);
  },
  async runSetupStep(id: string, step: string) {
    return fetch(`/api/providers/${id}/setup/${step}`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }).then(
      (response) => response.json() as Promise<{ ok?: boolean; output?: string; status?: ProviderStatus; error?: string }>,
    );
  },
  async saveProviderKey(id: string, key: string) {
    return fetch(`/api/providers/${id}/key`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ key }) }).then(
      (response) => response.json() as Promise<ProviderStatus & { error?: string }>,
    );
  },
  async removeProviderKey(id: string) {
    return fetch(`/api/providers/${id}/key`, { method: "DELETE" }).then((response) => response.json() as Promise<ProviderStatus & { error?: string }>);
  },
  async probeProvider(id: string) {
    return fetch(`/api/providers/${id}/probe`, { method: "POST" }).then(
      (response) => response.json() as Promise<ProviderStatus & { error?: string }>,
    );
  },
  spriteFrameUrl(
    id: string, gameId: string,
    rect: { x: number; y: number; width: number; height: number },
    offset: { x: number; y: number } = { x: 0, y: 0 },
    scale = 1,
    box?: { width: number; height: number },
  ) {
    const query = new URLSearchParams({
      gameId, x: String(rect.x), y: String(rect.y), width: String(rect.width), height: String(rect.height),
      offsetX: String(offset.x), offsetY: String(offset.y),
      scale: String(scale),
      ...(box ? { boxWidth: String(box.width), boxHeight: String(box.height) } : {}),
    });
    return `/api/assets/${id}/frame?${query}`;
  },
  async games() {
    return fetch("/api/games").then(
      (response) =>
        response.json() as Promise<Array<{ id: string; label: string }>>,
    );
  },
  async createGame(name: string) {
    return fetch("/api/games", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name }),
    }).then((response) => response.json() as Promise<{ id?: string; label?: string; error?: string }>);
  },
  async deleteGame(id: string) {
    return fetch(`/api/games/${encodeURIComponent(id)}`, { method: "DELETE" }).then(
      (response) => response.json() as Promise<{ trashedPath?: string; error?: string }>,
    );
  },
  async transfer(id: string, gameId: string, targetGameId: string) {
    return fetch(`/api/assets/${id}/transfer`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ gameId, targetGameId }),
    }).then((response) => response.json() as Promise<{ error?: string; movedAnimations?: string[]; brokenAnimations?: string[] }>);
  },
  async assets(gameId: string) {
    const response = await fetch(
      `/api/assets?gameId=${encodeURIComponent(gameId)}`,
    );
    return response.json() as Promise<Asset[]>;
  },
  async saveCleanedSpriteMap(id: string, gameId: string, png: ArrayBuffer) {
    // ponytail: base64 in JSON keeps the JSON-only API; about 33% bigger than a raw upload.
    const bytes = new Uint8Array(png);
    let binary = "";
    for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return fetch(`/api/assets/${id}/cleaned`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ gameId, png: btoa(binary) }),
    }).then((response) => response.json() as Promise<Asset | { error: string }>);
  },
  async detectSpriteGrid(id: string, gameId: string, layout?: { columns: number; rows: number }) {
    const query = new URLSearchParams({ gameId, ...(layout ? { columns: String(layout.columns), rows: String(layout.rows) } : {}) });
    return fetch(`/api/assets/${id}/detect-grid?${query}`).then(
      (response) =>
        response.json() as Promise<{
          width?: number;
          height?: number;
          xCuts?: number[][];
          yCuts?: number[];
          confidence?: "high" | "medium" | "low";
          reason?: string;
          error?: string;
        }>,
    );
  },
  async frameAnchors(
    id: string,
    gameId: string,
    rects: Array<{ x: number; y: number; width: number; height: number }>,
    mode: "subject" | "base" = "subject",
  ) {
    return fetch(`/api/assets/${id}/frame-anchors`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ gameId, rects, mode }),
    }).then(
      (response) => response.json() as Promise<{
        offsets?: Array<{ x: number; y: number }>;
        scales?: number[];
        box?: { width: number; height: number };
        error?: string;
      }>,
    );
  },
  async jobs() {
    return fetch("/api/jobs").then((response) => response.json());
  },
  async submit(jobs: unknown[]) {
    return fetch("/api/jobs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jobs }),
    }).then((response) => response.json());
  },
  async cancelJob(id: string) {
    return fetch(`/api/jobs/${id}/cancel`, { method: "POST" }).then(
      (response) =>
        response.json() as Promise<{ state?: string; error?: string }>,
    );
  },
  async retryJob(id: string) {
    return fetch(`/api/jobs/${id}/retry`, { method: "POST" }).then(
      (response) =>
        response.json() as Promise<{ state?: string; error?: string }>,
    );
  },
  async deleteJob(id: string) {
    return fetch(`/api/jobs/${id}`, { method: "DELETE" }).then(
      (response) => response.json() as Promise<{ error?: string }>,
    );
  },
  async move(id: string, gameId: string, state: string) {
    return fetch(`/api/assets/${id}/move`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ gameId, state }),
    }).then((response) => response.json());
  },
  async pixelize(
    id: string,
    gameId: string,
    options: { grid?: number; colors?: number; outline?: boolean } = {},
  ) {
    return fetch(`/api/assets/${id}/pixelize`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ gameId, ...options }),
    }).then((response) => response.json() as Promise<{ id?: string; error?: string }>);
  },
  async fix(
    id: string,
    gameId: string,
    provider: string,
  ) {
    return fetch(`/api/assets/${id}/fix`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ gameId, provider }),
    }).then((response) => response.json());
  },
  async remove(id: string, gameId: string) {
    return fetch(`/api/assets/${id}?gameId=${encodeURIComponent(gameId)}`, {
      method: "DELETE",
    }).then((response) => response.json());
  },
  async enhancePrompt(gameId: string, family: string, prompt: string) {
    return fetch("/api/prompts/enhance", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ gameId, family, prompt }),
    }).then(
      (response) =>
        response.json() as Promise<{
          prompt?: string;
          targetLength?: number;
          error?: string;
        }>,
    );
  },
  async animations(gameId: string) {
    return fetch(`/api/animations?gameId=${encodeURIComponent(gameId)}`).then(
      (response) => response.json(),
    );
  },
  async exportAnimation(id: string, gameId: string) {
    return fetch(`/api/animations/${id}/export`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ gameId }),
    }).then(
      (response) =>
        response.json() as Promise<{ directory?: string; files?: Array<{ kind: "sheet" | "atlas" | "preview"; filename: string }>; error?: string }>,
    );
  },
  exportUrl(id: string, gameId: string, filename: string) {
    return `/api/animations/${id}/exports/${filename}?gameId=${encodeURIComponent(gameId)}`;
  },
  async deleteAnimation(id: string, gameId: string) {
    return fetch(`/api/animations/${encodeURIComponent(id)}?gameId=${encodeURIComponent(gameId)}`, { method: "DELETE" }).then(
      (response) => response.json() as Promise<{ removed?: string; error?: string }>,
    );
  },
  async motions(gameId?: string) {
    return fetch(`/api/motions${gameId ? `?gameId=${encodeURIComponent(gameId)}` : ""}`).then((response) => response.json() as Promise<Record<string, string>>);
  },
  async saveMotions(motions: Record<string, string>, gameId?: string) {
    return fetch(`/api/motions${gameId ? `?gameId=${encodeURIComponent(gameId)}` : ""}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ motions, ...(gameId ? { gameId } : {}) }),
    }).then((response) => response.json() as Promise<Record<string, string> & { error?: string }>);
  },
  async resetMotions(gameId?: string) {
    return fetch(`/api/motions/reset${gameId ? `?gameId=${encodeURIComponent(gameId)}` : ""}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(gameId ? { gameId } : {}),
    }).then((response) => response.json() as Promise<Record<string, string> & { error?: string }>);
  },
  async saveAnimation(animation: unknown) {
    return fetch("/api/animations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(animation),
    }).then((response) => response.json());
  },
  async settings(gameId: string) {
    return fetch(`/api/settings?gameId=${encodeURIComponent(gameId)}`).then(
      (response) => response.json() as Promise<{ globalPrompt: string; briefs?: Record<string, string> }>,
    );
  },
  async saveSettings(gameId: string, patch: { globalPrompt?: string; briefs?: Record<string, string> }) {
    return fetch("/api/settings", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ gameId, ...patch }),
    }).then(
      (response) =>
        response.json() as Promise<{
          globalPrompt?: string;
          briefs?: Record<string, string>;
          synthesized?: boolean;
          maxLength?: number;
          error?: string;
        }>,
    );
  },
  async condenseSettings(globalPrompt: string) {
    return fetch("/api/settings/condense", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ globalPrompt }),
    }).then(
      (response) =>
        response.json() as Promise<{
          globalPrompt?: string;
          maxLength?: number;
          error?: string;
        }>,
    );
  },
  async upload(gameId: string, file: File) {
    const contentBase64 = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(reader.error);
      reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "");
      reader.readAsDataURL(file);
    });
    return fetch("/api/uploads", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ gameId, filename: file.name, contentBase64 }),
    }).then((response) => response.json());
  },
};
