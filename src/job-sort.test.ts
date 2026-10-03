import { expect, test } from "vitest";
import { estimateJobDurationMs, sortJobs, type StudioJob } from "./job-sort.js";

const jobs: StudioJob[] = [
  {
    id: "old",
    name: "Zinnia",
    state: "queued",
    createdAt: "2026-08-30T08:00:00.000Z",
  },
  {
    id: "new",
    name: "Aster",
    state: "running",
    createdAt: "2026-08-30T10:00:00.000Z",
  },
  {
    id: "middle",
    name: "Fern",
    state: "completed",
    createdAt: "2026-08-30T09:00:00.000Z",
  },
];

test("sorts filtered job records by date, name, and state", () => {
  expect(sortJobs(jobs, "newest").map((job) => job.id)).toEqual([
    "new",
    "middle",
    "old",
  ]);
  expect(sortJobs(jobs, "oldest").map((job) => job.id)).toEqual([
    "old",
    "middle",
    "new",
  ]);
  expect(sortJobs(jobs, "name").map((job) => job.id)).toEqual([
    "new",
    "middle",
    "old",
  ]);
  expect(sortJobs(jobs, "state").map((job) => job.id)).toEqual([
    "middle",
    "old",
    "new",
  ]);
});

test("estimates a running job from similar completed runs, never from nothing", () => {
  const run = (id: string, seconds: number, operation: StudioJob["operation"] = "generate"): StudioJob => ({
    id, state: "completed", provider: "grok", operation,
    startedAt: "2026-08-30T10:00:00.000Z",
    updatedAt: new Date(Date.parse("2026-08-30T10:00:00.000Z") + seconds * 1_000).toISOString(),
  });
  const running: StudioJob = { id: "now", state: "running", provider: "grok", operation: "animate" };
  expect(estimateJobDurationMs([], running)).toBeNull();
  // No animate history yet: fall back to every grok run (median of 20, 40, 60).
  expect(estimateJobDurationMs([run("a", 20), run("b", 40), run("c", 60)], running)).toBe(40_000);
  // Same operation wins once it exists; a run edited after the 5-minute timeout is ignored.
  expect(estimateJobDurationMs([run("a", 20), run("d", 90, "animate"), run("e", 3_600, "animate")], running)).toBe(90_000);
});
