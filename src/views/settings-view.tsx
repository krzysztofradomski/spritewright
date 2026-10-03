import { useEffect, useState } from "react";
import type { ComfyFrameSettings, ImageModelSettings, ProviderStatus, SpendSummary, TextModel, TextModelRole } from "../api/client.js";
import { api } from "../api/client.js";
import { GENERATORS, usd } from "../components/generator-select.js";
import { Icon } from "../components/icon.js";

export type ThemeChoice = "auto" | "light" | "dark";
export type StyleChoice = "diorama" | "classic";

/** App-wide settings: appearance, the paid-generation limit and image provider status. */
export function SettingsView(props: {
  theme: ThemeChoice;
  onThemeChange: (theme: ThemeChoice) => void;
  style: StyleChoice;
  onStyleChange: (style: StyleChoice) => void;
  spend: SpendSummary | null;
  onSpendChange: (spend: SpendSummary) => void;
  providers: ProviderStatus[] | null;
  onProvidersChange: (update: (current: ProviderStatus[] | null) => ProviderStatus[] | null) => void;
  providerBusy: string | null;
  onProviderBusyChange: (value: string | null) => void;
  onCheckProviders: () => Promise<void>;
  onNotice: (message: string) => void;
}) {
  const { theme, onThemeChange, style, onStyleChange, spend, onSpendChange, providers, onProvidersChange, providerBusy, onProviderBusyChange, onCheckProviders, onNotice } = props;
  return (
    <section className="settings">
      <div className="panel settings-group">
        <div>
          <h2>Appearance</h2>
          <p className="quiet">Applies to this browser.</p>
        </div>
        <div className="settings-row">
          <span>Theme</span>
          <div className="theme-toggle" role="group" aria-label="Theme">
            {(["auto", "light", "dark"] as const).map((choice) => (
              <button key={choice} aria-pressed={theme === choice} title={choice === "auto" ? "Follow system" : `${choice} mode`} onClick={() => onThemeChange(choice)}>
                <Icon name={choice} />
                <span>{choice[0]!.toUpperCase() + choice.slice(1)}</span>
              </button>
            ))}
          </div>
        </div>
        <div className="settings-row">
          <span>Style</span>
          <div className="theme-toggle style-toggle" role="group" aria-label="Style">
            {([
              ["diorama", "Diorama", "Ivory paper, serif headings and hard shadows"],
              ["classic", "Classic", "The original calm, rounded workspace"],
            ] as const).map(([choice, label, title]) => (
              <button key={choice} aria-pressed={style === choice} title={title} onClick={() => onStyleChange(choice)}>
                {label}
              </button>
            ))}
          </div>
        </div>
      </div>
      <SpendLimitsPanel spend={spend} providers={providers} onSpendChange={onSpendChange} onNotice={onNotice} />

      <TextModelPanel onNotice={onNotice} />
      <TextModelPanel
        onNotice={onNotice}
        role="pixel"
        title="Pixel-art model"
        blurb="Draws the Pixel art (SVG) generator's assets. Any text model can do it; bigger models place pixels better."
        saveNotice={(label) => `Pixel art now uses ${label}.`}
      />
      <ImageModelPanel onNotice={onNotice} />
      <ComfyFrameSizePanel onNotice={onNotice} />
      <div className="panel settings-group">
        <div className="settings-heading">
          <div>
            <h2>Image providers</h2>
            <p className="quiet">Which generators this machine can use right now, and how much quota is left.</p>
          </div>
          <button onClick={() => void onCheckProviders()} disabled={Boolean(providerBusy)}>
            {providerBusy === "all" ? "Checking…" : providers ? "Check again" : "Check providers"}
          </button>
        </div>
        {!providers && providerBusy !== "all" && (
          <p className="empty-state">Not checked yet. Checking is free: it reads sign-in state, keys and rate limits without generating anything.</p>
        )}
        {providers && (
          <>
            <p className="quiet provider-tally">
              {providers.filter((item) => item.state === "ready" || item.state === "unknown").length} of {providers.length} usable
              {providers.some((item) => item.setup?.length) && ` · ${providers.filter((item) => item.setup?.length).length} need setup`}
            </p>
            <div className="provider-list">
              {providers.map((provider) => (
                <ProviderCard
                  key={provider.id}
                  provider={provider}
                  globalBusy={providerBusy}
                  onBusyChange={onProviderBusyChange}
                  onChange={(next) => onProvidersChange((current) => current?.map((item) => (item.id === next.id ? next : item)) ?? null)}
                  onNotice={onNotice}
                />
              ))}
            </div>
          </>
        )}
      </div>
    </section>
  );
}

