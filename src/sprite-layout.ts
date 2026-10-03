export type GridLayout = { columns: number; rows: number };

/**
 * The layout a sprite map was generated with, read from its generation prompt. An explicit
 * "C columns × R rows" wins. A bare frame count is laid out the way an image model tends
 * to draw it: of the factor pairs of the count, the one with the squarest cells, because
 * frames are square and a model asked for one row often returns a grid anyway.
 */
export function requestedGridLayout(prompt: string | undefined, width: number, height: number): GridLayout | null {
  if (!prompt) return null;
  const grid = prompt.match(/(\d+)\s*columns?\s*[×x*]\s*(\d+)\s*rows?/i);
  // The editor offers 1–16 per axis; anything outside that is a misread, not a layout.
  if (grid) return [grid[1], grid[2]].every((value) => Number(value) >= 1 && Number(value) <= 16) ? { columns: Number(grid[1]), rows: Number(grid[2]) } : null;
  const count = Number(prompt.match(/(\d+)\s+(?:[a-z-]+\s+){0,2}frames\b/i)?.[1]);
  if (!Number.isInteger(count) || count < 2 || count > 64) return null;
  let best: GridLayout & { score: number } | null = null;
  for (let columns = 1; columns <= count; columns++) {
    if (count % columns) continue;
    const rows = count / columns;
    const score = Math.abs(Math.log((width / columns) / (height / rows)));
    if (!best || score < best.score) best = { columns, rows, score };
  }
  return best && { columns: best.columns, rows: best.rows };
}
