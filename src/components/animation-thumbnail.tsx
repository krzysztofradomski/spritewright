import { useEffect, useState } from "react";
import { api } from "../api/client.js";
import { Icon } from "./icon.js";

export type SavedAnimation = {
  id: string;
  name: string;
  fps: number;
  loop: "loop" | "once" | "ping-pong";
  frames: Array<{
    assetId?: string;
    sourcePath: string;
    rect?: { x: number; y: number; width: number; height: number };
    anchorOffset?: { x: number; y: number };
    anchorScale?: number;
    box?: { width: number; height: number };
  }>;
};

/** Plays a saved animation from its sheet frames, placed the way the manifest recorded. */
export function AnimationThumbnail({ animation, gameId }: { animation: SavedAnimation; gameId: string }) {
  const [index, setIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [pingDirection, setPingDirection] = useState(1);

  // Keep thumbnail static on first render and reset when project or animation changes
  useEffect(() => {
    setPlaying(false);
    setIndex(0);
    setPingDirection(1);
  }, [gameId, animation.id]);

  useEffect(() => {
    const frameCount = animation.frames.length;
    if (!playing || frameCount <= 1) return;
    const intervalMs = Math.round(1000 / Math.max(1, animation.fps || 8));
    const timer = window.setInterval(() => {
      setIndex((current) => {
        if (animation.loop === "once") {
          if (current >= frameCount - 1) {
            setPlaying(false);
            return current;
          }
          return current + 1;
        }
        if (animation.loop === "ping-pong") {
          if (current >= frameCount - 1) {
            setPingDirection(-1);
            return Math.max(0, current - 1);
          }
          if (current <= 0 && pingDirection < 0) {
            setPingDirection(1);
            return Math.min(frameCount - 1, current + 1);
          }
          return current + pingDirection;
        }
        return (current + 1) % frameCount;
      });
    }, intervalMs);
    return () => window.clearInterval(timer);
  }, [playing, animation, pingDirection]);

  const togglePlay = () => {
    setPlaying((wasPlaying) => {
      if (!wasPlaying) {
        if (animation.loop === "once" && index >= animation.frames.length - 1) {
          setIndex(0);
        }
        return true;
      }
      return false;
    });
  };

  const frame = animation.frames[index % Math.max(1, animation.frames.length)];
  if (!frame?.assetId || !frame.rect) return <div className="checker" />;

  const canPlay = animation.frames.length > 1;

  return (
    <div
      className={`checker animation-thumbnail ${playing ? "is-playing" : ""}`}
      onClick={canPlay ? togglePlay : undefined}
    >
      <img
        src={api.spriteFrameUrl(frame.assetId, gameId, frame.rect, frame.anchorOffset, frame.anchorScale, frame.box)}
        alt={`${animation.name} animation preview`}
      />
      {canPlay && (
        <button
          type="button"
          className={`animation-play-overlay ${playing ? "is-playing" : ""}`}
          onClick={(event) => {
            event.stopPropagation();
            togglePlay();
          }}
          aria-label={playing ? `Pause ${animation.name}` : `Play ${animation.name}`}
          title={playing ? "Pause animation" : "Play animation"}
        >
          <Icon name={playing ? "pause" : "play"} fill="currentColor" />
          <span>{playing ? "Pause" : "Play"}</span>
        </button>
      )}
    </div>
  );
}