const STATE_TEXT = { ready: "Available", limited: "Limit reached", unavailable: "Unavailable", unknown: "Quota unknown" } as const;
type SetupResult = { ok?: boolean; output?: string; status?: ProviderStatus; error?: string };

/** One provider: status and quota, what is still missing to set it up, and its API key if it uses one. */
function ProviderCard({ provider, globalBusy, onBusyChange, onChange, onNotice }: {
  provider: ProviderStatus;
  globalBusy: string | null;
  onBusyChange: (value: string | null) => void;
  onChange: (next: ProviderStatus) => void;
  onNotice: (message: string) => void;
}) {
  const [keyDraft, setKeyDraft] = useState("");
  const [output, setOutput] = useState<{ step: string; ok: boolean; text: string } | null>(null);
  const busy = Boolean(globalBusy);
  const busyWith = (label: string) => globalBusy === `${provider.id}:${label}`;
  /** Runs a request that answers with this provider's fresh status; reports its error instead. */
  const act = async (label: string, task: () => Promise<ProviderStatus & { error?: string }>) => {
    onBusyChange(`${provider.id}:${label}`);
    const result = await task().catch(() => ({ error: "request failed" }) as ProviderStatus & { error?: string });
    onBusyChange(null);
    if (result.error) {
      onNotice(`${provider.label}: ${result.error}`);
      return false;
    }
    onChange(result);
    return true;
  };
  const runStep = async (stepId: string, label: string) => {
    setOutput(null);
    onBusyChange(`${provider.id}:${stepId}`);
    const result: SetupResult = await api.runSetupStep(provider.id, stepId).catch(() => ({ error: "request failed" }));
    onBusyChange(null);
    if (result.error) return onNotice(`${label}: ${result.error}`);
    setOutput({ step: stepId, ok: Boolean(result.ok), text: result.output ?? "" });
    if (result.status) onChange(result.status);
  };
  const copy = (command: string) =>
    void navigator.clipboard.writeText(command).then(() => onNotice("Command copied."), () => onNotice("Could not copy; select the command instead."));
  return (
    <article className="provider">
      <header>
        <div className="provider-heading">
          <strong>{provider.label}</strong>
          <span className={`provider-state ${provider.state}`}>{STATE_TEXT[provider.state]}</span>
        </div>
        <small>{provider.role}</small>
      </header>
      <div className="provider-body">
        <p>{provider.summary}</p>
        {provider.quota?.map((window) => (
          <div key={window.label} className="quota">
            <div className="quota-label">
              <span>{window.label}</span>
              <span>{window.remaining ?? `${Math.max(0, 100 - window.usedPercent)}% left`}</span>
            </div>
            <div className="progress-track" role="progressbar" aria-valuenow={window.usedPercent} aria-valuemin={0} aria-valuemax={100} aria-label={`${window.label} used`}>
              <div className={window.usedPercent >= 100 ? "progress-fill full" : "progress-fill"} style={{ width: `${Math.min(100, window.usedPercent)}%` }} />
            </div>
            {window.resetsAt && <small>Resets {new Date(window.resetsAt).toLocaleString()}</small>}
          </div>
        ))}
        {provider.details.length > 0 && (
          <ul className="provider-details">
            {provider.details.map((detail) => <li key={detail}>{detail}</li>)}
          </ul>
        )}
      </div>
      {provider.setup?.length ? (
        <section className="provider-section setup" aria-label={`Set up ${provider.label}`}>
          <span className="provider-section-title">To set up</span>
          <ol>
            {provider.setup.map((step) => (
              <li key={step.id}>
                <span>{step.label}</span>
                {step.command && (
                  <div className="setup-command">
                    <code>{step.command}</code>
                    <span className="setup-command-actions">
                      <button type="button" className="link-button" onClick={() => copy(step.command!)}>Copy</button>
                      {step.runnable && (
                        <button type="button" className="link-button" disabled={busy} onClick={() => void runStep(step.id, step.label)}>
                          {busyWith(step.id) ? "Running…" : "Run"}
                        </button>
                      )}
                    </span>
                  </div>
                )}
                {step.url && <a href={step.url} target="_blank" rel="noreferrer">Open {new URL(step.url).host} ↗</a>}
                {output?.step === step.id && <pre className={output.ok ? "setup-output" : "setup-output failed"}>{output.ok ? "Done. " : "Failed. "}{output.text}</pre>}
              </li>
            ))}
          </ol>
        </section>
      ) : null}
      {provider.key && (
        <form
          className="provider-section provider-key"
          onSubmit={async (event) => {
            event.preventDefault();
            if (!(await act("save-key", () => api.saveProviderKey(provider.id, keyDraft)))) return;
            setKeyDraft("");
            onNotice(`${provider.label} key verified and saved.`);
          }}
        >
          <span className="provider-section-title">{provider.id === "cloudflare" ? "API token" : "API key"}</span>
          <small title={provider.key.source === "environment" ? `$${provider.key.envVar} overrides ${provider.key.path}` : provider.key.path}>
            {provider.key.source === "environment"
              ? `${provider.key.hint} from $${provider.key.envVar}`
              : provider.key.source === "file"
                ? `${provider.key.hint} in ${provider.key.path}`
                : `Not set · saves to ${provider.key.path}`}
          </small>
          <div className="provider-key-row">
            <input
              type="password"
              autoComplete="off"
              spellCheck={false}
              placeholder={provider.id === "cloudflare" ? "account-id:api-token" : provider.key.source ? "Paste a new key" : "Paste API key"}
              aria-label={`${provider.label} API key`}
              value={keyDraft}
              onChange={(event) => setKeyDraft(event.target.value)}
            />
            <button type="submit" disabled={busy || keyDraft.trim().length < 10}>{busyWith("save-key") ? "Verifying…" : "Save"}</button>
          </div>
        </form>
      )}
      <footer className="provider-actions">
        <button type="button" disabled={busy} onClick={() => void act("check", () => api.provider(provider.id))}>
          {busyWith("check") ? "Checking…" : "Check"}
        </button>
        {provider.canProbe && (
          <button type="button" disabled={busy} title="Sends one tiny text request; uses a sliver of quota if any is left." onClick={() => void act("probe", () => api.probeProvider(provider.id))}>
            {busyWith("probe") ? "Testing…" : "Test request"}
          </button>
        )}
        {provider.key?.source === "file" && (
          <button
            type="button"
            className="danger"
            disabled={busy}
            onClick={() => void act("remove-key", () => api.removeProviderKey(provider.id)).then((ok) => ok && onNotice(`${provider.label} key removed.`))}
          >
            {busyWith("remove-key") ? "Removing…" : "Remove key"}
          </button>
        )}
      </footer>
    </article>
  );
}

