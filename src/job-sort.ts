export type StudioJob = {
  id?: string;
  gameId?: string;
  state?: string;
  name?: string;
  family?: string;
  prompt?: string;
  brief?: string;
  references?: string[];
  operation?: "generate" | "repair" | "remix" | "animate";
  provider?: string;
  assetId?: string;
  createdAt?: string;
  startedAt?: string;
  updatedAt?: string;
  error?: string;
  generatorNote?: string;
};

export type JobSort = "newest" | "oldest" | "name" | "state";

export function sortJobs(jobs: StudioJob[], sort: JobSort) {
  return [...jobs].sort((first, second) => {
    if (sort === "name")
      return (first.name ?? "").localeCompare(second.name ?? "");
    if (sort === "state")
      return (first.state ?? "").localeCompare(second.state ?? "");
    const firstTime = Date.parse(first.createdAt ?? "") || 0;
    const secondTime = Date.parse(second.createdAt ?? "") || 0;
    return sort === "oldest" ? firstTime - secondTime : secondTime - firstTime;
  });
}

const JOB_TIMEOUT_MS = 5 * 60 * 1_000;

/**
 * How long a job like this one usually runs: the median of past completed runs with the
 * same provider and operation, falling back to the same provider alone. Null until there
 * is history, so the UI never shows a made-up number.
 */
export function estimateJobDurationMs(jobs: StudioJob[], job: StudioJob) {
  const durations = (match: (candidate: StudioJob) => boolean) =>
    jobs
      .filter((candidate) => candidate.state === "completed" && candidate.id !== job.id && match(candidate))
      .map((candidate) => Date.parse(candidate.updatedAt ?? "") - Date.parse(candidate.startedAt ?? ""))
      // A completed run can't exceed the timeout; anything longer was touched afterwards.
      .filter((duration) => duration > 0 && duration <= JOB_TIMEOUT_MS)
      .sort((first, second) => first - second);
  const sameKind = durations((candidate) => candidate.provider === job.provider && candidate.operation === job.operation);
  const pool = sameKind.length ? sameKind : durations((candidate) => candidate.provider === job.provider);
  if (!pool.length) return null;
  const middle = Math.floor(pool.length / 2);
  return pool.length % 2 ? pool[middle]! : (pool[middle - 1]! + pool[middle]!) / 2;
}
