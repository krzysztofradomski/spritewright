/** Alpha at or below this counts as empty; matte removal leaves faint dust under it. */
const EMPTY_ALPHA = 8;
/** Gaps up to this long inside a line are anti-aliasing dropouts, not the end of it. */
const MAX_GAP = 6;

export type CleanupResult = { lines: number; specks: number };

/**
 * Removes what image models draw around sprites but never belong to them: frame borders and
 * grid lines (long, axis-aligned, at most 3px thick, transparent on both sides) and specks of a
 * few pixels. Works on RGBA data in place, entirely locally. Detached leaves and sparkles
 * survive because they are neither straight lines nor that small.
 */
export function cleanSpriteSheet(data: Uint8ClampedArray, width: number, height: number, maxSpeck = 4): CleanupResult {
  const minLine = Math.max(32, Math.round(Math.min(width, height) * 0.03));
  const lines = eraseLines(data, width, height, "horizontal", minLine) + eraseLines(data, width, height, "vertical", minLine);
  return { lines, specks: eraseSpecks(data, width, height, maxSpeck) };
}

const opaque = (data: Uint8ClampedArray, index: number) => data[index * 4 + 3]! > EMPTY_ALPHA;

function eraseLines(data: Uint8ClampedArray, width: number, height: number, direction: "horizontal" | "vertical", minLine: number) {
  // Along = the line's direction, across = its thickness.
  const [along, across] = direction === "horizontal" ? [width, height] : [height, width];
  const at = (a: number, c: number) => (direction === "horizontal" ? c * width + a : a * width + c);
  const thin = new Uint8Array(width * height);
  for (let a = 0; a < along; a++)
    for (let c = 0; c < across; ) {
      if (!opaque(data, at(a, c))) { c++; continue; }
      let end = c;
      while (end < across && opaque(data, at(a, end))) end++;
      if (end - c <= 3) for (let k = c; k < end; k++) thin[at(a, k)] = 1;
      c = end;
    }
  let erased = 0;
  for (let c = 0; c < across; c++) {
    // Thin segments on this row/column, with small gaps (faint anti-aliasing) bridged.
    const segments: Array<[number, number]> = [];
    for (let a = 0; a < along; a++) {
      if (!thin[at(a, c)]) continue;
      const last = segments[segments.length - 1];
      if (last && a - last[1] <= MAX_GAP) last[1] = a + 1;
      else segments.push([a, a + 1]);
    }
    const long = segments.filter(([start, end]) => end - start >= minLine);
    if (!long.length) continue;
    // A row that holds a real line also takes its shorter broken-off pieces within the line's reach.
    const from = long[0]![0] - minLine;
    const to = long[long.length - 1]![1] + minLine;
    for (const [start, end] of segments) {
      if (end < from || start > to) continue;
      for (let k = start; k < end; k++) {
        if (!thin[at(k, c)]) continue;
        data[at(k, c) * 4 + 3] = 0;
        erased++;
      }
    }
  }
  return erased;
}

function eraseSpecks(data: Uint8ClampedArray, width: number, height: number, maxSpeck: number) {
  const seen = new Uint8Array(width * height);
  let erased = 0;
  for (let start = 0; start < width * height; start++) {
    if (seen[start] || !opaque(data, start)) continue;
    seen[start] = 1;
    const component = [start];
    for (let i = 0; i < component.length; i++) {
      const index = component[i]!;
      const x = index % width;
      const y = (index - x) / width;
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
          const next = ny * width + nx;
          if (!seen[next] && opaque(data, next)) { seen[next] = 1; component.push(next); }
        }
    }
    if (component.length > maxSpeck) continue;
    for (const index of component) data[index * 4 + 3] = 0;
    erased += component.length;
  }
  return erased;
}