const CUSTOM = "__custom_model__";

/**
 * A provider's model list as a select, with "Custom model id…" for anything unlisted. A datalist
 * would filter to entries matching the typed value, so it showed one model; a select lists them all.
 */
function useModelPicker(provider: string, list: (provider: string) => Promise<{ models: string[]; error?: string }>) {
  const [models, setModels] = useState<{ provider: string; list: string[]; error?: string } | null>(null);
  const [custom, setCustom] = useState(false);
  useEffect(() => {
    if (!provider) return;
    let stale = false;
    setModels(null);
    setCustom(false);
    void list(provider).then(
      (result) => { if (!stale) setModels({ provider, list: result.models, ...(result.error ? { error: result.error } : {}) }); },
      () => { if (!stale) setModels({ provider, list: [], error: "Could not list models." }); },
    );
    return () => { stale = true; };
  }, [provider, list]);
  const listed = models?.provider === provider ? models.list : [];
  const field = (model: string, setModel: (model: string) => void, placeholder: string) => (
    <label>
      Model
      {listed.length && !custom ? (
        <select value={model} onChange={(event) => (event.target.value === CUSTOM ? setCustom(true) : setModel(event.target.value))}>
          {!model && <option value="">{placeholder}</option>}
          {model && !listed.includes(model) && <option value={model}>{model}</option>}
          {listed.map((id) => <option key={id} value={id}>{id}</option>)}
          <option value={CUSTOM}>Custom model id…</option>
        </select>
      ) : (
        <input value={model} spellCheck={false} placeholder={placeholder} onChange={(event) => setModel(event.target.value)} />
      )}
    </label>
  );
  const hint = models?.provider !== provider ? "Loading models…" : models.error ? `Can't list models: ${models.error}` : models.list.length ? custom ? <>Typing a custom model id. <button type="button" className="link-button" onClick={() => setCustom(false)}>Pick from {models.list.length} models</button></> : `${models.list.length} models to pick from, or choose Custom model id.` : "Type a model id.";
  return { field, hint };
}

