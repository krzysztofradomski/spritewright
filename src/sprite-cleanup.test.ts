import { expect, test } from "vitest";
import { cleanSpriteSheet } from "./sprite-cleanup.js";

const W = 200;
const H = 120;
const sheet = () => new Uint8ClampedArray(W * H * 4);
const paint = (data: Uint8ClampedArray, x: number, y: number, alpha = 255) => { data[(y * W + x) * 4 + 3] = alpha; };
const alpha = (data: Uint8ClampedArray, x: number, y: number) => data[(y * W + x) * 4 + 3];

test("erases frame borders, broken line pieces and specks but keeps sprites and sparkles", () => {
  const data = sheet();
  for (let x = 10; x < 190; x++) if (x % 40 !== 0) paint(data, x, 5); // border with faint dropouts
  for (let y = 10; y < 110; y++) paint(data, 5, y); // vertical border
  for (let y = 40; y < 80; y++) for (let x = 60; x < 100; x++) paint(data, x, y); // sprite
  for (let x = 60; x < 140; x++) paint(data, x, 60); // thin straight detail touching the sprite
  for (let y = 20; y < 23; y++) for (let x = 120; x < 123; x++) paint(data, x, y); // 9px sparkle
  paint(data, 170, 100); // speck

  const result = cleanSpriteSheet(data, W, H);

  expect(alpha(data, 50, 5)).toBe(0);
  expect(alpha(data, 185, 5)).toBe(0);
  expect(alpha(data, 5, 50)).toBe(0);
  expect(alpha(data, 170, 100)).toBe(0);
  expect(alpha(data, 80, 60)).toBe(255);
  expect(alpha(data, 121, 21)).toBe(255);
  expect(result.specks).toBe(1);
  expect(result.lines).toBeGreaterThan(250);
});
