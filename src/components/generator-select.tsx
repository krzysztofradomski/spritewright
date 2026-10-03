import { useDismissableMenu } from "./use-dismissable-menu.js";
import type { ProviderStatus } from "../api/client.js";
import { Icon } from "./icon.js";

export type GeneratorId = "delegate-antigravity" | "grok" | "openrouter" | "codex" | "gemini" | "openai" | "cloudflare" | "svg-pixel" | "comfyui";
// statusId is absent for generators with no image provider behind them; they show their own note.
export const GENERATORS: Array<{ id: GeneratorId; statusId?: ProviderStatus["id"]; label: string; note: string; paid?: boolean }> = [
  { id: "delegate-antigravity", statusId: "antigravity", label: "Antigravity", note: "delegate.sh image, Codex fallback" },
  { id: "grok", statusId: "grok", label: "Grok Build", note: "Grok subscription" },
  { id: "codex", statusId: "codex", label: "Codex", note: "ChatGPT plan, imagegen" },
  { id: "openrouter", statusId: "openrouter", label: "OpenRouter", note: "Spends API credit", paid: true },
  { id: "gemini", statusId: "gemini", label: "Google AI Studio", note: "Gemini API key, billed by Google", paid: true },
  { id: "openai", statusId: "openai", label: "OpenAI", note: "gpt-image-1, billed by OpenAI", paid: true },
  { id: "cloudflare", statusId: "cloudflare", label: "Cloudflare Workers AI", note: "FLUX schnell, free daily allowance", paid: true },
  { id: "comfyui", statusId: "comfyui", label: "ComfyUI (local)", note: "Redraws a sprite map's frames, free and local" },
  { id: "svg-pixel", label: "Pixel art (SVG)", note: "Drawn by the pixel-art model in Settings" },
];

/** Dollars to the cent, or to a hundredth of a cent for sub-cent prices like Cloudflare's. */
export const usd = (value: number) => `$${value > 0 && value < 0.01 ? value.toFixed(4) : value.toFixed(2)}`;

export const isPaidGenerator = (id: GeneratorId) => Boolean(GENERATORS.find((generator) => generator.id === id)?.paid);

export const isGeneratorBlocked = (providers: ProviderStatus[], id: GeneratorId) => {
  const state = providers.find((item) => item.id === GENERATORS.find((generator) => generator.id === id)?.statusId)?.state;
  return state === "limited" || state === "unavailable";
};

export const STATE_LABELS: Record<ProviderStatus["state"], string> = { ready: "Available", limited: "Exhausted", unavailable: "Unavailable", unknown: "Quota unknown" };

/** Generator dropdown: every provider is listed, but exhausted or unavailable ones are read-only. */
export function GeneratorSelect({ value, providers, checking, onChange }: {
  value: GeneratorId;
  providers: ProviderStatus[] | null;
  checking: boolean;
  onChange: (id: GeneratorId) => void;
}) {
  const { ref, close } = useDismissableMenu();
  const describe = (generator: (typeof GENERATORS)[number]) => {
    const health = providers?.find((item) => item.id === generator.statusId);
    return {
      health,
      blocked: health?.state === "limited" || health?.state === "unavailable",
      detail: health
        ? health.quota?.find((window) => window.remaining)?.remaining ?? health.summary
        : checking && generator.statusId
          ? "Checking availability…"
          : generator.note,
    };
  };
  const selected = GENERATORS.find((generator) => generator.id === value) ?? GENERATORS[0]!;
  const current = describe(selected);
  return (
    <details
      ref={ref}
      className="menu generator-select"
    >
      <summary className="button" aria-label={`Image generator: ${selected.label}`}>
        <span className="generator-copy">
          <strong>{selected.label}{selected.paid && <span className="paid-badge">Paid</span>}</strong>
          <small>{current.detail}</small>
        </span>
        {current.health && <span className={`provider-state ${current.health.state}`}>{STATE_LABELS[current.health.state]}</span>}
        <Icon name="chevron" />
      </summary>
      <div className="menu-list" role="listbox" aria-label="Image generator">
        {GENERATORS.map((generator) => {
          const { health, blocked, detail } = describe(generator);
          return (
            <button
              key={generator.id}
              type="button"
              role="option"
              aria-selected={generator.id === value}
              aria-disabled={blocked}
              className={blocked ? "is-blocked" : undefined}
              title={blocked ? `${generator.label} can't be used right now: ${health?.summary}` : undefined}
              onClick={() => { if (blocked) return; onChange(generator.id); close(); }}
            >
              <span className="generator-copy">
                <strong>{generator.label}{generator.paid && <span className="paid-badge">Paid</span>}</strong>
                <small>{detail}</small>
              </span>
              {health && <span className={`provider-state ${health.state}`}>{STATE_LABELS[health.state]}</span>}
            </button>
          );
        })}
      </div>
    </details>
  );
}