const IMAGE_MODEL_LABELS: Record<string, string> = { openrouter: "OpenRouter", gemini: "Google AI Studio", openai: "OpenAI", cloudflare: "Cloudflare Workers AI" };

/** Which model each paid API provider draws with. */
function ImageModelPanel({ onNotice }: { onNotice: (message: string) => void }) {
  const [saved, setSaved] = useState<ImageModelSettings | null>(null);
  const [provider, setProvider] = useState("openrouter");
  const [model, setModel] = useState("");
  const [busy, setBusy] = useState(false);
  const picker = useModelPicker(provider, api.imageModels);
  useEffect(() => {
    void api.imageModelSettings().then((current) => { setSaved(current); setModel(current.models.openrouter ?? ""); }).catch(() => onNotice("Could not load the image model settings."));
  }, [onNotice]);
  if (!saved) return null;
  const current = saved.models[provider] ?? "";
  const fallback = saved.defaults[provider] ?? "";
  const dirty = model.trim() !== current;
  const save = async (next: string) => {
    setBusy(true);
    const result = await api.saveImageModel(provider, next).catch(() => ({ error: "request failed" }) as ImageModelSettings & { error?: string });
    setBusy(false);
    if (result.error) return onNotice(`Could not save the image model: ${result.error}`);
    setSaved(result);
    setModel(result.models[provider] ?? "");
    onNotice(`${IMAGE_MODEL_LABELS[provider]} images now use ${result.models[provider]}.`);
  };
  return (
    <div className="panel settings-group">
      <div>
        <h2>Image models</h2>
        <p className="quiet">Which model each paid provider draws with. Antigravity, Codex and Grok use their own image tool.</p>
      </div>
      <form className="text-model" onSubmit={(event) => { event.preventDefault(); void save(model); }}>
        <label>
          Provider
          <select value={provider} onChange={(event) => { setProvider(event.target.value); setModel(saved.models[event.target.value] ?? ""); }}>
            {Object.keys(saved.models).map((id) => <option key={id} value={id}>{IMAGE_MODEL_LABELS[id] ?? id}</option>)}
          </select>
        </label>
        {picker.field(model, setModel, fallback)}
        <div className="text-model-actions">
          <button type="submit" className="primary" disabled={!dirty || busy}>{busy ? "Saving…" : "Save"}</button>
          <button type="button" disabled={busy || current === fallback} title={`Go back to ${fallback}.`} onClick={() => void save("")}>Default</button>
        </div>
      </form>
      <small className="quiet">
        {/* ponytail: only OpenRouter reports real prices; the others' limits use their default model's list price. */}
        {provider !== "openrouter" && current !== fallback ? `Spending limits still estimate ${fallback}'s price. ` : ""}
        {provider === "cloudflare" ? "Text-to-image only. " : ""}
        {picker.hint}
      </small>
    </div>
  );
}

