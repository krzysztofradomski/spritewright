import type { Dispatch, SetStateAction } from "react";
import { api, type Asset } from "../api/client.js";
import type { DialogRequest } from "../components/modal.js";
import { estimateJobDurationMs, sortJobs, type JobSort, type StudioJob } from "../job-sort.js";
import { formatElapsed, jobBrief } from "../job-labels.js";

/** The job queue for one project: filters, progress, results and retry/stop/delete actions. */
export function JobsView(props: {
  gameId: string;
  projectLabel: string;
  jobs: StudioJob[];
  assets: Asset[];
  now: number;
  jobStateFilter: string;
  setJobStateFilter: Dispatch<SetStateAction<string>>;
  jobSort: JobSort;
  setJobSort: Dispatch<SetStateAction<JobSort>>;
  onRefresh: () => Promise<void>;
  onNotice: (message: string) => void;
  openDialog: (request: DialogRequest) => void;
  confirmPaid: (generator: string | undefined, label: string, action: () => Promise<void>) => Promise<void>;
  onOpenAsset: (asset: Asset) => void;
  onShowInLibrary: (assetId: string) => void;
  onOpenInAnimationLab: (asset: Asset) => void;
}) {
  const { gameId, projectLabel, jobs, assets, now, jobStateFilter, setJobStateFilter, jobSort, setJobSort, onRefresh, onNotice, openDialog, confirmPaid, onOpenAsset, onShowInLibrary, onOpenInAnimationLab } = props;
  return (
    <section>
      <h2 className="visually-hidden">Jobs — {projectLabel}</h2>
      <label className="job-filter" style={{ marginLeft: "0px" }}>
        Refresh status
        <button onClick={() => void onRefresh()}>Refresh status</button>
      </label>

      <label className="job-filter">
        State
        <select
          value={jobStateFilter}
          onChange={(event) => setJobStateFilter(event.target.value)}
        >
          <option value="all">All states</option>
          <option value="queued">Queued</option>
          <option value="running">Running</option>
          <option value="completed">Completed</option>
          <option value="failed">Failed</option>
          <option value="cancelled">Cancelled</option>
        </select>
      </label>
      <label className="job-filter">
        <span>Sort</span>
        <select
          value={jobSort}
          onChange={(event) => setJobSort(event.target.value as JobSort)}
        >
          <option value="newest">Newest first</option>
          <option value="oldest">Oldest first</option>
          <option value="name">Name A–Z</option>
          <option value="state">State</option>
        </select>
      </label>
      <p className="quiet">
        Showing only jobs for the selected game. Pick another game in the
        sidebar to see its queue.
      </p>
      <div className="job-list">
        {sortJobs(
          (jobs as StudioJob[]).filter(
            (job) =>
              job.gameId === gameId &&
              (jobStateFilter === "all" || job.state === jobStateFilter),
          ),
          jobSort,
        ).map((job) => (
          <article className={job.state === "running" ? "job-card is-running" : "job-card"} key={job.id} aria-current={job.state === "running" ? "step" : undefined}>
            <div className="job-card-heading">
              <div>
                <strong>{job.name ?? "Untitled asset"}</strong>
                <small>{job.family ?? "unclassified"}</small>
              </div>
              <span className={`job-state ${job.state ?? "queued"}`}>
                {job.state ?? "queued"}
              </span>
            </div>
            <p>
              {jobBrief(job)?.replace(/\s+/g, " ").slice(0, 220) ??
                "No brief recorded."}
              {(jobBrief(job)?.length ?? 0) > 220 ? "…" : ""}
            </p>
            <footer>
              <small>
                Created{" "}
                {job.createdAt
                  ? new Date(job.createdAt).toLocaleString()
                  : "—"}
              </small>
              <small>
                {job.references?.length ?? 0} reference image(s)
              </small>
            </footer>
            {job.state === "queued" && (
              <small className="job-timing">
                Waiting in the single-file generation queue.
              </small>
            )}
            {job.state === "running" && (() => {
              const elapsed = Math.max(0, now - new Date(job.startedAt ?? job.createdAt ?? now).getTime());
              const estimate = estimateJobDurationMs(jobs as StudioJob[], job);
              const overdue = estimate !== null && elapsed > estimate;
              return (
                <div className="job-progress">
                  {/* ponytail: estimate from past runs, not real progress — providers report none. */}
                  <progress
                    aria-label={`${job.name ?? "Job"} estimated progress`}
                    {...(estimate === null ? {} : { max: 1, value: Math.min(0.95, elapsed / estimate) })}
                  />
                  <small className="job-timing">
                    Running for {formatElapsed(job.startedAt ?? job.createdAt ?? new Date(now).toISOString(), now)}
                    {estimate === null
                      ? " · no finished runs to estimate from yet"
                      : overdue
                        ? " · taking longer than usual"
                        : ` · about ${Math.ceil((estimate - elapsed) / 1_000)}s left`}
                    {" · "}
                    {(() => {
                      // Drawing pixel art is one long model reply, so it gets longer than the five
                      // minutes an image generator is given; saying "5" made a healthy run look
                      // stuck at 2:33.
                      const limitMinutes = job.provider === "svg-pixel" ? 10 : job.provider === "comfyui" ? 30 : 5;
                      return elapsed >= limitMinutes * 60 * 1_000
                        ? `past the ${limitMinutes}-minute limit — stop it if it is still active.`
                        : `stops automatically after ${limitMinutes} minutes.`;
                    })()}
                  </small>
                </div>
              );
            })()}
            {job.state === "completed" && job.assetId && (() => {
              const created = assets.find((asset) => asset.id === job.assetId);
              return created ? (
                <div className="job-result">
                  <button
                    className="asset-preview checker"
                    onClick={() => onOpenAsset(created)}
                    aria-label={`Open ${created.filename} in full view`}
                  >
                    <img src={`/api/assets/${created.id}/file?gameId=${gameId}`} alt="" />
                  </button>
                  <div>
                    <strong>{created.filename}</strong>
                    <small>{created.state}</small>
                    <div className="inline-actions">
                      <button onClick={() => onOpenAsset(created)}>Open asset</button>
                      <button onClick={() => onShowInLibrary(created.id)}>Show in library</button>
                      {created.tags?.includes("animation-spritemap") && (
                        <button onClick={() => onOpenInAnimationLab(created)}>Open in Animation Lab</button>
                      )}
                    </div>
                  </div>
                </div>
              ) : (
                <small className="job-timing">The created asset has since been removed.</small>
              );
            })()}
            {job.generatorNote && <small className="repair-status">{job.generatorNote}</small>}
            {job.error && <small className="warning">{job.error}</small>}
            {(job.state === "queued" || job.state === "running") &&
              job.id && (
                <button
                  className="danger job-cancel"
                  onClick={async () => {
                    onNotice(`Stopping ${job.name ?? "job"}…`);
                    const result = await api.cancelJob(job.id ?? "");
                    onNotice(
                      result.error
                        ? `Could not stop job: ${result.error}`
                        : `${job.name ?? "Job"} cancelled.`,
                    );
                    await onRefresh();
                  }}
                >
                  Stop job
                </button>
              )}
            {job.state === "failed" && job.id && (
              <button
                onClick={() => void confirmPaid(job.provider, `Retrying ${job.name ?? "this job"}`, async () => {
                  onNotice(`Retrying ${job.name ?? "job"}…`);
                  const result = await api.retryJob(job.id ?? "");
                  onNotice(result.error ? `Could not retry job: ${result.error}` : `${job.name ?? "Job"} queued for retry.`);
                  await onRefresh();
                })}
              >
                Retry job
              </button>
            )}
            {job.id && (
              <button
                className="danger job-delete"
                onClick={() => openDialog({
                  title: `Delete ${job.name ?? "this"} job?`,
                  message: job.state === "queued" || job.state === "running"
                    ? "This stops the job and removes it from local history."
                    : "This removes the job from local history.",
                  confirmLabel: "Delete job",
                  danger: true,
                  onConfirm: async () => {
                    const result = await api.deleteJob(job.id ?? "");
                    if (result.error) return `Could not delete job: ${result.error}`;
                    onNotice(`${job.name ?? "Job"} deleted.`);
                    await onRefresh();
                  },
                })}
              >
                Delete job
              </button>
            )}
          </article>
        ))}
        {(jobs as StudioJob[]).filter(
          (job) =>
            job.gameId === gameId &&
            (jobStateFilter === "all" || job.state === jobStateFilter),
        ).length === 0 && <p className="empty-state">No matching jobs.</p>}
      </div>
    </section>
  );
}
