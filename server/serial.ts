/**
 * Runs async tasks one at a time. Stores that read a JSON file, change it and write it back
 * wrap every mutation in one of these, so overlapping requests or jobs can't lose records.
 * ponytail: in-process only; a second server writing the same files would still race.
 */
export function createSerialQueue() {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(task: () => Promise<T>): Promise<T> => {
    const run = tail.then(task, task);
    tail = run.catch(() => undefined);
    return run;
  };
}
