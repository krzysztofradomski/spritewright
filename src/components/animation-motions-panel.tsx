import { useEffect, useState } from "react";
import { DEFAULT_MOTIONS } from "../animation-draft.js";
import { api } from "../api/client.js";
import { Icon } from "./icon.js";

type MotionEntry = {
  id: string;
  name: string;
  poses: string;
};

function entriesToRecord(entries: MotionEntry[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (const entry of entries) {
    const key = entry.name.trim().toLowerCase().replace(/[^a-z0-9-_]/g, "-");
    if (key) result[key] = entry.poses.trim();
  }
  return result;
}

function recordToEntries(record: Record<string, string>): MotionEntry[] {
  return Object.entries(record).map(([name, poses], index) => ({
    id: `motion-${name}-${index}-${Math.random().toString(36).slice(2, 6)}`,
    name,
    poses,
  }));
}

export type AnimationMotionsPanelProps = {
  gameId?: string;
  projectLabel?: string;
  onNotice: (message: string) => void;
  onMotionsChange?: ((motions: Record<string, string>) => void) | undefined;
};

/** Management card for animation motion presets: add, modify, and delete motion key-pose plans. */
export function AnimationMotionsPanel({
  gameId,
  projectLabel,
  onNotice,
  onMotionsChange,
}: AnimationMotionsPanelProps) {
  const [entries, setEntries] = useState<MotionEntry[]>([]);
  const [saved, setSaved] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoaded(false);
    void api
      .motions(gameId)
      .then((data) => {
        if (cancelled) return;
        setSaved(data);
        setEntries(recordToEntries(data));
        setLoaded(true);
      })
      .catch(() => {
        if (cancelled) return;
        setSaved(DEFAULT_MOTIONS);
        setEntries(recordToEntries(DEFAULT_MOTIONS));
        setLoaded(true);
        onNotice("Could not load motions from server; using defaults.");
      });
    return () => {
      cancelled = true;
    };
  }, [gameId, onNotice]);

  if (!loaded) return null;

  const currentRecord = entriesToRecord(entries);
  const dirty = JSON.stringify(currentRecord) !== JSON.stringify(saved);
  const isDefault = JSON.stringify(currentRecord) === JSON.stringify(DEFAULT_MOTIONS);

  const addMotion = () => {
    setError(null);
    let baseName = "new-motion";
    let counter = 1;
    while (entries.some((e) => e.name.toLowerCase() === baseName.toLowerCase())) {
      baseName = `new-motion-${counter++}`;
    }
    setEntries((current) => [
      ...current,
      {
        id: `motion-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`,
        name: baseName,
        poses: "",
      },
    ]);
  };

  const updateMotion = (id: string, patch: Partial<MotionEntry>) => {
    setError(null);
    setEntries((current) =>
      current.map((item) => (item.id === id ? { ...item, ...patch } : item)),
    );
  };

  const deleteMotion = (id: string) => {
    setError(null);
    setEntries((current) => current.filter((item) => item.id !== id));
  };

  const validate = (): string | null => {
    if (entries.length === 0) return "At least one motion is required.";
    const names = new Set<string>();
    for (const entry of entries) {
      const trimmedName = entry.name.trim();
      if (!trimmedName) return "Every motion must have a name.";
      const slug = trimmedName.toLowerCase().replace(/[^a-z0-9-_]/g, "-");
      if (names.has(slug)) return `Duplicate motion name: "${trimmedName}". Each motion must have a unique name.`;
      names.add(slug);
      if (!entry.poses.trim()) return `Motion "${trimmedName}" must have a key poses description.`;
    }
    return null;
  };

  const save = async () => {
    const validationError = validate();
    if (validationError) {
      setError(validationError);
      onNotice(validationError);
      return;
    }
    setError(null);
    setBusy(true);
    const toSave = entriesToRecord(entries);
    const result = await (gameId ? api.saveMotions(toSave, gameId) : api.saveMotions(toSave)).catch((err: unknown) => ({ error: String(err) }));
    setBusy(false);
    if ("error" in result && result.error) {
      setError(result.error);
      onNotice(`Could not save animation motions: ${result.error}`);
      return;
    }
    setSaved(toSave);
    onMotionsChange?.(toSave);
    const count = Object.keys(toSave).length;
    onNotice(
      projectLabel
        ? `Saved ${count} animation motion${count === 1 ? "" : "s"} for ${projectLabel}.`
        : `Saved ${count} animation motion${count === 1 ? "" : "s"}.`,
    );
  };

  const resetToDefaults = async () => {
    setError(null);
    setBusy(true);
    const result = await (gameId ? api.resetMotions(gameId) : api.resetMotions()).catch((err: unknown) => ({ error: String(err) }));
    setBusy(false);
    if ("error" in result && result.error) {
      onNotice(`Could not reset motions: ${result.error}`);
      return;
    }
    setSaved(DEFAULT_MOTIONS);
    setEntries(recordToEntries(DEFAULT_MOTIONS));
    onMotionsChange?.(DEFAULT_MOTIONS);
    onNotice(
      projectLabel
        ? `Animation motions reset to defaults for ${projectLabel}.`
        : "Animation motions reset to defaults.",
    );
  };

  return (
    <div className="panel settings-group">
      <div className="settings-heading">
        <div>
          <h2>Animation motions</h2>
          <p className="quiet">
            Motion presets for sprite sheet animation{projectLabel ? ` in ${projectLabel}` : ""}. Key poses describe frame-by-frame actions and are fed into the animation brief.
          </p>
        </div>
        <div className="settings-heading-actions">
          <button type="button" onClick={addMotion} disabled={busy}>
            <Icon name="add" />
            <span>New motion</span>
          </button>
          <button
            type="button"
            onClick={() => void resetToDefaults()}
            disabled={busy || isDefault}
            title="Restore standard motions (idle, walk, fly, sway, flow, rotation)"
          >
            Reset to defaults
          </button>
        </div>
      </div>

      {error && (
        <p className="modal-error" role="alert">
          {error}
        </p>
      )}

      {!entries.length ? (
        <p className="empty-state">No animation motions configured. Click &ldquo;New motion&rdquo; or &ldquo;Reset to defaults&rdquo;.</p>
      ) : (
        <div className="motions-list">
          {entries.map((entry) => (
            <div className="motion-editor" key={entry.id}>
              <div className="motion-editor-header">
                <label className="motion-name-field">
                  <span>Motion name</span>
                  <input
                    type="text"
                    value={entry.name}
                    placeholder="e.g. jump"
                    aria-label={`Motion name for ${entry.name || "item"}`}
                    onChange={(event) => updateMotion(entry.id, { name: event.target.value })}
                  />
                </label>
                <button
                  type="button"
                  className="danger icon-button"
                  aria-label={`Delete ${entry.name || "motion"}`}
                  title={`Delete ${entry.name || "motion"}`}
                  onClick={() => deleteMotion(entry.id)}
                >
                  <Icon name="trash" />
                </button>
              </div>
              <label className="motion-poses-field">
                <span>Key poses & prompt instructions</span>
                <textarea
                  value={entry.poses}
                  rows={3}
                  placeholder="Describe the motion cycle, key poses, and timing instructions..."
                  aria-label={`Key poses description for ${entry.name || "motion"}`}
                  onChange={(event) => updateMotion(entry.id, { poses: event.target.value })}
                />
              </label>
            </div>
          ))}
        </div>
      )}

      <div className="settings-actions">
        <button
          type="button"
          className="primary"
          disabled={!dirty || busy}
          onClick={() => void save()}
        >
          {busy ? "Saving…" : "Save motions"}
        </button>
        <small className="quiet">
          {entries.length} motion{entries.length === 1 ? "" : "s"} configured
          {dirty ? " · unsaved changes" : ""}
        </small>
      </div>
    </div>
  );
}