/** How big one ComfyUI frame is; small on purpose, since a bigger frame is slower and drifts more. */
function ComfyFrameSizePanel({ onNotice }: { onNotice: (message: string) => void }) {
  const [saved, setSaved] = useState<ComfyFrameSettings | null>(null);
  useEffect(() => {
    void api.comfyFrameSettings().then(setSaved).catch(() => onNotice("Could not load the ComfyUI settings."));
  }, [onNotice]);
  if (!saved) return null;
  return (
    <div className="panel settings-group">
      <div>
        <h2>ComfyUI frame size</h2>
        <p className="quiet">Each frame the local ComfyUI redraws is this many pixels square. {saved.default}px is about 5 seconds a frame; larger sizes are slower and change the character more from frame to frame.</p>
      </div>
      <label>
        Frame size
        <select value={saved.frameSize} onChange={async (event) => {
          const result = await api.saveComfyFrameSize(Number(event.target.value)).catch(() => ({ error: "request failed" }) as ComfyFrameSettings & { error?: string });
          if ("error" in result && result.error) return onNotice(`Could not save the frame size: ${result.error}`);
          setSaved(result);
          onNotice(`ComfyUI frames are now ${result.frameSize}×${result.frameSize}.`);
        }}>
          {saved.sizes.map((size) => <option key={size} value={size}>{size}×{size}{size === saved.default ? " (default)" : ""}</option>)}
        </select>
      </label>
    </div>
  );
}

/** One text model setting: prompts (Enhance with AI), or the model the pixel-art generator draws with. */
function TextModelPanel({
  onNotice,
  role = "prompt",
  title = "Text model",
  blurb = "Writes prompts for Enhance with AI and condenses long art direction.",
  saveNotice = (label: string) => `Prompts now use ${label}.`,
}: {
  onNotice: (message: string) => void;
  role?: TextModelRole;
  title?: string;
  blurb?: string;
  saveNotice?: (label: string) => string;
}) {
  const [saved, setSaved] = useState<TextModel | null>(null);
  const [provider, setProvider] = useState("");
  const [model, setModel] = useState("");
  const [busy, setBusy] = useState<"save" | "test" | null>(null);
  const [test, setTest] = useState<string | null>(null);
  const picker = useModelPicker(provider, api.textModels);
  useEffect(() => {
    void api.textModel(role).then((current) => { setSaved(current); setProvider(current.provider); setModel(current.model); }).catch(() => onNotice(`Could not load the ${title.toLowerCase()} setting.`));
  }, [onNotice, role, title]);
  if (!saved) return null;
  const selected = saved.providers.find((item) => item.id === provider);
  const dirty = provider !== saved.provider || model !== saved.model;
  return (
    <div className="panel settings-group">
      <div>
        <h2>{title}</h2>
        <p className="quiet">{blurb}</p>
      </div>
      <form
        className="text-model"
        onSubmit={async (event) => {
          event.preventDefault();
          setBusy("save");
          const result = await api.saveTextModel(provider, model.trim(), role).catch(() => ({ error: "request failed" }) as TextModel & { error?: string });
          setBusy(null);
          if (result.error) return onNotice(`Could not save the ${title.toLowerCase()}: ${result.error}`);
          setSaved(result);
          setTest(null);
          onNotice(saveNotice(`${selected?.label}${result.model ? ` (${result.model})` : ""}`));
        }}
      >
        <label>
          Provider
          <select value={provider} onChange={(event) => { const next = saved.providers.find((item) => item.id === event.target.value); setProvider(event.target.value); setTest(null); setModel(next?.id === saved.provider ? saved.model : next?.defaultModel ?? ""); }}>
            {saved.providers.map((item) => <option key={item.id} value={item.id}>{item.label}{item.paid ? " (paid API)" : " (plan)"}</option>)}
          </select>
        </label>
        {picker.field(model, setModel, provider === "codex" ? "Codex default" : "model id")}
        <div className="text-model-actions">
          <button type="submit" className="primary" disabled={!dirty || busy !== null}>{busy === "save" ? "Saving…" : "Save"}</button>
          <button
            type="button"
            disabled={dirty || busy !== null}
            title={dirty ? "Save first; the test uses the saved model." : "Sends one tiny prompt to the saved model."}
            onClick={async () => {
              setBusy("test");
              setTest(null);
              const result = await api.testTextModel(role).catch(() => ({ error: "request failed" }) as { error?: string; reply?: string; ms?: number });
              setBusy(null);
              setTest(result.error ? `Failed: ${result.error}` : `Replied "${result.reply}" in ${((result.ms ?? 0) / 1000).toFixed(1)}s.`);
            }}
          >
            {busy === "test" ? "Testing…" : "Test"}
          </button>
        </div>
      </form>
      <small className="quiet">
        {selected?.paid ? `Billed per prompt to ${selected.label}, usually a fraction of a cent; uses the key saved under Image providers. ` : "Runs on your plan allowance. "}
        {picker.hint}
      </small>
      {test && <small className={test.startsWith("Failed") ? "modal-error" : "quiet"} role="status">{test}</small>}
    </div>
  );
}

