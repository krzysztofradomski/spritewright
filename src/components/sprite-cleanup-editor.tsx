import { useEffect, useRef, useState } from "react";
import { api, type Asset } from "../api/client.js";
import { cleanSpriteSheet } from "../sprite-cleanup.js";

// ponytail: each undo step is a full RGBA copy (8 MB at 2048×1024), so history stays short.
const MAX_UNDO = 12;

/** Erases sprite-map artifacts on a canvas, automatically or by hand, and saves the result as a new version. */
export function SpriteCleanupEditor({ asset, gameId, onCancel, onSaved, onNotice }: {
  asset: Asset;
  gameId: string;
  onCancel: () => void;
  onSaved: (created: Asset) => void;
  onNotice: (message: string) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const history = useRef<ImageData[]>([]);
  const last = useRef<{ x: number; y: number } | null>(null);
  const [brush, setBrush] = useState(24);
  const [cursor, setCursor] = useState<{ x: number; y: number; size: number } | null>(null);
  const [undoCount, setUndoCount] = useState(0);
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    const image = new Image();
    image.onload = () => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      canvas.getContext("2d", { willReadFrequently: true })!.drawImage(image, 0, 0);
      setLoaded(true);
    };
    image.src = `/api/assets/${asset.id}/file?gameId=${gameId}`;
  }, [asset.id, gameId]);

  const context = () => canvasRef.current!.getContext("2d", { willReadFrequently: true })!;
  const snapshot = () => {
    const canvas = canvasRef.current!;
    history.current = [...history.current.slice(-(MAX_UNDO - 1)), context().getImageData(0, 0, canvas.width, canvas.height)];
    setUndoCount(history.current.length);
  };
  const toSource = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const scale = event.currentTarget.width / rect.width;
    setCursor({ x: event.clientX - rect.left, y: event.clientY - rect.top, size: brush / scale });
    return { x: (event.clientX - rect.left) * scale, y: (event.clientY - rect.top) * scale };
  };
  const erase = (from: { x: number; y: number }, to: { x: number; y: number }) => {
    const ctx = context();
    ctx.save();
    ctx.globalCompositeOperation = "destination-out";
    ctx.lineCap = "round";
    ctx.lineWidth = brush;
    ctx.beginPath();
    ctx.moveTo(from.x, from.y);
    ctx.lineTo(to.x + 0.01, to.y);
    ctx.stroke();
    ctx.restore();
  };

  return (
    <div className="sprite-cleanup">
      <div className="inline-actions">
        <button
          disabled={!loaded || busy}
          title="Removes frame borders, grid lines and stray specks. Runs locally; no LLM."
          onClick={() => {
            const canvas = canvasRef.current!;
            snapshot();
            const image = context().getImageData(0, 0, canvas.width, canvas.height);
            const { lines, specks } = cleanSpriteSheet(image.data, canvas.width, canvas.height);
            context().putImageData(image, 0, 0);
            onNotice(lines || specks ? `Removed ${lines} line and ${specks} speck pixels. Use the eraser for anything left.` : "Found no lines or specks to remove.");
          }}
        >
          Auto-clean
        </button>
        <label className="brush-size">
          Eraser {brush}px
          <input type="range" min="4" max="160" value={brush} onChange={(event) => setBrush(Number(event.target.value))} />
        </label>
        <button disabled={!undoCount || busy} onClick={() => {
          const previous = history.current.pop();
          if (previous) context().putImageData(previous, 0, 0);
          setUndoCount(history.current.length);
        }}>Undo</button>
        <button disabled={busy} onClick={onCancel}>Cancel</button>
        <button
          className="primary"
          disabled={!undoCount || busy}
          onClick={async () => {
            setBusy(true);
            const blob = await new Promise<Blob | null>((resolve) => canvasRef.current!.toBlob(resolve, "image/png"));
            const created = blob ? await api.saveCleanedSpriteMap(asset.id, gameId, await blob.arrayBuffer()).catch(() => ({ error: "request failed" })) : { error: "could not encode the image" };
            setBusy(false);
            if ("error" in created) return onNotice(`Could not save the cleaned sprite map: ${created.error}`);
            onSaved(created);
          }}
        >
          {busy && <span className="spinner" />}Save as new version
        </button>
      </div>
      <div className="sprite-map-stage checker">
        <canvas
          ref={canvasRef}
          aria-label={`${asset.filename}; drag to erase`}
          onPointerDown={(event) => {
            if (!loaded || busy) return;
            event.currentTarget.setPointerCapture(event.pointerId);
            snapshot();
            const point = toSource(event);
            erase(point, point);
            last.current = point;
          }}
          onPointerMove={(event) => {
            const point = toSource(event);
            if (!last.current) return;
            erase(last.current, point);
            last.current = point;
          }}
          onPointerUp={() => { last.current = null; }}
          onPointerCancel={() => { last.current = null; }}
          onPointerLeave={() => setCursor(null)}
        />
        {cursor && <span className="brush-cursor" style={{ left: cursor.x, top: cursor.y, width: cursor.size, height: cursor.size }} />}
      </div>
      <p className="quiet">Drag over leftovers to erase them. The original stays in the Library; saving adds the next version.</p>
    </div>
  );
}
