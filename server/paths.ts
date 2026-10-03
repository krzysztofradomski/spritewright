import { basename, extname, resolve, sep } from 'node:path';
import { mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs';

export function gameIdForDirectory(directory: string) { return directory.trim().toLowerCase().replace(/\s+/g, '-'); }

export function listGames(rootDir: string) {
  const gamesRoot = resolve(rootDir, 'games');
  mkdirSync(gamesRoot, { recursive: true });
  return readdirSync(gamesRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory() && !entry.name.startsWith('.')).map((entry) => ({ id: gameIdForDirectory(entry.name), directory: entry.name, label: entry.name.replace(/\b\w/g, (letter) => letter.toUpperCase()) })).sort((left, right) => left.label.localeCompare(right.label));
}

export function createGame(rootDir: string, name: string) {
  const directory = name.trim().replace(/\s+/g, ' ');
  if (!/^[A-Za-z0-9][A-Za-z0-9 -]{0,59}$/.test(directory)) throw new Error('Use letters, digits, spaces and hyphens (up to 60).');
  const id = gameIdForDirectory(directory);
  if (listGames(rootDir).some((game) => game.id === id)) throw new Error(`A project called ${directory} already exists.`);
  mkdirSync(resolve(rootDir, 'games', directory, 'assets', 'manifests'), { recursive: true });
  return listGames(rootDir).find((game) => game.id === id)!;
}

/** Moves the whole project folder to games/.trash, so a deletion can be undone by hand. */
export function trashGame(rootDir: string, gameId: string) {
  const game = listGames(rootDir).find((candidate) => candidate.id === gameId);
  if (!game) throw new Error(`Unknown game: ${gameId}`);
  const trashDir = resolve(rootDir, 'games', '.trash');
  mkdirSync(trashDir, { recursive: true });
  const trashedPath = resolve(trashDir, `${game.directory}-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  renameSync(resolve(rootDir, 'games', game.directory), trashedPath);
  return { ...game, trashedPath };
}

export function listTrashedGames(rootDir: string) {
  const trashDir = resolve(rootDir, 'games', '.trash');
  let entries: string[] = [];
  try {
    entries = readdirSync(trashDir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch {
    return [];
  }
  return entries
    .map((name) => {
      const match = name.match(/^(.*)-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)$/);
      const directory = match?.[1] ?? name;
      const trashedAt = match ? match[2]!.replace(/T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/, 'T$1:$2:$3.$4Z') : '';
      return { name, directory, label: directory.replace(/\b\w/g, (letter) => letter.toUpperCase()), trashedAt };
    })
    .sort((a, b) => b.trashedAt.localeCompare(a.trashedAt));
}

/** Permanently deletes a project folder from games/.trash; only names the trash listing reports. */
export function deleteTrashedGame(rootDir: string, trashedName: string) {
  const trashed = listTrashedGames(rootDir).find((entry) => entry.name === trashedName);
  if (!trashed) throw new Error('That project is no longer in the trash.');
  rmSync(resolve(rootDir, 'games', '.trash', trashed.name), { recursive: true, force: true });
  return trashed;
}

/** Moves a trashed project folder back under games/, refusing if its name is taken again. */
export function restoreGame(rootDir: string, trashedName: string) {
  const trashed = listTrashedGames(rootDir).find((entry) => entry.name === trashedName);
  if (!trashed) throw new Error('That project is no longer in the trash.');
  const id = gameIdForDirectory(trashed.directory);
  if (listGames(rootDir).some((game) => game.id === id)) throw new Error(`A project called ${trashed.directory} already exists. Rename or delete it first.`);
  renameSync(resolve(rootDir, 'games', '.trash', trashed.name), resolve(rootDir, 'games', trashed.directory));
  return listGames(rootDir).find((game) => game.id === id)!;
}

export function resolveGameAssetsDir(rootDir: string, gameId: string): string {
  const game = listGames(rootDir).find((candidate) => candidate.id === gameId);
  if (!game) throw new Error(`Unknown game: ${gameId}`);
  return resolve(rootDir, 'games', game.directory, 'assets');
}

export function resolveAssetRelativePath(rootDir: string, gameId: string, relativePath: string): string {
  if (!relativePath || (relativePath.startsWith('.') && !relativePath.startsWith('.trash/')) || basename(relativePath) !== relativePath.split('/').at(-1)) {
    throw new Error('Asset path must stay inside its game asset directory.');
  }
  const assetsDir = resolveGameAssetsDir(rootDir, gameId);
  const resolved = resolve(assetsDir, relativePath);
  if (!resolved.startsWith(`${assetsDir}${sep}`)) throw new Error('Asset path must stay inside its game asset directory.');
  return resolved;
}

export function versionedFilename(filename: string, version: number): string {
  const extension = extname(filename);
  const stem = filename.slice(0, filename.length - extension.length);
  return version <= 1 ? filename : `${stem}-v${version}${extension}`;
}
