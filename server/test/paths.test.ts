import { expect, test } from 'vitest';
import { listGames, resolveAssetRelativePath, resolveGameAssetsDir, versionedFilename } from '../paths.js';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('keeps asset paths inside a known game asset directory', () => {
  const root = mkdtempSync(join(tmpdir(), 'asset-studio-paths-'));
  mkdirSync(join(root, 'games/pocket-river/assets'), { recursive: true });
  expect(resolveGameAssetsDir(root, 'pocket-river')).toBe(`${root}/games/pocket-river/assets`);
  expect(resolveAssetRelativePath(root, 'pocket-river', 'candidates/plants/reed.png')).toBe(`${root}/games/pocket-river/assets/candidates/plants/reed.png`);
  expect(resolveAssetRelativePath(root, 'pocket-river', '.trash/plants/reed.png')).toBe(`${root}/games/pocket-river/assets/.trash/plants/reed.png`);
  expect(() => resolveAssetRelativePath(root, 'pocket-river', '../../secrets')).toThrow('must stay inside');
  expect(() => resolveGameAssetsDir(root, 'unknown')).toThrow('Unknown game');
});

test('creates a non-destructive versioned filename', () => {
  expect(versionedFilename('reed.png', 2)).toBe('reed-v2.png');
});

test('starts with no games when the games directory is missing', () => {
  expect(listGames(mkdtempSync(join(tmpdir(), 'asset-studio-empty-')))).toEqual([]);
});
