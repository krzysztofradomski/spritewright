import { readAppSettings, updateAppSettings } from "./app-settings.js";
import { SettingsStore } from "./settings-store.js";
import type { GameId } from "./types.js";

export const DEFAULT_MOTIONS: Record<string, string> = {
  idle: "1 relaxed neutral stance; 2 breathing in, chest rising and shoulders lifting; 3 top of the breath, the tallest pose; 4 holding at the top, head tilting a touch; 5 breathing out, shoulders settling; 6 back through neutral; 7 the lowest pose, settled just below neutral; 8 easing back up towards pose 1. Feet stay planted; the torso, head, hair, cloth and held items carry the movement.",
  walk: "a walk cycle in place, body facing the same way throughout, with a wide stride: at their furthest apart the feet are about one leg-length apart and the lifted knee bends past 45°. 1 left contact: left heel touching down in front, right foot behind, full stride, right arm forward; 2 left down: weight on the left foot, both knees bent, body at its lowest; 3 left passing: right foot lifted clear and swinging past the left leg, knee high; 4 left up: rising onto the left toes, right leg reaching forward, body at its highest; 5 right contact: right heel touching down in front, full stride, left arm forward; 6 right down: weight on the right foot, body at its lowest; 7 right passing: left foot swinging past the right leg, knee high; 8 right up: rising onto the right toes, left leg reaching forward, body at its highest. Arms swing opposite to the legs; held items move with the hands and keep their shape and length.",
  fly: "a hovering flight loop in place. 1 wings raised fully up, body at its highest; 2 wings sweeping down; 3 wings level with the body; 4 wings driving below the body, body dipping; 5 wings fully down, body at its lowest; 6 wings sweeping back up; 7 wings level again; 8 wings rising towards the top, body lifting back to pose 1. Limbs trail gently with the bob; the body keeps its facing and never turns around.",
  sway: "a gentle sway with the base fixed in place. 1 upright; 2 leaning left; 3 furthest left; 4 easing back, still left of upright; 5 upright; 6 leaning right; 7 furthest right; 8 easing back, still right of upright. Only the upper part bends, more at the tips than near the base; leaves and petals trail the motion.",
  flow: "a flowing loop. Ripples, highlights and foam move steadily one step in the same direction each frame, travelling the full length over all the frames so the last frame hands straight back to frame 1; the outline of the water and any banks stay exactly the same.",
  rotation: "a turntable turning clockwise. 1 front; 2 front-right; 3 right side; 4 back-right; 5 back; 6 back-left; 7 left side; 8 front-left, turning back towards the front. Same size, height and centre in every frame.",
};

export async function readMotions(rootDir: string, gameId?: GameId): Promise<Record<string, string>> {
  if (gameId) {
    const store = new SettingsStore(rootDir);
    const settings = await store.get(gameId);
    if (settings.motions && Object.keys(settings.motions).length > 0) {
      return settings.motions;
    }
  }
  const saved = (await readAppSettings(rootDir)).motions;
  return saved && Object.keys(saved).length > 0 ? saved : { ...DEFAULT_MOTIONS };
}

export async function writeMotions(rootDir: string, motions: Record<string, string>, gameId?: GameId): Promise<Record<string, string>> {
  if (gameId) {
    const store = new SettingsStore(rootDir);
    await store.set(gameId, { motions });
    return motions;
  }
  await updateAppSettings(rootDir, { motions });
  return motions;
}

export async function resetMotions(rootDir: string, gameId?: GameId): Promise<Record<string, string>> {
  if (gameId) {
    const store = new SettingsStore(rootDir);
    await store.set(gameId, { motions: { ...DEFAULT_MOTIONS } });
    return { ...DEFAULT_MOTIONS };
  }
  await updateAppSettings(rootDir, { motions: { ...DEFAULT_MOTIONS } });
  return { ...DEFAULT_MOTIONS };
}
