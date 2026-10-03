import { fillBrief, type BriefTemplates } from "./brief-templates.js";

/**
 * Eight key poses per motion. The sheet has sixteen frames: odd frames hold these poses and each
 * even frame is the in-between, which is how a hand-drawn cycle gets smooth without asking the
 * model to invent sixteen distinct poses. A bare verb like "walk" gets near-identical drawings
 * back; spelling out what changes in each pose is what makes models draw a cycle.
 */
export const DEFAULT_MOTIONS: Record<string, string> = {
  idle: "1 relaxed neutral stance; 2 breathing in, chest rising and shoulders lifting; 3 top of the breath, the tallest pose; 4 holding at the top, head tilting a touch; 5 breathing out, shoulders settling; 6 back through neutral; 7 the lowest pose, settled just below neutral; 8 easing back up towards pose 1. Feet stay planted; the torso, head, hair, cloth and held items carry the movement.",
  walk: "a walk cycle in place, body facing the same way throughout, with a wide stride: at their furthest apart the feet are about one leg-length apart and the lifted knee bends past 45°. 1 left contact: left heel touching down in front, right foot behind, full stride, right arm forward; 2 left down: weight on the left foot, both knees bent, body at its lowest; 3 left passing: right foot lifted clear and swinging past the left leg, knee high; 4 left up: rising onto the left toes, right leg reaching forward, body at its highest; 5 right contact: right heel touching down in front, full stride, left arm forward; 6 right down: weight on the right foot, body at its lowest; 7 right passing: left foot swinging past the right leg, knee high; 8 right up: rising onto the right toes, left leg reaching forward, body at its highest. Arms swing opposite to the legs; held items move with the hands and keep their shape and length.",
  fly: "a hovering flight loop in place. 1 wings raised fully up, body at its highest; 2 wings sweeping down; 3 wings level with the body; 4 wings driving below the body, body dipping; 5 wings fully down, body at its lowest; 6 wings sweeping back up; 7 wings level again; 8 wings rising towards the top, body lifting back to pose 1. Limbs trail gently with the bob; the body keeps its facing and never turns around.",
  sway: "a gentle sway with the base fixed in place. 1 upright; 2 leaning left; 3 furthest left; 4 easing back, still left of upright; 5 upright; 6 leaning right; 7 furthest right; 8 easing back, still right of upright. Only the upper part bends, more at the tips than near the base; leaves and petals trail the motion.",
  flow: "a flowing loop. Ripples, highlights and foam move steadily one step in the same direction each frame, travelling the full length over all the frames so the last frame hands straight back to frame 1; the outline of the water and any banks stay exactly the same.",
  rotation: "a turntable turning clockwise. 1 front; 2 front-right; 3 right side; 4 back-right; 5 back; 6 back-left; 7 left side; 8 front-left, turning back towards the front. Same size, height and centre in every frame.",
};
export const MOTIONS = DEFAULT_MOTIONS;
export type Motion = string;

/** A motion that suits the asset, from its name first (a pixie filed under plants still flies), then its family. */
export function motionForAsset(filename: string, family: string, motions: Record<string, string> = DEFAULT_MOTIONS): Motion {
  const keys = Object.keys(motions);
  if (!keys.length) return "idle";
  const pick = (name: string) => (keys.includes(name) ? name : keys[0]!);
  if (/fairy|pixie|bird|bat|butterfly|moth|bee|dragonfly|firefly|ghost|wisp|owl/i.test(filename)) return pick("fly");
  if (/knight|guard|soldier|villager|hero|npc|caretaker|farmer/i.test(filename)) return pick("walk");
  if (/animal|fauna|character|creature/i.test(family)) return pick("walk");
  if (/plant|foliage|tree|flower|grass|reed/i.test(family)) return pick("sway");
  if (/water|river|wave|stream/i.test(family)) return pick("flow");
  return pick("rotation");
}

/**
 * One frame's size. At 256 a 4x4 sheet is exactly 1024x1024 — a canvas every image model draws
 * natively — so the whole sheet comes back from one call, and 256 is still plenty for a sprite.
 */
const FRAME_SIZE = 256;
const [COLUMNS, ROWS] = [4, 4];

/**
 * The frame-by-frame script: key poses on odd frames, in-betweens on even ones. Every frame is
 * named explicitly — "8 key poses for 16 frames" alone gets read as eight frames by smaller models.
 */
export function motionPoses(motion: Motion, frames = COLUMNS * ROWS, motions: Record<string, string> = DEFAULT_MOTIONS): string {
  const description = motions[motion] ?? DEFAULT_MOTIONS[motion] ?? "";
  if (motion === "flow") return description || (DEFAULT_MOTIONS.flow ?? "");
  const keys = frames / 2;
  const plan = Array.from({ length: frames }, (_, index) => {
    const key = Math.floor(index / 2) + 1;
    return index % 2 === 0
      ? `frame ${index + 1} = key pose ${key}`
      : `frame ${index + 1} = halfway between key pose ${key} and key pose ${key === keys ? 1 : key + 1}`;
  });
  return `Key poses: ${description} Draw all ${frames} frames, in this order: ${plan.join("; ")}.`;
}

export function animationDraft(
  asset: {
    filename: string;
    family: string;
    relativePath: string;
    inspection?: { width: number; height: number };
  },
  briefs?: BriefTemplates,
  motion?: Motion,
  motions: Record<string, string> = DEFAULT_MOTIONS,
) {
  const chosenMotion = motion ?? motionForAsset(asset.filename, asset.family, motions);
  const stem = asset.filename.replace(/\.[^.]+$/, "");
  // Each cell holds a whole sprite, so the sheet is frames times one frame; a larger source is
  // drawn down to FRAME_SIZE rather than multiplying an already-large image sixteen times.
  const [columns, rows] = [COLUMNS, ROWS];
  const frameWidth = Math.min(asset.inspection?.width ?? FRAME_SIZE, FRAME_SIZE);
  const frameHeight = Math.min(asset.inspection?.height ?? FRAME_SIZE, FRAME_SIZE);
  const [width, height] = [columns * frameWidth, rows * frameHeight];
  return {
    name: `${stem}-${chosenMotion}-spritemap`,
    family: asset.family,
    width,
    height,
    tags: ["animation-spritemap"],
    references: [asset.relativePath],
    prompt: fillBrief("animation", briefs, {
      motion: chosenMotion, poses: motionPoses(chosenMotion, columns * rows, motions), columns, rows, width, height,
      frames: columns * rows, frameWidth: width / columns, frameHeight: height / rows,
    }),
  };
}


/**
 * A manifest name from the first few words of what was typed, falling back to the sheet's own
 * name. File extensions are dropped so "Animate knight.png" names "animate-knight".
 */
export function manifestName(input: string | undefined, fallback: string, words = 4) {
  const slug = (text: string) =>
    text
      .replace(/\.(png|webp|jpe?g|svg)\b/gi, "")
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(Boolean)
      .slice(0, words)
      .join("-");
  return slug(input ?? "") || slug(fallback) || "animation";
}
