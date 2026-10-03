import type { StudioJob } from "./job-sort.js";

export function formatElapsed(startedAt: string, now: number) {
  const seconds = Math.max(
    0,
    Math.floor((now - new Date(startedAt).getTime()) / 1000),
  );
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, "0")}`;
}

/** What the job was asked to make. Jobs from before briefs were saved keep only the full prompt:
 * art direction, then "Asset-specific request:", then any locked template and the typed notes. */
export function jobBrief(job: StudioJob) {
  if (job.brief) return job.brief;
  const after = (text: string | undefined, marker: string) => {
    const at = text?.indexOf(marker) ?? -1;
    return at >= 0 ? text!.slice(at + marker.length) : undefined;
  };
  const request = after(job.prompt, "Asset-specific request:\n") ?? job.prompt;
  const notes = after(request, "Additional production notes:\n");
  if (notes) return notes;
  const operation = jobOperation(job);
  if (operation === "repair") {
    // A fix of a fix nests the earlier repair prompt; the last list is this job's own.
    const marker = "validation issue below:\n";
    const at = request?.lastIndexOf(marker) ?? -1;
    const issues = (at >= 0 ? request!.slice(at + marker.length) : "").split("\n").filter((line) => line.startsWith("- ")).map((line) => line.slice(2));
    return `Fix ${job.references?.[0]?.split("/").pop() ?? job.name ?? "asset"}${issues.length ? `: ${issues.join("; ")}` : ""}`;
  }
  if (operation === "animate" || operation === "remix")
    return `${operation === "animate" ? "Animate" : "Remix"} ${job.references?.[0]?.split("/").pop() ?? job.name ?? "asset"}`;
  return request;
}

export function jobOperation(job: StudioJob) {
  if (job.operation) return job.operation;
  if (
    job.name?.includes("spritemap") ||
    job.prompt?.toLowerCase().includes("animation sprite map")
  )
    return "animate";
  if (
    job.name?.includes("variation") ||
    job.prompt?.toLowerCase().includes("production-ready variation")
  )
    return "remix";
  if (job.prompt?.toLowerCase().includes("repair this existing"))
    return "repair";
  return "generate";
}

export function activeJobLabel(job: StudioJob) {
  const running = job.state === "running";
  switch (jobOperation(job)) {
    case "repair":
      return running ? "Fixing…" : "Fix scheduled";
    case "remix":
      return running ? "Remixing…" : "Remix scheduled";
    case "animate":
      return running ? "Animating…" : "Animation scheduled";
    default:
      return running ? "Generating…" : "Generation scheduled";
  }
}
