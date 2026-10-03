/** Assets that are versions of one another share a family and a name once "-vN" is dropped. */
export function versionGroupKey(asset: { family: string; filename: string }) {
  return `${asset.family}/${asset.filename.replace(/-v\d+(?=\.[^.]+$)/, "")}`;
}

/** Case-insensitive match on filename or any tag; every word in the query must match. */
export function matchesSearch(asset: { filename: string; tags?: string[] }, query: string) {
  const haystack = `${asset.filename} ${(asset.tags ?? []).join(" ")}`.toLowerCase();
  return query.toLowerCase().split(/\s+/).filter(Boolean).every((word) => haystack.includes(word));
}

/**
 * Recovers the brief a user typed from an asset's saved generation prompt, which the server wraps
 * as "<art direction>\n\nAsset-specific request:\n<brief>\nAsset name: … <matte instructions>".
 * The art direction is added again at submit time, so it must not be carried into the form.
 */
export function originalBrief(prompt: string) {
  const afterDirection = prompt.includes("\n\nAsset-specific request:\n")
    ? prompt.slice(prompt.indexOf("\n\nAsset-specific request:\n") + "\n\nAsset-specific request:\n".length)
    : prompt;
  const nameMarker = afterDirection.lastIndexOf("\nAsset name: ");
  return (nameMarker >= 0 ? afterDirection.slice(0, nameMarker) : afterDirection).trim();
}
