import { useEffect, useState } from "react";
import { api, type TrashContents } from "../api/client.js";
import { Icon } from "../components/icon.js";
import type { DialogRequest } from "../components/modal.js";

/**
 * Removed assets of the current project and deleted projects. Each can be restored, or deleted for
 * good one at a time, as a selection, or all at once with "Empty trash".
 */
export function TrashView({ gameId, projectLabel, onNotice, onAssetRestored, onProjectRestored, openDialog }: {
  gameId: string;
  projectLabel: string;
  onNotice: (message: string) => void;
  onAssetRestored: () => Promise<void>;
  onProjectRestored: () => Promise<void>;
  openDialog: (request: DialogRequest) => void;
}) {
  const [trash, setTrash] = useState<TrashContents | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [selectedAssets, setSelectedAssets] = useState<string[]>([]);
  const [selectedProjects, setSelectedProjects] = useState<string[]>([]);
  const loadTrash = async () => {
    const contents = await api.trash(gameId).catch(() => null);
    if (!contents) return onNotice("Could not read the trash.");
    setTrash(contents);
    // Drop selections for items that no longer exist.
    setSelectedAssets((current) => current.filter((path) => contents.assets.some((item) => item.path === path)));
    setSelectedProjects((current) => current.filter((name) => contents.projects.some((item) => item.name === name)));
  };
  useEffect(() => {
    if (gameId) void loadTrash();
  }, [gameId]);

  const toggle = (setter: typeof setSelectedAssets, key: string, on: boolean) =>
    setter((current) => (on ? [...current, key] : current.filter((item) => item !== key)));

  /** Confirms, then permanently deletes the given assets and projects. */
  const deleteForever = (assetPaths: string[], projectNames: string[], options: { title: string; typed?: boolean }) => {
    const count = assetPaths.length + projectNames.length;
    if (!count) return;
    const projectLabels = trash?.projects.filter((project) => projectNames.includes(project.name)).map((project) => project.label) ?? [];
    openDialog({
      title: options.title,
      message: `This permanently deletes ${count === 1 ? "this item" : `${count} items`} from disk${projectLabels.length ? `, including the whole ${projectLabels.join(", ")} project folder${projectLabels.length > 1 ? "s" : ""}` : ""}. It can't be undone or restored.${options.typed ? " Type delete to confirm." : ""}`,
      confirmLabel: "Delete forever",
      danger: true,
      ...(options.typed ? { input: { label: "Confirmation", placeholder: "delete" } } : {}),
      onConfirm: async (typed) => {
        if (options.typed && typed.toLowerCase() !== "delete") return "Type delete to confirm.";
        setBusy("delete");
        const failures: string[] = [];
        if (assetPaths.length) {
          const result = await api.deleteTrashedAssets(gameId, assetPaths).catch((error: unknown) => ({ error: String(error) }));
          if (result.error) failures.push(result.error);
        }
        if (projectNames.length) {
          const result = await api.deleteTrashedProjects(projectNames).catch((error: unknown) => ({ error: String(error) }));
          if (result.error) failures.push(result.error);
        }
        setBusy(null);
        await loadTrash();
        if (failures.length) return `Some items could not be deleted: ${failures.join(" · ")}`;
        onNotice(`Deleted ${count === 1 ? "1 item" : `${count} items`} forever.`);
      },
    });
  };

  const selectionCount = selectedAssets.length + selectedProjects.length;
  return (
    <section className="trash">
      <div className="trash-heading">
        <p className="quiet">Removed assets and deleted projects wait here until you restore them or delete them forever.</p>
        <div className="trash-actions">
          {selectionCount > 0 && (
            <>
              <small>{selectionCount} selected</small>
              <button className="link-button" onClick={() => { setSelectedAssets([]); setSelectedProjects([]); }}>Clear</button>
              <button className="danger" disabled={busy !== null} onClick={() => deleteForever(selectedAssets, selectedProjects, { title: `Delete ${selectionCount} selected item${selectionCount === 1 ? "" : "s"} forever?` })}>
                Delete selected forever
              </button>
            </>
          )}
          <button
            className="danger"
            disabled={busy !== null || !trash?.assets.length}
            title={`Permanently delete every removed asset in ${projectLabel}`}
            onClick={() => deleteForever(trash?.assets.map((item) => item.path) ?? [], [], { title: `Empty ${projectLabel}'s trash?`, typed: true })}
          >
            <Icon name="trash" />
            Empty trash
          </button>
        </div>
      </div>

      <div className="trash-section-heading">
        <h2 className="section-label">Assets removed from {projectLabel}</h2>
        {trash && trash.assets.length > 1 && (
          <button className="link-button" onClick={() => setSelectedAssets(selectedAssets.length === trash.assets.length ? [] : trash.assets.map((item) => item.path))}>
            {selectedAssets.length === trash.assets.length ? "Deselect all" : "Select all"}
          </button>
        )}
      </div>
      {!trash && <p className="empty-state">Loading…</p>}
      {trash && !trash.assets.length && <p className="empty-state">No removed assets in this project.</p>}
      {trash && trash.assets.length > 0 && (
        <div className="asset-grid">
          {trash.assets.map((item) => (
            <article key={item.path} className={selectedAssets.includes(item.path) ? "is-selected" : undefined}>
              <label className="card-select" title="Select">
                <input type="checkbox" aria-label={`Select ${item.filename}`} checked={selectedAssets.includes(item.path)} onChange={(event) => toggle(setSelectedAssets, item.path, event.target.checked)} />
              </label>
              <div className="asset-preview checker">
                <img src={api.trashFileUrl(gameId, item.path)} alt={item.filename} loading="lazy" />
              </div>
              <strong className="card-title" title={item.filename}>{item.filename}</strong>
              <small className="card-meta">{item.family} · removed {new Date(item.removedAt).toLocaleString()}</small>
              <small>{item.record ? `Restores to ${item.record.state} with its tags and prompt.` : "Removed before details were kept: restores as a new candidate."}</small>
              <div className="card-toolbar">
                <button
                  className="trash-restore"
                  disabled={busy !== null}
                  onClick={async () => {
                    setBusy(item.path);
                    const result = await api.restoreAsset(gameId, item.path).catch((error: unknown) => ({ error: String(error) }));
                    setBusy(null);
                    if (result.error) return onNotice(`Could not restore ${item.filename}: ${result.error}`);
                    onNotice(`${item.filename} restored${"filename" in result && result.filename !== item.filename ? ` as ${result.filename}` : ""}.`);
                    await Promise.all([loadTrash(), onAssetRestored()]);
                  }}
                >
                  {busy === item.path ? "Restoring…" : "Restore"}
                </button>
                <button
                  className="danger icon-button"
                  aria-label={`Delete ${item.filename} forever`}
                  title="Delete forever"
                  disabled={busy !== null}
                  onClick={() => deleteForever([item.path], [], { title: `Delete ${item.filename} forever?` })}
                >
                  <Icon name="trash" />
                </button>
              </div>
            </article>
          ))}
        </div>
      )}

      <h2 className="section-label">Deleted projects</h2>
      {trash && !trash.projects.length && <p className="empty-state">No deleted projects.</p>}
      {trash && trash.projects.length > 0 && (
        <div className="trash-projects">
          {trash.projects.map((project) => (
            <div key={project.name} className={`panel trash-project${selectedProjects.includes(project.name) ? " is-selected" : ""}`}>
              <input type="checkbox" aria-label={`Select ${project.label}`} checked={selectedProjects.includes(project.name)} onChange={(event) => toggle(setSelectedProjects, project.name, event.target.checked)} />
              <Icon name="game" />
              <span>
                <strong>{project.label}</strong>
                <small>{project.trashedAt ? `Deleted ${new Date(project.trashedAt).toLocaleString()}` : "Deleted"}</small>
              </span>
              <button
                disabled={busy !== null}
                onClick={async () => {
                  setBusy(project.name);
                  const result = await api.restoreProject(project.name).catch((error: unknown) => ({ error: String(error) }));
                  setBusy(null);
                  if (result.error || !("id" in result) || !result.id) return onNotice(`Could not restore ${project.label}: ${result.error ?? "unknown error"}`);
                  await onProjectRestored();
                  await loadTrash();
                  onNotice(`${result.label} restored. Pick it in the sidebar.`);
                }}
              >
                {busy === project.name ? "Restoring…" : "Restore project"}
              </button>
              <button
                className="danger icon-button"
                aria-label={`Delete ${project.label} forever`}
                title="Delete forever"
                disabled={busy !== null}
                onClick={() => deleteForever([], [project.name], { title: `Delete the ${project.label} project forever?`, typed: true })}
              >
                <Icon name="trash" />
              </button>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
