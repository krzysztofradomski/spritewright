import { useState, type Dispatch, type SetStateAction } from "react";
import { api } from "../api/client.js";
import { BRIEF_PLACEHOLDERS, DEFAULT_BRIEFS, briefWarnings, type BriefKind, type BriefTemplates } from "../brief-templates.js";
import { AnimationMotionsPanel } from "../components/animation-motions-panel.js";

export { AnimationMotionsPanel };

const BRIEF_EDITORS: Array<{ kind: BriefKind; title: string; description: string }> = [
  { kind: "animation", title: "Animation brief", description: "Sent by Animate to turn one asset into a sprite map." },
  { kind: "variation", title: "Variation brief", description: "Sent by Remix for a single asset." },
  { kind: "spriteMapVariation", title: "Sprite-map variation brief", description: "Sent by Remix when the reference is a sprite map." },
];

/** Per-project generation settings: the shared art direction, Animate/Remix briefs, and animation motions. */
export function ArtDirectionView(props: {
  gameId: string;
  projectLabel: string;
  globalPrompt: string;
  setGlobalPrompt: Dispatch<SetStateAction<string>>;
  savedGlobalPrompt: string;
  setSavedGlobalPrompt: Dispatch<SetStateAction<string>>;
  briefs: BriefTemplates;
  setBriefs: Dispatch<SetStateAction<BriefTemplates>>;
  savedBriefs: BriefTemplates;
  setSavedBriefs: Dispatch<SetStateAction<BriefTemplates>>;
  onNotice: (message: string) => void;
  motions?: Record<string, string> | undefined;
  onMotionsChange?: ((motions: Record<string, string>) => void) | undefined;
}) {
  const { gameId, projectLabel, globalPrompt, setGlobalPrompt, savedGlobalPrompt, setSavedGlobalPrompt, briefs, setBriefs, savedBriefs, setSavedBriefs, onNotice, onMotionsChange } = props;
  const [isCondensing, setIsCondensing] = useState(false);
  return (
    <section className="settings">
      <div className="panel art-direction">
        <div className="art-direction-copy">
          <h2>Shared art direction</h2>
          <p className="quiet">
            Applied to every generated asset in {projectLabel}.
          </p>
        </div>
        <textarea
          maxLength={12000}
          value={globalPrompt}
          onChange={(event) => setGlobalPrompt(event.target.value)}
          placeholder="Fixed isometric 2.5D painterly cutouts, upper-left light, no baked scenery…"
        />
        <aside>
          {(() => {
            const length = globalPrompt.length;
            const needsCondense = length > 200;
            const overLimit = length > 1400;
            const dirty = globalPrompt !== savedGlobalPrompt;
            return (
              <>
                <strong className={overLimit ? "over-limit" : ""}>
                  {length.toLocaleString()} / 1,400
                </strong>
                <meter
                  min={0}
                  max={1400}
                  low={200}
                  high={1000}
                  optimum={200}
                  value={Math.min(length, 1400)}
                >
                  {length}
                </meter>
                <small>
                  {overLimit
                    ? "Required: condense before saving."
                    : needsCondense
                      ? "Suggested: condense for a tighter generation context."
                      : "Healthy: concise shared direction."}
                </small>
                {needsCondense && (
                  <>
                    <button
                      disabled={isCondensing}
                      title="AI preserves concrete visual constraints, removes repetition, and targets 1,400 characters."
                      onClick={async () => {
                        setIsCondensing(true);
                        try {
                          const result =
                            await api.condenseSettings(globalPrompt);
                          if (result.globalPrompt) {
                            setGlobalPrompt(result.globalPrompt);
                            onNotice(
                              `Art direction condensed to ${result.globalPrompt.length} characters. Review, then save it.`,
                            );
                          } else
                            onNotice(
                              `Could not condense art direction: ${result.error ?? "unknown error"}`,
                            );
                        } finally {
                          setIsCondensing(false);
                        }
                      }}
                    >
                      {isCondensing ? (
                        <>
                          <span className="spinner" aria-hidden="true" />{" "}
                          Condensing…
                        </>
                      ) : (
                        "Condense with AI"
                      )}
                    </button>
                    <small className="ai-hint" role="status">
                      {isCondensing
                        ? "AI is condensing the shared art direction…"
                        : "AI keeps visual constraints, removes repetition, and targets the saved limit."}
                    </small>
                  </>
                )}
                <button
                  disabled={!dirty}
                  onClick={async () => {
                    const result = await api.saveSettings(gameId, {
                      globalPrompt,
                    });
                    if (result.globalPrompt !== undefined) {
                      setGlobalPrompt(result.globalPrompt);
                      setSavedGlobalPrompt(result.globalPrompt);
                      onNotice(
                        result.synthesized
                          ? `Art direction condensed to ${result.globalPrompt.length} characters and saved.`
                          : "Global art direction saved for this game.",
                      );
                    } else
                      onNotice(
                        `Could not save art direction: ${result.error ?? "unknown error"}`,
                      );
                  }}
                >
                  Save art direction
                </button>
              </>
            );
          })()}
        </aside>
      </div>
      <div className="panel settings-group">
        <div>
          <h2>Generation briefs</h2>
          <p className="quiet">
            Used by Animate and Remix in {projectLabel}, on top of the shared art direction. Words in {"{braces}"} are filled in for each asset.
          </p>
        </div>
        {BRIEF_EDITORS.map(({ kind, title, description }) => {
          const value = briefs[kind] ?? DEFAULT_BRIEFS[kind];
          const warnings = briefWarnings(kind, value);
          return (
            <div className="brief-editor" key={kind}>
              <div className="brief-editor-heading">
                <div>
                  <h3>{title}</h3>
                  <small>{description}</small>
                </div>
                <button disabled={value === DEFAULT_BRIEFS[kind]} onClick={() => setBriefs((current) => { const next = { ...current }; delete next[kind]; return next; })}>
                  Reset to default
                </button>
              </div>
              <textarea aria-label={title} maxLength={4000} value={value} onChange={(event) => setBriefs((current) => ({ ...current, [kind]: event.target.value }))} />
              {BRIEF_PLACEHOLDERS[kind].length > 0 && (
                <small>Placeholders: {BRIEF_PLACEHOLDERS[kind].map((key) => `{${key}}`).join(" ")}</small>
              )}
              {warnings.map((warning) => <small className="warning" key={warning}>{warning}</small>)}
            </div>
          );
        })}
        {(() => {
          // Briefs matching the default are not stored, so later default improvements still reach them.
          const toSave = Object.fromEntries(Object.entries(briefs).filter(([kind, text]) => text !== DEFAULT_BRIEFS[kind as BriefKind]));
          const dirty = JSON.stringify(toSave) !== JSON.stringify(Object.fromEntries(Object.entries(savedBriefs).filter(([kind, text]) => text !== DEFAULT_BRIEFS[kind as BriefKind])));
          return (
            <div className="settings-actions">
              <button className="primary" disabled={!dirty} onClick={async () => {
                const result = await api.saveSettings(gameId, { briefs: toSave });
                if (result.error) { onNotice(`Could not save briefs: ${result.error}`); return; }
                setBriefs(result.briefs ?? {});
                setSavedBriefs(result.briefs ?? {});
                onNotice("Generation briefs saved for this project.");
              }}>
                Save briefs
              </button>
              {dirty && <small>Unsaved changes. Animate and Remix use the saved briefs.</small>}
            </div>
          );
        })()}
      </div>
      <AnimationMotionsPanel
        gameId={gameId}
        projectLabel={projectLabel}
        onNotice={onNotice}
        onMotionsChange={onMotionsChange}
      />
    </section>
  );
}