/** A daily limit for each paid provider, next to what it has spent and queued today. */
function SpendLimitsPanel({ spend, providers, onSpendChange, onNotice }: {
  spend: SpendSummary | null;
  providers: ProviderStatus[] | null;
  onSpendChange: (spend: SpendSummary) => void;
  onNotice: (message: string) => void;
}) {
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  // Only providers that can actually run get a limit: a key is saved, and a check hasn't found it unusable.
  // ponytail: a saved key counts until checked; env keys are never verified up front.
  // Saving or removing a key changes which providers are set up; reload so rows appear or go at once.
  useEffect(() => {
    if (providers) void api.spend().then(onSpendChange).catch(() => undefined);
  }, [providers, onSpendChange]);
  const paid = GENERATORS.filter((generator) =>
    generator.paid &&
    spend?.providers[generator.id]?.configured &&
    providers?.find((item) => item.id === generator.statusId)?.state !== "unavailable");
  if (!paid.length) return null;
  return (
    <div className="panel settings-group">
      <div>
        <h2>Paid generation</h2>
        <p className="quiet">Each API provider you've set up has its own daily limit. A job is refused once that provider's spending today, plus its queued jobs at their estimated cost, would pass the limit. Every paid job also asks for confirmation.</p>
      </div>
      <div className="spend-limits">
        {paid.map((generator) => {
          const current = spend?.providers[generator.id];
          const draft = drafts[generator.id] ?? (current ? String(current.limitUsd) : "");
          const used = current && current.limitUsd > 0 ? Math.min(100, ((current.spentTodayUsd + current.pendingUsd) / current.limitUsd) * 100) : current ? 100 : 0;
          return (
            <form
              key={generator.id}
              className="spend-limit-row"
              onSubmit={async (event) => {
                event.preventDefault();
                const value = Number(draft);
                if (!draft.trim() || !Number.isFinite(value) || value < 0) return onNotice("Enter a daily limit of $0 or more.");
                const result = await api.saveSpendLimit(generator.id, value).catch(() => ({ error: "request failed" }) as SpendSummary & { error?: string });
                if (result.error) return onNotice(`Could not save the ${generator.label} limit: ${result.error}`);
                onSpendChange(result);
                setDrafts((all) => Object.fromEntries(Object.entries(all).filter(([id]) => id !== generator.id)));
                onNotice(`Daily ${generator.label} limit set to ${usd(value)}.`);
              }}
            >
              <div className="spend-limit-copy">
                <strong>{generator.label}</strong>
                <small>
                  {current
                    ? `Today ${usd(current.spentTodayUsd)} spent · ${usd(current.pendingUsd)} queued · about ${usd(current.estimateUsd)} per image`
                    : "Loading…"}
                </small>
                <div className="progress-track" role="progressbar" aria-valuenow={Math.round(used)} aria-valuemin={0} aria-valuemax={100} aria-label={`${generator.label} daily limit used`}>
                  <div className={used >= 100 ? "progress-fill full" : "progress-fill"} style={{ width: `${used}%` }} />
                </div>
              </div>
              <div className="spend-limit">
                <span aria-hidden="true">$</span>
                <input
                  type="number"
                  min="0"
                  max="1000"
                  step="0.5"
                  aria-label={`Daily ${generator.label} limit in dollars`}
                  value={draft}
                  disabled={!current}
                  onChange={(event) => setDrafts((all) => ({ ...all, [generator.id]: event.target.value }))}
                />
                <button type="submit" disabled={!current || Number(draft) === current.limitUsd || !draft.trim()}>Save</button>
              </div>
            </form>
          );
        })}
      </div>
    </div>
  );
}

export { AnimationMotionsPanel } from "../components/animation-motions-panel.js";

