export type BriefKind = "animation" | "variation" | "spriteMapVariation";
export type BriefTemplates = Partial<Record<BriefKind, string>>;

/**
 * Default briefs behind Animate and Remix. {placeholders} are filled per asset. The
 * "{columns} columns × {rows} rows" wording is load-bearing: the Animation Lab reads a
 * sprite map's grid back out of the brief it was generated with.
 */
export const DEFAULT_BRIEFS: Record<BriefKind, string> = {
  animation:
    "Create a production-ready {motion} animation sprite map from this reference asset. Deliver exactly {frames} frames arranged in a {columns} columns × {rows} rows grid on a {width}×{height} canvas (each frame is {frameWidth}×{frameHeight}), read left to right, top row first. " +
    "Frame by frame: {poses} " +
    "Each frame must show a clearly different pose from its neighbours; never repeat the same drawing. " +
    "Push the motion far enough to read at a glance: limbs, wings or stems visibly change angle between frames, and a pose that only shifts weight or tilts slightly is wrong. " +
    "Every frame shows the same subject as the reference: identical design, colours, costume, proportions and props, at the same scale, facing the same direction, centred in its cell and standing on the same baseline, with empty padding so nothing crosses into a neighbouring cell. " +
    "The last frame flows back into the first, so the animation loops seamlessly. Preserve the fixed isometric 2.5D perspective, upper-left lighting, and readable silhouette. No grid lines, borders, frame numbers, text, labels, checkerboard, scenery, ground, shadows, or camera movement.",
  variation:
    "Create one production-ready variation of this reference asset. Preserve its subject, fixed isometric 2.5D perspective, readable silhouette, and shared art direction while changing the visual details enough to be a distinct reusable sprite.",
  spriteMapVariation:
    "Create one production-ready variation of this reference animation sprite map. Keep exactly its sprite-sheet layout: the same frame count in {columns} columns × {rows} rows, the same cell size and frame order, on a {width}×{height} canvas with transparent padding between frames. Every frame shows the same varied subject at the same scale and baseline, and only the pose or motion changes between frames. Preserve the fixed isometric 2.5D perspective, readable silhouette, and shared art direction while changing the visual details enough to be a distinct reusable animation.",
};

export const BRIEF_PLACEHOLDERS: Record<BriefKind, string[]> = {
  animation: ["motion", "poses", "frames", "columns", "rows", "width", "height", "frameWidth", "frameHeight"],
  variation: [],
  spriteMapVariation: ["columns", "rows", "width", "height"],
};

export function fillBrief(kind: BriefKind, templates: BriefTemplates | undefined, values: Record<string, string | number>) {
  return (templates?.[kind] || DEFAULT_BRIEFS[kind]).replace(/\{(\w+)\}/g, (token, key: string) =>
    key in values ? String(values[key]) : token);
}

/** Problems that would break a generated sheet, shown next to the editor. */
export function briefWarnings(kind: BriefKind, template: string) {
  const warnings: string[] = [];
  if (BRIEF_PLACEHOLDERS[kind].includes("columns") && !/\{columns\}\s*columns?\s*×\s*\{rows\}\s*rows?/.test(template))
    warnings.push("Keep “{columns} columns × {rows} rows”: the Animation Lab reads the grid from it.");
  const unknown = [...template.matchAll(/\{(\w+)\}/g)].map((match) => match[1]!).filter((key) => !BRIEF_PLACEHOLDERS[kind].includes(key));
  if (unknown.length) warnings.push(`Unknown placeholder${unknown.length > 1 ? "s" : ""}: ${unknown.map((key) => `{${key}}`).join(", ")}.`);
  return warnings;
}
