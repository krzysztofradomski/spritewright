import { useEffect, useMemo, useRef, useState } from "react";
import { api, type Asset, type ProviderStatus, type SpendSummary } from "./api/client.js";
import { matchesSearch, originalBrief, versionGroupKey } from "./library.js";
import type { JobSort, StudioJob } from "./job-sort.js";
import { variationDraft } from "./variation.js";
import { animationDraft, manifestName, MOTIONS, motionForAsset, type Motion } from "./animation-draft.js";
import { composeGenerationBrief } from "./brief-composer.js";
import type { BriefTemplates } from "./brief-templates.js";
import { AnimationThumbnail, type SavedAnimation } from "./components/animation-thumbnail.js";
import { GENERATORS, GeneratorSelect, isGeneratorBlocked, isPaidGenerator, usd, type GeneratorId } from "./components/generator-select.js";
import { Icon } from "./components/icon.js";
import { Modal, type DialogRequest } from "./components/modal.js";
import { ProjectMenu } from "./components/project-menu.js";
import { ProjectSwitcher } from "./components/project-switcher.js";
import { SpriteCleanupEditor } from "./components/sprite-cleanup-editor.js";
import { activeJobLabel, jobBrief } from "./job-labels.js";
import { TrashView } from "./views/trash-view.js";
import { SettingsView, type StyleChoice, type ThemeChoice } from "./views/settings-view.js";
import { ArtDirectionView } from "./views/art-direction-view.js";
import { JobsView } from "./views/jobs-view.js";

type ProtectedBrief = {
  kind: "variation" | "animation";
  text: string;
  locked: boolean;
  /** Animation only: the chosen motion and the asset it animates, so the brief can be redrawn. */
  motion?: Motion;
  source?: { filename: string; family: string; relativePath: string };
};

type SpriteMapGrid = {
  width: number;
  height: number;
  yCuts: number[];
  /** Column cuts per row — a generated sheet's rows rarely line up. */
  xCuts: number[][];
  confidence: "high" | "medium" | "low";
  reason?: string | undefined;
};

type FrameAnchors = {
  offsets: Array<{ x: number; y: number }>;
  scales: number[];
  box: { width: number; height: number };
};

type GridDrag = { axis: "x" | "y"; index: number; row: number };

function makeEvenCuts(length: number, count: number) {
  return Array.from({ length: count + 1 }, (_, index) =>
    Math.round((index * length) / count),
  );
}

function gridRects(grid: SpriteMapGrid | null) {
  if (!grid) return [];
  return grid.yCuts.flatMap((top, row) =>
    row === grid.yCuts.length - 1
      ? []
      : grid.xCuts[row]!.flatMap((left, column, cuts) =>
          column === cuts.length - 1
            ? []
            : [
                {
                  x: left,
                  y: top,
                  width: cuts[column + 1]! - left,
                  height: grid.yCuts[row + 1]! - top,
                },
              ],
        ),
  );
}

const NAV_ITEMS = [
  { id: "generate", label: "Generate" },
  { id: "library", label: "Library" },
  { id: "jobs", label: "Jobs" },
  { id: "animation", label: "Animation Lab" },
  { id: "direction", label: "Art direction" },
  { id: "trash", label: "Trash" },
  { id: "settings", label: "Settings" },
] as const;


const THEME_STORAGE_KEY = "asset-studio.theme";
const STYLE_STORAGE_KEY = "asset-studio.style";

/** Jobs at least this long earn a desktop notification when they finish in the background. */
const LONG_JOB_MS = 30_000;

const SELECTED_GAME_STORAGE_KEY = "asset-studio.selected-game";

export function App() {
  const [games, setGames] = useState<Array<{ id: string; label: string }>>([]);
  const [gameId, setGameId] = useState(
    () => window.localStorage.getItem(SELECTED_GAME_STORAGE_KEY) ?? "",
  );
  const [assets, setAssets] = useState<Asset[]>([]);
  const [theme, setTheme] = useState<ThemeChoice>(() => {
    const saved = window.localStorage.getItem(THEME_STORAGE_KEY);
    return saved === "light" || saved === "dark" ? saved : "auto";
  });
  const [style, setStyle] = useState<StyleChoice>(() =>
    window.localStorage.getItem(STYLE_STORAGE_KEY) === "classic" ? "classic" : "diorama",
  );
  const [tab, setTab] = useState<(typeof NAV_ITEMS)[number]["id"]>("library");
  const [prompt, setPrompt] = useState("");
  const [name, setName] = useState("");
  const [family, setFamily] = useState("plants");
  const [width, setWidth] = useState(1024);
  const [height, setHeight] = useState(1024);
  const [generationTags, setGenerationTags] = useState<string[]>([]);
  const [protectedBrief, setProtectedBrief] = useState<ProtectedBrief | null>(
    null,
  );
  const [generationOperation, setGenerationOperation] = useState<
    "generate" | "remix" | "animate"
  >("generate");
  const [provider, setProvider] = useState<GeneratorId>("delegate-antigravity");
  const [jobs, setJobs] = useState<unknown[]>([]);
  const [frame, setFrame] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [selectedSpriteMapId, setSelectedSpriteMapId] = useState("");
  const [spriteGrid, setSpriteGrid] = useState<SpriteMapGrid | null>(null);
  const [frameAnchors, setFrameAnchors] = useState<FrameAnchors | null>(null);
  const [anchorMode, setAnchorMode] = useState<"subject" | "base">("subject");
  const [gridDrag, setGridDrag] = useState<GridDrag | null>(null);
  const [isDetectingGrid, setIsDetectingGrid] = useState(false);
  const [isAligningFrames, setIsAligningFrames] = useState(false);
  const [isCleaning, setIsCleaning] = useState(false);
  const [animationFps, setAnimationFps] = useState(8);
  const [animationLoop, setAnimationLoop] = useState<"loop" | "once" | "ping-pong">("loop");
  const [pingDirection, setPingDirection] = useState(1);
  const spriteMapRef = useRef<HTMLDivElement>(null);
  const [animationName, setAnimationName] = useState("idle-loop");
  const [savedAnimations, setSavedAnimations] = useState<SavedAnimation[]>([]);
  const [motions, setMotions] = useState<Record<string, string>>(MOTIONS);
  const [globalPrompt, setGlobalPrompt] = useState("");
  const [briefs, setBriefs] = useState<BriefTemplates>({});
  const [savedBriefs, setSavedBriefs] = useState<BriefTemplates>({});
  const [savedGlobalPrompt, setSavedGlobalPrompt] = useState("");
  const [references, setReferences] = useState<string[]>([]);
  const [notice, setNotice] = useState("");
  const [tagFilter, setTagFilter] = useState("");
  const [search, setSearch] = useState("");
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [compareKey, setCompareKey] = useState<string | null>(null);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [focusedAssetId, setFocusedAssetId] = useState("");
  const [sortBy, setSortBy] = useState<"newest" | "name">("newest");
  const [jobStateFilter, setJobStateFilter] = useState("all");
  const [jobSort, setJobSort] = useState<JobSort>("newest");
  const [isEnhancing, setIsEnhancing] = useState(false);
  const [now, setNow] = useState(Date.now());
  const [lightboxAsset, setLightboxAsset] = useState<Asset | null>(null);
  const [providers, setProviders] = useState<ProviderStatus[] | null>(null);
  const [animationExports, setAnimationExports] = useState<Record<string, { directory: string; files: Array<{ kind: string; filename: string }> } | "busy">>({});
  const [spend, setSpend] = useState<SpendSummary | null>(null);
  /** Runs `action` straight away, or after a cost confirmation when `generator` is paid. */
  const confirmPaid = async (generator: string | undefined, label: string, action: () => Promise<void>) => {
    if (!isPaidGenerator(generator as GeneratorId)) return action();
    const account = GENERATORS.find((item) => item.id === generator)!.label;
    const summary = await api.spend().catch(() => null);
    if (summary) setSpend(summary);
    const credit = providers?.find((item) => item.id === generator)?.quota?.[0]?.remaining;
    const spend = summary?.providers[generator!];
    openDialog({
      title: `Spend ${account} credit?`,
      message: spend
        ? `${label} costs about ${usd(spend.estimateUsd)}. ${account} today: ${usd(spend.spentTodayUsd)} spent, ${usd(spend.pendingUsd)} queued, daily limit ${usd(spend.limitUsd)}.${credit ? ` Account: ${credit}.` : ""}`
        : `${label} spends ${account} credit.`,
      confirmLabel: "Queue paid job",
      onConfirm: async () => {
        await action();
        void api.spend().then(setSpend).catch(() => undefined);
      },
    });
  };
  const [providerBusy, setProviderBusy] = useState<string | null>(null);
  const checkProviders = async () => {
    setProviderBusy("all");
    try {
      setProviders(await api.providers());
    } catch {
      setNotice("Could not check image providers.");
    } finally {
      setProviderBusy(null);
    }
  };
  useEffect(() => {
    if (tab === "generate" && !providers && !providerBusy) void checkProviders();
    if (tab === "settings" || tab === "generate")
      void api.spend().then(setSpend).catch(() => undefined);
  }, [tab]);
  useEffect(() => {
    // Never leave an exhausted generator selected; move to the first free one that can run.
    // A paid provider is never picked automatically: spending credit must be a deliberate choice.
    if (providers && isGeneratorBlocked(providers, provider)) {
      const next = GENERATORS.find((generator) => !generator.paid && !isGeneratorBlocked(providers, generator.id));
      if (next) setProvider(next.id);
    }
  }, [providers, provider]);
  const selectedGeneratorBlocked = Boolean(providers && isGeneratorBlocked(providers, provider));
  const [dialog, setDialog] = useState<(DialogRequest & { key: number }) | null>(null);
  const openDialog = (request: DialogRequest) => setDialog({ ...request, key: Date.now() });
  const reloadGames = async (select?: string) => {
    const discovered = await api.games();
    setGames(discovered);
    setGameId((current) => {
      const preferred = select ?? current;
      return discovered.some((game) => game.id === preferred) ? preferred : discovered[0]?.id || "";
    });
  };
  const createProject = () =>
    openDialog({
      title: "New project",
      message: "The project becomes a folder under games/.",
      confirmLabel: "Create project",
      input: { label: "Project name", placeholder: "Moss Town" },
      onConfirm: async (name) => {
        const created = await api.createGame(name);
        if (created.error || !created.id) return created.error ?? "The project could not be created.";
        await reloadGames(created.id);
        setNotice(`Created ${created.label}. Add its art direction in Art direction.`);
      },
    });
  const removeAnimation = (animation: SavedAnimation) =>
    openDialog({
      title: `Delete ${animation.name}?`,
      message: "Only the manifest is deleted. Its sprite sheet and any files already exported stay where they are.",
      confirmLabel: "Delete manifest",
      danger: true,
      onConfirm: async () => {
        const result = await api.deleteAnimation(animation.id, gameId);
        if (result.error) return `Could not delete: ${result.error}`;
        setSavedAnimations(await api.animations(gameId));
        setNotice(`${animation.name} manifest deleted.`);
      },
    });
  const deleteProject = (id: string) => {
    const label = games.find((game) => game.id === id)?.label ?? id;
    openDialog({
      title: `Delete ${label}?`,
      message: "The whole project folder, with its assets, animations and art direction, moves to games/.trash. Type the project name to confirm.",
      confirmLabel: "Delete project",
      danger: true,
      input: { label: "Project name", placeholder: label },
      onConfirm: async (typed) => {
        if (typed !== label) return `That doesn't match. Type “${label}” exactly (capitals and hyphens included).`;
        const result = await api.deleteGame(id);
        if (result.error) return result.error;
        await reloadGames(id === gameId ? "" : gameId);
        setNotice(`${label} moved to games/.trash.`);
      },
    });
  };
  const load = async () => {
    if (!gameId) return;
    setAssets(await api.assets(gameId));
    setJobs(await api.jobs());
  };
  useEffect(() => {
    void api.games().then((discovered) => {
      setGames(discovered);
      setGameId((current) => {
        const saved = window.localStorage.getItem(SELECTED_GAME_STORAGE_KEY);
        const preferred = current || saved || "";
        return discovered.some((game) => game.id === preferred)
          ? preferred
          : discovered[0]?.id || "";
      });
    });
    void api.motions().then(setMotions).catch(() => undefined);
  }, []);
  useEffect(() => {
    // index.html applies the saved theme before first paint; this keeps it in sync after.
    if (theme === "auto") delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = theme;
    window.localStorage.setItem(THEME_STORAGE_KEY, theme);
  }, [theme]);
  useEffect(() => {
    if (style === "classic") document.documentElement.dataset.style = "classic";
    else delete document.documentElement.dataset.style;
    window.localStorage.setItem(STYLE_STORAGE_KEY, style);
  }, [style]);
  useEffect(() => {
    if (gameId)
      window.localStorage.setItem(SELECTED_GAME_STORAGE_KEY, gameId);
  }, [gameId]);
  useEffect(() => {
    if (!gameId) return;
    void load();
    setSelectedSpriteMapId("");
    setSpriteGrid(null);
    setFrameAnchors(null);
    setFrame(0);
    setReferences([]);
    void api.animations(gameId).then(setSavedAnimations);
    void api.settings(gameId).then((settings) => {
      setGlobalPrompt(settings.globalPrompt);
      setSavedGlobalPrompt(settings.globalPrompt);
      setBriefs(settings.briefs ?? {});
      setSavedBriefs(settings.briefs ?? {});
    });
    void api.motions(gameId).then(setMotions).catch(() => undefined);
  }, [gameId]);
  useEffect(() => {
    const frameCount = gridRects(spriteGrid).length;
    if (!playing || frameCount === 0) return;
    const timer = window.setInterval(
      () => setFrame((current) => {
        if (animationLoop === "once") {
          if (current >= frameCount - 1) { setPlaying(false); return current; }
          return current + 1;
        }
        if (animationLoop === "ping-pong") {
          if (current >= frameCount - 1) { setPingDirection(-1); return Math.max(0, current - 1); }
          if (current <= 0 && pingDirection < 0) { setPingDirection(1); return Math.min(frameCount - 1, current + 1); }
          return current + pingDirection;
        }
        return (current + 1) % frameCount;
      }),
      Math.round(1000 / animationFps),
    );
    return () => window.clearInterval(timer);
  }, [playing, spriteGrid, animationFps, animationLoop, pingDirection]);
  useEffect(() => {
    if (!gridDrag || !spriteMapRef.current || !spriteGrid) return;
    const onMove = (event: PointerEvent) => {
      const bounds = spriteMapRef.current?.getBoundingClientRect();
      if (!bounds) return;
      const length = gridDrag.axis === "x" ? spriteGrid.width : spriteGrid.height;
      const position = gridDrag.axis === "x"
        ? Math.round(((event.clientX - bounds.left) / bounds.width) * length)
        : Math.round(((event.clientY - bounds.top) / bounds.height) * length);
      const cuts = gridDrag.axis === "x" ? spriteGrid.xCuts[gridDrag.row]! : spriteGrid.yCuts;
      const minimum = cuts[gridDrag.index - 1]! + 16;
      const maximum = cuts[gridDrag.index + 1]! - 16;
      const next = Math.max(minimum, Math.min(maximum, position));
      setSpriteGrid((current) => {
        if (!current) return current;
        const nextCuts = [...(gridDrag.axis === "x" ? current.xCuts[gridDrag.row]! : current.yCuts)];
        nextCuts[gridDrag.index] = next;
        // A hand-placed guide is the user's call, so the detector's note no longer applies.
        return gridDrag.axis === "x"
          ? { ...current, xCuts: current.xCuts.map((cuts, row) => row === gridDrag.row ? nextCuts : cuts), reason: undefined }
          : { ...current, yCuts: nextCuts, reason: undefined };
      });
    };
    const onUp = () => setGridDrag(null);
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp, { once: true });
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, [gridDrag, spriteGrid]);
  useEffect(() => {
    if (!(jobs as StudioJob[]).some((job) => job.state === "running")) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [jobs]);
  useEffect(() => {
    if (
      !gameId ||
      !(jobs as StudioJob[]).some(
        (job) => job.state === "queued" || job.state === "running",
      )
    )
      return;
    const refresh = () => {
      void Promise.all([api.assets(gameId), api.jobs()]).then(
        ([nextAssets, nextJobs]) => {
          setAssets(nextAssets);
          setJobs(nextJobs);
        },
      );
    };
    const timer = window.setInterval(refresh, 2_000);
    return () => window.clearInterval(timer);
  }, [gameId, jobs]);
  const visibleAssets = useMemo(
    () =>
      assets
        .filter((asset) => !tagFilter || (asset.tags ?? []).includes(tagFilter))
        .filter((asset) => matchesSearch(asset, search))
        .sort((a, b) =>
          sortBy === "name"
            ? a.filename.localeCompare(b.filename)
            // Ids are random UUIDs, so "newest" has to use the creation time.
            : (b.createdAt ?? "").localeCompare(a.createdAt ?? ""),
        ),
    [assets, sortBy, tagFilter, search],
  );
  // The full view steps through what the Library shows; an asset opened from elsewhere (a job
  // card) that the filters hide steps through the whole project instead.
  const lightboxList = lightboxAsset && visibleAssets.some((asset) => asset.id === lightboxAsset.id) ? visibleAssets : assets;
  const lightboxIndex = lightboxAsset ? lightboxList.findIndex((asset) => asset.id === lightboxAsset.id) : -1;
  const stepLightbox = (delta: number) =>
    setLightboxAsset((current) => {
      const index = current ? lightboxList.findIndex((asset) => asset.id === current.id) : -1;
      if (index < 0 || lightboxList.length < 2) return current;
      return lightboxList[(index + delta + lightboxList.length) % lightboxList.length]!;
    });
  useEffect(() => {
    if (!lightboxAsset) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setLightboxAsset(null);
      else if (event.key === "ArrowRight") stepLightbox(1);
      else if (event.key === "ArrowLeft") stepLightbox(-1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });
  const versionGroups = useMemo(() => {
    const groups = new Map<string, Asset[]>();
    for (const asset of assets) groups.set(versionGroupKey(asset), [...(groups.get(versionGroupKey(asset)) ?? []), asset]);
    for (const group of groups.values()) group.sort((a, b) => (a.version ?? 1) - (b.version ?? 1));
    return groups;
  }, [assets]);
  // Selection only ever refers to assets that still exist in this project.
  useEffect(() => {
    setSelectedIds((current) => current.filter((id) => assets.some((asset) => asset.id === id)));
  }, [assets]);
  const selectedAssets = assets.filter((asset) => selectedIds.includes(asset.id));
  const runBulk = async (label: string, action: (asset: Asset) => Promise<{ error?: string } | undefined>) => {
    setBulkBusy(true);
    const failures: string[] = [];
    // One at a time: each call rewrites a manifest, and the server serializes them anyway.
    for (const asset of selectedAssets) {
      const result = await action(asset).catch((error: unknown) => ({ error: String(error) }));
      if (result?.error) failures.push(`${asset.filename}: ${result.error}`);
    }
    setBulkBusy(false);
    setSelectedIds([]);
    await load();
    setSavedAnimations(await api.animations(gameId));
    setNotice(failures.length ? `${label}: ${selectedAssets.length - failures.length} done, ${failures.length} failed. ${failures.join(" · ")}` : `${label}: ${selectedAssets.length} done.`);
  };
  const regenerate = (asset: Asset) => {
    const brief = asset.provenance?.prompt ? originalBrief(asset.provenance.prompt) : "";
    const existing = new Set(assets.map((item) => item.relativePath));
    setName(asset.filename.replace(/\.[^.]+$/, "").replace(/-v\d+$/, ""));
    setFamily(asset.family);
    setWidth(Math.max(256, Math.min(2048, asset.inspection?.width ?? 1024)));
    setHeight(Math.max(256, Math.min(2048, asset.inspection?.height ?? 1024)));
    setReferences((asset.provenance?.referencePaths ?? []).filter((path) => existing.has(path)));
    setGenerationTags([]);
    setGenerationOperation("generate");
    setProtectedBrief(null);
    setPrompt(brief);
    setTab("generate");
    setNotice(brief ? `Loaded the brief ${asset.filename} was made from. Adjust it and queue a new version.` : `${asset.filename} has no saved brief; describe it and queue a new version.`);
  };
  const tags = useMemo(
    () => [...new Set(assets.flatMap((asset) => asset.tags ?? []))].sort(),
    [assets],
  );
  const spriteMaps = useMemo(
    () => assets.filter((asset) => (asset.tags ?? []).includes("animation-spritemap")),
    [assets],
  );
  const selectedSpriteMap = spriteMaps.find((asset) => asset.id === selectedSpriteMapId);
  const spriteRects = gridRects(spriteGrid);
  const currentSpriteRect = spriteRects[Math.min(frame, Math.max(0, spriteRects.length - 1))];
  const detectGrid = async (id: string, layout?: { columns: number; rows: number }) => {
    setIsDetectingGrid(true);
    const detected = await api.detectSpriteGrid(id, gameId, layout);
    setIsDetectingGrid(false);
    if (detected.error || !detected.width || !detected.height || !detected.xCuts || !detected.yCuts) {
      setNotice(detected.error ?? "Could not detect a frame grid.");
      return;
    }
    setFrameAnchors(null);
    setFrame(0);
    setSpriteGrid(detected as SpriteMapGrid);
  };
  const openSpriteMap = async (id: string, filename = spriteMaps.find((asset) => asset.id === id)?.filename ?? "") => {
    setSelectedSpriteMapId(id);
    setIsCleaning(false);
    // Name the manifest after what was asked for, not a fixed placeholder every sheet shares.
    const source = (jobs as StudioJob[]).find((job) => job.assetId === id);
    setAnimationName(manifestName(source ? jobBrief(source) : undefined, filename));
    // Rooted motion (a sway) must keep its base still, or centring cancels the sway.
    setAnchorMode(/sway|sprout|bloom|grow/i.test(filename) ? "base" : "subject");
    setFrame(0);
    setPlaying(false);
    setSpriteGrid(null);
    setFrameAnchors(null);
    if (id) await detectGrid(id);
  };
  // When an animation this page was waiting on finishes, take the user straight to it —
  // but only if they are still watching the job list, never out from under other work.
  useEffect(() => {
    if (tab !== "library" || !focusedAssetId) return;
    document.getElementById(`asset-${focusedAssetId}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
    const timer = window.setTimeout(() => setFocusedAssetId(""), 2_500);
    return () => window.clearTimeout(timer);
  }, [tab, focusedAssetId]);
  const previousJobStates = useRef(new Map<string, string | undefined>());
  useEffect(() => {
    const previous = previousJobStates.current;
    const finished = (jobs as StudioJob[]).find((job) =>
      job.id && job.gameId === gameId && job.operation === "animate" && job.state === "completed" && job.assetId &&
      (previous.get(job.id) === "running" || previous.get(job.id) === "queued"));
    // Tell the user about long jobs that finished while the studio tab was in the background.
    if (typeof Notification !== "undefined" && Notification.permission === "granted" && document.hidden)
      for (const job of jobs as StudioJob[]) {
        const wasActive = previous.get(job.id ?? "") === "running" || previous.get(job.id ?? "") === "queued";
        const done = job.state === "completed" || job.state === "failed";
        const tookMs = job.startedAt && job.updatedAt ? Date.parse(job.updatedAt) - Date.parse(job.startedAt) : 0;
        if (!wasActive || !done || tookMs < LONG_JOB_MS) continue;
        new Notification(job.state === "completed" ? `${job.name ?? "Asset"} is ready` : `${job.name ?? "A job"} failed`, {
          body: job.state === "completed" ? "Open Asset Studio to review it." : (job.error ?? "Open Asset Studio for details.").slice(0, 180),
          ...(job.id ? { tag: job.id } : {}),
        });
      }
    previousJobStates.current = new Map((jobs as StudioJob[]).map((job) => [job.id ?? "", job.state]));
    if (!finished?.assetId) return;
    const filename = assets.find((asset) => asset.id === finished.assetId)?.filename;
    if (tab !== "jobs") {
      setNotice(`${filename ?? finished.name ?? "Animation"} is ready — open it from its job card.`);
      return;
    }
    setTab("animation");
    setNotice(`${filename ?? finished.name ?? "Animation"} is ready in the Animation Lab.`);
    void openSpriteMap(finished.assetId, filename);
  }, [jobs]);
  const alignSpriteFrames = async (assetId: string, grid: SpriteMapGrid) => {
    setIsAligningFrames(true);
    const result = await api.frameAnchors(assetId, gameId, gridRects(grid), anchorMode);
    setIsAligningFrames(false);
    if (result.error || !result.offsets || !result.scales || !result.box) {
      setNotice(result.error ?? "Could not align sprite frames.");
      return;
    }
    setFrameAnchors({ offsets: result.offsets, scales: result.scales, box: result.box });
  };
  // Stale anchors belong to the previous grid, so a guide edit must never reuse them.
  const anchors = frameAnchors?.offsets.length === spriteRects.length ? frameAnchors : null;
  // Realign after every grid change, so an edited or evenly spaced grid never falls back
  // to raw source placement. Skipped mid-drag: the guide is still moving.
  useEffect(() => {
    if (!selectedSpriteMapId || !spriteGrid || gridDrag || frameAnchors) return;
    void alignSpriteFrames(selectedSpriteMapId, spriteGrid);
  }, [selectedSpriteMapId, spriteGrid, gridDrag, frameAnchors, anchorMode]);
  const grouped = useMemo(
    () => ({
      candidates: visibleAssets.filter((asset) => asset.state === "candidates"),
      approved: visibleAssets.filter((asset) => asset.state === "approved"),
      source: visibleAssets.filter((asset) => asset.state === "source"),
    }),
    [visibleAssets],
  );
  const activeJobCount = (jobs as StudioJob[]).filter((job) => job.state === "queued" || job.state === "running").length;
  const activeJobSummary = useMemo(() => {
    const active = (jobs as Array<{ gameId?: string; state?: string }>).filter(
      (job) => job.state === "queued" || job.state === "running",
    );
    if (!active.length) return "No image jobs running";
    const counts = new Map<string, number>();
    for (const job of active)
      counts.set(
        job.gameId ?? "unknown",
        (counts.get(job.gameId ?? "unknown") ?? 0) + 1,
      );
    const breakdown = [...counts.entries()]
      .map(
        ([id, count]) =>
          `${count} in ${games.find((game) => game.id === id)?.label ?? id}`,
      )
      .join(", ");
    return `${active.length} image job${active.length === 1 ? "" : "s"} running (${breakdown})`;
  }, [games, jobs]);
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    // Ask once, at the moment it's clearly useful: the user is about to wait for a job.
    if (typeof Notification !== "undefined" && Notification.permission === "default") void Notification.requestPermission();
    if (selectedGeneratorBlocked)
      return setNotice("The selected image generator is out of quota. Pick an available one before queuing.");
    const generationPrompt = composeGenerationBrief(
      protectedBrief?.text ?? "",
      prompt,
    );
    if (generationPrompt.length < 3) {
      setNotice("Add a production brief before queueing this asset.");
      return;
    }
    await confirmPaid(provider, `Generating ${name || "this asset"}`, async () => {
    setNotice("Queueing generation job…");
    try {
      const created = await api.submit([
        {
          gameId,
          family,
          name,
          prompt: generationPrompt,
          // The card shows what was typed; a locked Animate/Remix template is summarised instead.
          brief: prompt.trim() || (protectedBrief && !protectedBrief.locked
            ? protectedBrief.text
            : `${protectedBrief?.kind === "animation" ? "Animate" : "Remix"} ${references[0]?.split("/").pop() ?? name}`),
          transparent: true,
          width,
          height,
          tags: generationTags,
          references,
          operation: generationOperation,
          provider,
        },
      ]);
      if (!Array.isArray(created)) {
        setNotice(
          `Job rejected: ${typeof created === "object" && created && "error" in created ? String(created.error) : "unknown server response"}`,
        );
        setTab("jobs");
        return;
      }
      setPrompt("");
      setName("");
      setGenerationTags([]);
      setProtectedBrief(null);
      setGenerationOperation("generate");
      await load();
      setTab("jobs");
      setNotice(
        `${created.length} job queued. It will become completed or failed here.`,
      );
    } catch (error) {
      setTab("jobs");
      setNotice(
        `Job request could not reach the local server: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    });
  };
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="sidebar-brand">
          <strong className="wordmark">
            Diorama<span aria-hidden="true">.</span>
          </strong>
          <small>Asset Studio</small>
        </div>
        <p className="sidebar-label">Mode</p>
        <nav className="sidebar-nav" aria-label="Mode">
          {NAV_ITEMS.map((item) => (
            <button
              key={item.id}
              className={tab === item.id ? "active" : ""}
              aria-current={tab === item.id ? "page" : undefined}
              onClick={() => setTab(item.id)}
            >
              <Icon name={item.id} />
              <span>{item.label}</span>
              {item.id === "jobs" && activeJobCount > 0 && <span className="badge">{activeJobCount}</span>}
            </button>
          ))}
        </nav>
        <p className="sidebar-label">Project</p>
        <nav className="sidebar-nav" aria-label="Project">
          {games.map((game) => (
            <div key={game.id} className="sidebar-item">
              <button
                className={gameId === game.id ? "active" : ""}
                aria-current={gameId === game.id ? "true" : undefined}
                onClick={() => setGameId(game.id)}
              >
                <Icon name="game" />
                <span>{game.label}</span>
              </button>
              {games.length > 1 && (
                <button className="sidebar-item-action" aria-label={`Delete ${game.label}`} title={`Delete ${game.label}`} onClick={() => deleteProject(game.id)}>
                  <Icon name="trash" />
                </button>
              )}
            </div>
          ))}
          <button className="sidebar-add" onClick={createProject}>
            <Icon name="add" />
            <span>New project</span>
          </button>
        </nav>
        <p className="sidebar-status job-indicator">
          <span className={activeJobCount ? "status-dot live" : "status-dot"} aria-hidden="true" />
          {activeJobSummary}
        </p>
      </aside>
      <main className="studio-shell">
        <header className="topbar">
          <h1>{NAV_ITEMS.find((item) => item.id === tab)?.label}</h1>
          <ProjectSwitcher games={games} value={gameId} onChange={setGameId} />
        </header>
        {notice && (
          <div role="status" className="notice">
            <p>{notice}</p>
            <button type="button" className="notice-close" aria-label="Dismiss notification" title="Dismiss" onClick={() => setNotice("")}>
              ×
            </button>
          </div>
        )}
      {tab === "library" && (
        <section>
          <p className="quiet">
            Generated art stays in candidates until you approve it. Metadata
            warns about transparency and crop issues; it never auto-promotes.
          </p>
          <div className="asset-controls">
            <label className="asset-search">
              Search
              <input type="search" value={search} placeholder="Name or tag…" onChange={(event) => setSearch(event.target.value)} />
            </label>
            <label>
              Tag
              <select
                value={tagFilter}
                onChange={(event) => setTagFilter(event.target.value)}
              >
                <option value="">All tags</option>
                {tags.map((tag) => (
                  <option key={tag}>{tag}</option>
                ))}
              </select>
            </label>
            <label>
              <span>Sort</span>
              <select
                value={sortBy}
                onChange={(event) =>
                  setSortBy(event.target.value as "newest" | "name")
                }
              >
                <option value="newest">Newest</option>
                <option value="name">Name</option>
              </select>
            </label>
          </div>
          {selectedAssets.length > 0 && (
            <div className="bulk-bar" role="toolbar" aria-label="Selected assets">
              <strong>{selectedAssets.length} selected</strong>
              <button disabled={bulkBusy || selectedAssets.every((asset) => asset.state === "approved")} onClick={() => void runBulk("Approve", (asset) => (asset.state === "approved" ? Promise.resolve(undefined) : api.move(asset.id, gameId, "approved")))}>
                Approve
              </button>
              <ProjectMenu
                games={games.filter((game) => game.id !== gameId)}
                disabled={bulkBusy}
                onPick={(target) => void runBulk(`Move to ${target.label}`, (asset) => api.transfer(asset.id, gameId, target.id))}
              />
              <button
                className="danger"
                disabled={bulkBusy}
                onClick={() => {
                  const dependent = savedAnimations.filter((animation) => animation.frames.some((frame) => selectedIds.includes(frame.assetId ?? ""))).map((animation) => animation.name);
                  openDialog({
                    title: `Remove ${selectedAssets.length} assets?`,
                    message: `They move to this project's trash, where you can restore them.${dependent.length ? ` These animations use them and will stop working: ${[...new Set(dependent)].join(", ")}.` : ""}`,
                    confirmLabel: "Remove assets",
                    danger: true,
                    onConfirm: () => runBulk("Remove", (asset) => api.remove(asset.id, gameId)),
                  });
                }}
              >
                Remove
              </button>
              <button className="link-button" disabled={bulkBusy} onClick={() => setSelectedIds(visibleAssets.map((asset) => asset.id))}>
                Select all {visibleAssets.length}
              </button>
              <button className="link-button" disabled={bulkBusy} onClick={() => setSelectedIds([])}>
                Clear
              </button>
              {bulkBusy && <small>Working…</small>}
            </div>
          )}
          {!visibleAssets.length && <p className="empty-state">No assets match this filter yet.</p>}
          {(["source", "candidates", "approved"] as const).filter((state) => grouped[state].length).map((state) => (
            <div key={state}>
              <h2 className="section-label">{state}</h2>
              <div className="asset-grid">
                {grouped[state].map((asset) => {
                  const relatedJob = (jobs as StudioJob[]).find(
                    (job) =>
                      job.references?.includes(asset.relativePath) &&
                      (job.state === "queued" || job.state === "running"),
                  );
                  const relatedJobLabel = relatedJob
                    ? activeJobLabel(relatedJob)
                    : null;
                  const hasIssues = Boolean(asset.inspection?.warnings.length);
                  const isSpriteMap = (asset.tags ?? []).includes(
                    "animation-spritemap",
                  );
                  return (
                    <article key={asset.id} id={`asset-${asset.id}`} className={[asset.id === focusedAssetId ? "is-focused" : "", selectedIds.includes(asset.id) ? "is-selected" : ""].join(" ").trim() || undefined}>
                      <label className="card-select" title="Select for bulk actions">
                        <input
                          type="checkbox"
                          aria-label={`Select ${asset.filename}`}
                          checked={selectedIds.includes(asset.id)}
                          onChange={(event) => setSelectedIds((current) => (event.target.checked ? [...current, asset.id] : current.filter((id) => id !== asset.id)))}
                        />
                      </label>
                      <button
                        className="asset-preview"
                        onClick={() => setLightboxAsset(asset)}
                        aria-label={`Open ${asset.filename} in full view`}
                      >
                        <img
                          className={asset.pixel ? "is-pixel" : undefined}
                          src={`/api/assets/${asset.id}/file?gameId=${gameId}`}
                          alt={asset.filename}
                        />
                      </button>
                      <strong className="card-title" title={asset.filename}>{asset.filename}</strong>
                      {(versionGroups.get(versionGroupKey(asset))?.length ?? 0) > 1 && (
                        <button type="button" className="link-button version-link" onClick={() => setCompareKey(versionGroupKey(asset))}>
                          Compare {versionGroups.get(versionGroupKey(asset))!.length} versions
                        </button>
                      )}
                      <small className="card-meta">
                        {asset.family} · {asset.inspection?.width}×{asset.inspection?.height} ·{" "}
                        {asset.inspection?.hasAlpha
                          ? `alpha ${(asset.inspection.alphaCoverage * 100).toFixed(0)}%`
                          : "no alpha"}
                      </small>
                      {(asset.tags ?? []).length > 0 && (
                        <ul className="tag-chips" aria-label="Tags" title={(asset.tags ?? []).join(", ")}>
                          {(asset.tags ?? []).map((tag) => <li key={tag}>{tag}</li>)}
                        </ul>
                      )}
                      {asset.inspection?.warnings.map((warning) => (
                        <small className="warning" key={warning}>
                          {warning}
                        </small>
                      ))}
                      {relatedJobLabel && (
                        <small className="repair-status">{relatedJobLabel}</small>
                      )}
                      <div className="card-actions">
                      <button
                        disabled={hasIssues || Boolean(relatedJob)}
                        title={
                          hasIssues
                            ? "Fix inspection issues before remixing this asset."
                            : undefined
                        }
                        onClick={() => {
                          const draft = variationDraft(asset, savedBriefs);
                          setName(draft.name);
                          setFamily(draft.family);
                          setReferences(draft.references);
                          setWidth(draft.width);
                          setHeight(draft.height);
                          setGenerationTags(draft.tags);
                          setGenerationOperation("remix");
                          setProtectedBrief({
                            kind: "variation",
                            locked: true,
                            text: draft.brief,
                          });
                          setPrompt("");
                          setTab("generate");
                          setNotice(
                            `${asset.filename} is attached as the variation reference.`,
                          );
                        }}
                      >
                        Remix
                      </button>
                      <button
                        disabled={
                          hasIssues || Boolean(relatedJob) || isSpriteMap
                        }
                        title={
                          hasIssues
                            ? "Fix inspection issues before animating this asset."
                            : isSpriteMap
                              ? "This asset is already an animation sprite map."
                              : undefined
                        }
                        onClick={() => {
                          const motion = motionForAsset(asset.filename, asset.family, motions);
                          const draft = animationDraft(asset, savedBriefs, motion, motions);
                          setName(draft.name);
                          setFamily(draft.family);
                          setWidth(draft.width);
                          setHeight(draft.height);
                          setGenerationTags(draft.tags);
                          setGenerationOperation("animate");
                          setReferences(draft.references);
                          setProtectedBrief({
                            kind: "animation",
                            locked: true,
                            text: draft.prompt,
                            motion,
                            source: { filename: asset.filename, family: asset.family, relativePath: asset.relativePath },
                          });
                          setPrompt("");
                          setTab("generate");
                          setNotice(
                            `${asset.filename} is attached for an animation sprite map.`,
                          );
                        }}
                      >
                        Animate
                      </button>
                      {isSpriteMap && (
                        <button
                          disabled={Boolean(relatedJob)}
                          title="Redraw every frame through the local ComfyUI sd15-openpose-game-asset workflow"
                          onClick={async () => {
                            if (providers && isGeneratorBlocked(providers, "comfyui"))
                              return setNotice("ComfyUI isn't ready. Open Settings → Image providers for what's missing.");
                            const stem = asset.filename.replace(/\.[^.]+$/, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
                            const created = await api.submit([{
                              gameId,
                              family: asset.family,
                              name: `${stem}-comfy`,
                              // The sheet's own generation prompt still carries its "C columns × R rows" layout.
                              prompt: `Redraw every frame of ${asset.filename} as clean pixel art. ${asset.provenance?.prompt ?? ""}`.trim(),
                              brief: `Restyle ${asset.filename} with ComfyUI`,
                              transparent: true,
                              width: Math.min(2048, Math.max(256, asset.inspection?.width ?? 1024)),
                              height: Math.min(2048, Math.max(256, asset.inspection?.height ?? 1024)),
                              tags: ["animation-spritemap"],
                              references: [asset.relativePath],
                              operation: "animate",
                              provider: "comfyui",
                            }]);
                            setNotice(Array.isArray(created) ? `ComfyUI is redrawing ${asset.filename}.` : `Job rejected: ${String(created?.error ?? "unknown server response")}`);
                            await load();
                            setTab("jobs");
                          }}
                        >
                          Restyle in ComfyUI
                        </button>
                      )}
                      <button
                        disabled={Boolean(relatedJob)}
                        title="Convert this asset to native pixel art with the project palette"
                        onClick={async () => {
                          const created = await api.pixelize(asset.id, gameId);
                          setNotice(created?.error ? `Pixelize failed: ${created.error}` : `${asset.filename} pixelized.`);
                          await load();
                        }}
                      >
                        Pixelize
                      </button>
                      {asset.inspection?.warnings.length ? (
                        <button
                          disabled={Boolean(relatedJob)}
                          onClick={async () => {
                            if (selectedGeneratorBlocked)
                              return setNotice("The selected image generator is out of quota. Pick an available one on Generate first.");
                            await confirmPaid(provider, `Repairing ${asset.filename}`, async () => {
                              const created = await api.fix(asset.id, gameId, provider);
                              setNotice(created?.error ? `Fix job rejected: ${created.error}` : `Fix job queued for ${asset.filename}.`);
                              await load();
                            });
                          }}
                        >
                          Fix issues
                        </button>
                      ) : null}
                      <button disabled={Boolean(relatedJob)} onClick={() => regenerate(asset)} title="Open Generate with the brief this asset was made from">
                        Regenerate
                      </button>
                      {state !== "approved" && (
                        <button
                          disabled={Boolean(relatedJob)}
                          onClick={async () => {
                            await api.move(asset.id, gameId, "approved");
                            await load();
                          }}
                        >
                          Approve
                        </button>
                      )}
                      </div>
                      <div className="card-toolbar">
                        <ProjectMenu
                          games={games.filter((game) => game.id !== gameId)}
                          disabled={Boolean(relatedJob)}
                          onPick={async (target) => {
                            const result = await api.transfer(asset.id, gameId, target.id);
                            if (result?.error) return setNotice(`Could not move asset: ${result.error}`);
                            const carried = result.movedAnimations?.length ? ` Its animations moved too: ${result.movedAnimations.join(", ")}.` : "";
                            const broken = result.brokenAnimations?.length ? ` These animations also use other assets and stayed behind without it: ${result.brokenAnimations.join(", ")}.` : "";
                            setNotice(`${asset.filename} moved to ${target.label}.${carried}${broken}`);
                            await load();
                            setSavedAnimations(await api.animations(gameId));
                          }}
                        />
                        <a className="button icon-button" href={`/api/assets/${asset.id}/file?gameId=${gameId}`} download={asset.filename} aria-label={`Download ${asset.filename}`} title="Download">
                          <Icon name="download" />
                        </a>
                      <button
                        className="danger icon-button"
                        aria-label={`Remove ${asset.filename}`}
                        title="Remove (moves to .trash)"
                        disabled={Boolean(relatedJob)}
                        onClick={() => openDialog({
                          title: `Remove ${asset.filename}?`,
                          message: `It moves to this project's .trash folder, so you can restore it by hand.${(() => {
                            const dependent = savedAnimations.filter((animation) => animation.frames.some((frame) => frame.assetId === asset.id)).map((animation) => animation.name);
                            return dependent.length ? ` These animations use it and will stop working until it's restored: ${[...new Set(dependent)].join(", ")}.` : "";
                          })()}`,
                          confirmLabel: "Remove asset",
                          danger: true,
                          onConfirm: async () => {
                            const result = await api.remove(asset.id, gameId);
                            if (result?.error) return `Could not remove asset: ${result.error}`;
                            setNotice(`${asset.filename} moved to .trash.`);
                            await load();
                          },
                        })}
                      >
                        <Icon name="trash" />
                      </button>
                      </div>
                    </article>
                  );
                })}
              </div>
            </div>
          ))}
          <div>
            <h2 className="section-label">animations</h2>
            {!savedAnimations.length && <p className="empty-state">No saved animations yet. Build one in the Animation Lab and save its manifest.</p>}
            <div className="asset-grid">
              {savedAnimations.map((animation) => {
                const source = assets.find((asset) => asset.id === animation.frames[0]?.assetId);
                return (
                  <article key={animation.id}>
                    <AnimationThumbnail animation={animation} gameId={gameId} />
                    <strong className="card-title" title={animation.name}>{animation.name}</strong>
                    <small className="card-meta">{animation.frames.length} frames · {animation.fps} FPS · {animation.loop}</small>
                    <small>{source ? source.filename : "Source sprite map was removed."}</small>
                    {source && (
                      <button onClick={() => { setTab("animation"); void openSpriteMap(source.id, source.filename); }}>
                        Open in Animation Lab
                      </button>
                    )}
                    <button
                      disabled={animationExports[animation.id] === "busy"}
                      onClick={async () => {
                        setAnimationExports((current) => ({ ...current, [animation.id]: "busy" }));
                        const result = await api.exportAnimation(animation.id, gameId).catch((error: unknown) => ({ error: String(error) }));
                        setAnimationExports((current) => {
                          const next = { ...current };
                          if ("files" in result && result.files && result.directory) next[animation.id] = { directory: result.directory, files: result.files };
                          else delete next[animation.id];
                          return next;
                        });
                        setNotice(result.error ? `Export failed: ${result.error}` : `Exported ${animation.name} to the game's assets/${"directory" in result ? result.directory : ""}.`);
                      }}
                    >
                      {animationExports[animation.id] === "busy" ? "Exporting…" : "Export sprite sheet"}
                    </button>
                    {(() => {
                      const exported = animationExports[animation.id];
                      if (!exported || exported === "busy") return null;
                      const labels: Record<string, string> = { sheet: "Sheet PNG", atlas: "Atlas JSON", preview: "Animated WebP" };
                      return (
                        <div className="export-links">
                          {exported.files.map((file) => (
                            <a key={file.filename} className="button" href={api.exportUrl(animation.id, gameId, file.filename)} download={file.filename}>
                              <Icon name="download" />
                              {labels[file.kind] ?? file.filename}
                            </a>
                          ))}
                        </div>
                      );
                    })()}
                    <button className="danger" onClick={() => removeAnimation(animation)}>Delete manifest</button>
                  </article>
                );
              })}
            </div>
          </div>
        </section>
      )}
      {tab === "trash" && (
        <TrashView
          gameId={gameId}
          projectLabel={games.find((game) => game.id === gameId)?.label ?? "this project"}
          onNotice={setNotice}
          onAssetRestored={load}
          onProjectRestored={() => reloadGames(gameId)}
          openDialog={openDialog}
        />
      )}
      {tab === "settings" && (
        <SettingsView
          theme={theme}
          onThemeChange={setTheme}
          style={style}
          onStyleChange={setStyle}
          spend={spend}
          onSpendChange={setSpend}
          providers={providers}
          onProvidersChange={setProviders}
          providerBusy={providerBusy}
          onProviderBusyChange={setProviderBusy}
          onCheckProviders={checkProviders}
          onNotice={setNotice}
        />
      )}
      {tab === "direction" && (
        <ArtDirectionView
          gameId={gameId}
          projectLabel={games.find((game) => game.id === gameId)?.label ?? "this project"}
          globalPrompt={globalPrompt}
          setGlobalPrompt={setGlobalPrompt}
          savedGlobalPrompt={savedGlobalPrompt}
          setSavedGlobalPrompt={setSavedGlobalPrompt}
          briefs={briefs}
          setBriefs={setBriefs}
          savedBriefs={savedBriefs}
          setSavedBriefs={setSavedBriefs}
          onNotice={setNotice}
          motions={motions}
          onMotionsChange={setMotions}
        />
      )}
      {tab === "generate" && (
        <section className="panel generate">
          <h2 className="visually-hidden">Generate asset</h2>
          <form onSubmit={submit} className="generate-form">
            <div className="generate-setup">
              <div className="generator-field">
                <div className="generator-field-heading">
                  <span>Image generator</span>
                  <button type="button" className="link-button" disabled={providerBusy === "all"} onClick={() => void checkProviders()}>
                    {providerBusy === "all" ? "Checking…" : "Refresh availability"}
                  </button>
                </div>
                <GeneratorSelect value={provider} providers={providers} checking={providerBusy === "all"} onChange={setProvider} />
                {selectedGeneratorBlocked ? (
                  <p className="modal-error" role="alert">
                    Out of quota. Pick an available generator (paid ones spend credit) or wait for its reset.
                  </p>
                ) : (
                  <small className="field-hint">
                    {provider === "grok"
                      ? "Grok subscription. Output is matte-extracted and inspected here."
                      : provider === "cloudflare"
                        ? "Free daily allowance, then paid. Text-to-image only: references are ignored and long briefs are cut to 2,048 characters."
                        : isPaidGenerator(provider)
                        ? `Paid per image${provider === "gemini" ? ", billed to your Google Cloud project" : ""}. References are sent inline with the prompt.`
                        : provider === "codex"
                          ? "Codex imagegen on your ChatGPT plan."
                          : "delegate.sh image, falling back to Codex imagegen."}
                  </small>
                )}
              </div>
              <div className="field-pair">
                <label>
                  Name
                  <input
                    required
                    pattern="[a-z0-9\-]+"
                    value={name}
                    title="Lowercase letters, digits and hyphens, e.g. reed-sway."
                    onChange={(event) =>
                      setName(event.target.value.toLowerCase().replace(/[\s_]+/g, "-"))
                    }
                    placeholder="reed-sway"
                  />
                </label>
                <label>
                  Family
                  <input
                    required
                    pattern="[a-z0-9\-]+"
                    title="Lowercase letters, digits and hyphens, e.g. plants or water-effects."
                    value={family}
                    onChange={(event) =>
                      setFamily(event.target.value.trim().toLowerCase().replace(/\s+/g, "-"))
                    }
                    placeholder="plants"
                  />
                </label>
              </div>
              <div className="field-pair">
                <label title="256–2048 px per side; 1024×1024 suits atomic isometric assets.">
                  Width
                  <input type="number" min={256} max={2048} step={64} value={width} onChange={(event) => setWidth(Number(event.target.value))} />
                </label>
                <label title="256–2048 px per side; 1024×1024 suits atomic isometric assets.">
                  Height
                  <input type="number" min={256} max={2048} step={64} value={height} onChange={(event) => setHeight(Number(event.target.value))} />
                </label>
              </div>
              <label>
                Reference images
                <input
                  type="file"
                  accept="image/png,image/webp,image/jpeg"
                  multiple
                  disabled={Boolean(protectedBrief)}
                  onChange={async (event) => {
                  for (const file of Array.from(event.target.files ?? [])) {
                    const asset = await api.upload(gameId, file);
                    if (asset.id)
                      setReferences((current) => [
                        ...current,
                        asset.relativePath,
                      ]);
                  }
                  await load();
                }}
                />
                <small className="field-hint">
                  {protectedBrief
                    ? "Locked to the selected source image."
                    : references.length
                      ? `${references.length} attached.`
                      : "Optional. Uploads are kept with this project."}
                </small>
              </label>
              {references.length > 0 && (
                <div
                  className="reference-previews"
                  aria-label="Attached references"
                >
                  {references.map((reference) => {
                    const referenceAsset = assets.find(
                      (asset) => asset.relativePath === reference,
                    );
                    const label = referenceAsset?.filename ?? reference.split("/").pop() ?? reference;
                    return (
                      <figure key={reference}>
                        {referenceAsset ? (
                          <img
                            src={`/api/assets/${referenceAsset.id}/file?gameId=${gameId}`}
                            alt={`Attached reference: ${referenceAsset.filename}`}
                          />
                        ) : (
                          <small>{reference}</small>
                        )}
                        <figcaption>{label}</figcaption>
                        {/* A remix or animation is built on its source, so that one stays attached. */}
                        {!protectedBrief && (
                          <button
                            type="button"
                            className="icon-button reference-remove"
                            aria-label={`Remove reference ${label}`}
                            title="Remove this reference (the uploaded image stays in the library)"
                            onClick={() => setReferences((current) => current.filter((item) => item !== reference))}
                          >
                            <Icon name="close" />
                          </button>
                        )}
                      </figure>
                    );
                  })}
                </div>
              )}
              {generationTags.length > 0 && <small className="field-hint">Output tags: {generationTags.join(" · ")}</small>}
            </div>
            <div className="generate-brief">
              {protectedBrief?.kind === "animation" && protectedBrief.locked && protectedBrief.source && (
                <label className="motion-field">
                  Motion
                  <select
                    value={protectedBrief.motion}
                    onChange={(event) => {
                      const motion = event.target.value as Motion;
                      const draft = animationDraft(protectedBrief.source!, savedBriefs, motion, motions);
                      setName(draft.name);
                      setProtectedBrief({ ...protectedBrief, motion, text: draft.prompt });
                    }}
                  >
                    {Object.keys(motions).map((motion) => (
                      <option key={motion} value={motion}>
                        {motion[0]!.toUpperCase() + motion.slice(1).replace(/-/g, " ")}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              {protectedBrief && (
                <label className="protected-brief">
                  {protectedBrief.kind === "variation"
                    ? "Variation"
                    : "Animation"}{" "}
                  brief
                  {protectedBrief.locked ? " (locked)" : ""}
                  <textarea
                    readOnly={protectedBrief.locked}
                    disabled={protectedBrief.locked}
                    maxLength={2400}
                    value={protectedBrief.text}
                    onChange={(event) =>
                      setProtectedBrief((current) =>
                        current
                          ? { ...current, text: event.target.value }
                          : current,
                      )
                    }
                  />
                  {protectedBrief.locked && (
                    <button
                      type="button"
                      onClick={() => openDialog({
                        title: `Unlock the ${protectedBrief.kind} brief?`,
                        message: `Unlocking lets you change the generated ${protectedBrief.kind} instructions.`,
                        confirmLabel: "Unlock brief",
                        onConfirm: () => setProtectedBrief((current) => current ? { ...current, locked: false } : current),
                      })}
                    >
                      Unlock {protectedBrief.kind} brief
                    </button>
                  )}
                </label>
              )}
              <label className="brief-field">
                Production brief{protectedBrief ? " (optional notes)" : ""}
                <textarea
                  required={!protectedBrief}
                  maxLength={2400}
                  value={prompt}
                  onChange={(event) => setPrompt(event.target.value)}
                  placeholder="Atomic painterly reed cutout, fixed isometric camera..."
                />
              </label>
              <div className="brief-health">
                <meter min={0} max={2400} low={1200} high={2000} optimum={600} value={prompt.length}>
                  {prompt.length}
                </meter>
                <small role="status">
                  {isEnhancing
                    ? "AI is improving the brief…"
                    : `${prompt.length.toLocaleString()} / 2,400 · ${prompt.length > 1200 ? "AI optimization suggested" : "concise"} · project art direction is added automatically`}
                </small>
              </div>
              <div className="generate-actions">
                <button
                  type="button"
                  disabled={isEnhancing || prompt.length < 3}
                  title="Keeps your subject and makes the brief more specific (targets 700–900 characters)."
                  onClick={async () => {
                setIsEnhancing(true);
                try {
                  const result = await api.enhancePrompt(
                    gameId,
                    family,
                    prompt,
                  );
                  if (result.prompt) {
                    setPrompt(result.prompt);
                    setNotice(
                      `Production brief enhanced to ${result.prompt.length.toLocaleString()} characters.`,
                    );
                  } else
                    setNotice(
                      `Prompt enhancement failed: ${result.error ?? "unknown error"}`,
                    );
                } finally {
                  setIsEnhancing(false);
                }
              }}
                >
                  {isEnhancing ? (
                    <>
                      <span className="spinner" aria-hidden="true" /> Enhancing…
                    </>
                  ) : (
                    "Enhance with AI"
                  )}
                </button>
                <button type="submit" disabled={isEnhancing || selectedGeneratorBlocked}>
                  Queue candidate
                </button>
              </div>
            </div>
          </form>
        </section>
      )}
      {tab === "jobs" && (
        <JobsView
          gameId={gameId}
          projectLabel={games.find((game) => game.id === gameId)?.label ?? ""}
          jobs={jobs as StudioJob[]}
          assets={assets}
          now={now}
          jobStateFilter={jobStateFilter}
          setJobStateFilter={setJobStateFilter}
          jobSort={jobSort}
          setJobSort={setJobSort}
          onRefresh={load}
          onNotice={setNotice}
          openDialog={openDialog}
          confirmPaid={confirmPaid}
          onOpenAsset={setLightboxAsset}
          onShowInLibrary={(assetId) => { setTagFilter(""); setFocusedAssetId(assetId); setTab("library"); }}
          onOpenInAnimationLab={(asset) => { setTab("animation"); void openSpriteMap(asset.id, asset.filename); }}
        />
      )}
      {tab === "animation" && (
        <section className="panel animation-lab">
          <div className="animation-lab-header">
            <div>
              <h2 className="visually-hidden">Animation Lab</h2>
              <p className="quiet">
                Build a non-destructive animation from one imported sprite map.
                Grid detection analyses transparent gutters locally—no LLM is used.
              </p>
            </div>
            <label>
              Sprite map
              <select
                value={selectedSpriteMapId}
                onChange={(event) => void openSpriteMap(event.target.value)}
              >
                <option value="">Select a sprite map…</option>
                {spriteMaps.map((asset) => <option key={asset.id} value={asset.id}>{asset.filename}</option>)}
              </select>
            </label>
          </div>
          {!spriteMaps.length && <p className="empty-state">No assets are tagged <code>animation-spritemap</code>. Create one with Animate, then return here.</p>}
          {selectedSpriteMap && spriteGrid && (
            <div className="animation-workspace">
              <div className="sprite-editor">
                {isCleaning ? (
                  <>
                    <div className="section-heading"><div><h3>Clean up sprite map</h3><p className="quiet">Remove frame borders, grid lines and stray marks before slicing frames.</p></div></div>
                    <SpriteCleanupEditor
                      asset={selectedSpriteMap}
                      gameId={gameId}
                      onNotice={setNotice}
                      onCancel={() => setIsCleaning(false)}
                      onSaved={async (created) => {
                        setAssets(await api.assets(gameId));
                        setNotice(`${created.filename} saved; the original is still in the Library.`);
                        await openSpriteMap(created.id, created.filename);
                      }}
                    />
                  </>
                ) : (<>
                <div className="section-heading">
                  <div><h3>Detected frame grid</h3><p className="quiet">{spriteGrid.confidence} confidence{spriteGrid.reason ? ` · ${spriteGrid.reason}` : ""} · drag a guide or refine rows and columns below.</p></div>
                  <div className="inline-actions">
                    <button onClick={() => { setPlaying(false); setIsCleaning(true); }}>Clean up</button>
                    <button disabled={isDetectingGrid} onClick={() => void detectGrid(selectedSpriteMap.id)}>{isDetectingGrid && <span className="spinner" />}Auto-detect</button>
                    <button onClick={() => { setSpriteGrid((current) => current ? { ...current, yCuts: makeEvenCuts(current.height, current.yCuts.length - 1), xCuts: current.xCuts.map((cuts) => makeEvenCuts(current.width, cuts.length - 1)), confidence: "low", reason: undefined } : current); setFrameAnchors(null); setFrame(0); }}>Evenly space</button>
                    <button disabled={isAligningFrames} onClick={() => void alignSpriteFrames(selectedSpriteMap.id, spriteGrid)}>{isAligningFrames && <span className="spinner" />}Align sprites</button>
                  </div>
                </div>
                <div className="sprite-map-stage checker" ref={spriteMapRef}>
                  <img src={`/api/assets/${selectedSpriteMap.id}/file?gameId=${gameId}`} alt={`${selectedSpriteMap.filename} with editable frame guides`} />
                  {spriteGrid.xCuts.flatMap((cuts, row) => cuts.slice(1, -1).map((cut, index) => (
                    <button
                      key={`x-${row}-${index}`}
                      className="grid-guide vertical"
                      style={{ left: `${(cut / spriteGrid.width) * 100}%`, top: `${(spriteGrid.yCuts[row]! / spriteGrid.height) * 100}%`, height: `${((spriteGrid.yCuts[row + 1]! - spriteGrid.yCuts[row]!) / spriteGrid.height) * 100}%` }}
                      aria-label={`Adjust vertical guide ${index + 1} in row ${row + 1}`}
                      onPointerDown={(event) => { event.preventDefault(); setFrameAnchors(null); setGridDrag({ axis: "x", index: index + 1, row }); }}
                    />
                  )))}
                  {spriteGrid.yCuts.slice(1, -1).map((cut, index) => <button key={`y-${index}`} className="grid-guide horizontal" style={{ top: `${(cut / spriteGrid.height) * 100}%` }} aria-label={`Adjust horizontal guide ${index + 1}`} onPointerDown={(event) => { event.preventDefault(); setFrameAnchors(null); setGridDrag({ axis: "y", index: index + 1, row: 0 }); }} />)}
                </div>
                <div className="grid-controls">
                  {/* Changing a count re-runs detection with it, so cuts land in the gaps between sprites rather than at even positions. */}
                  <label>Columns<input type="number" min="1" max="16" value={spriteGrid.xCuts[0]!.length - 1} onChange={(event) => void detectGrid(selectedSpriteMap.id, { columns: Math.max(1, Math.min(16, Number(event.target.value) || 1)), rows: spriteGrid.yCuts.length - 1 })} /></label>
                  <label>Rows<input type="number" min="1" max="16" value={spriteGrid.yCuts.length - 1} onChange={(event) => void detectGrid(selectedSpriteMap.id, { columns: spriteGrid.xCuts[0]!.length - 1, rows: Math.max(1, Math.min(16, Number(event.target.value) || 1)) })} /></label>
                  <p>{spriteRects.length} frames · {spriteGrid.width}×{spriteGrid.height}px source · Guides save as exact source coordinates.</p>
                </div>
                </>)}
              </div>
              <aside className="animation-preview" aria-live="polite">
                <div className="section-heading"><div><h3>Live preview</h3><p className="quiet">Runs beside the source sheet.</p></div><span className="preview-state">{playing ? "Playing" : "Paused"}</span></div>
                <div className="checker frame-crop">
                  {currentSpriteRect && <img src={api.spriteFrameUrl(selectedSpriteMap.id, gameId, currentSpriteRect, anchors?.offsets[frame], anchors?.scales[frame], anchors?.box)} alt={`Preview frame ${frame + 1}`} />}
                </div>
                <div className="preview-controls">
                  <button className="primary" disabled={!spriteRects.length} onClick={() => setPlaying((value) => !value)}>{playing ? "Pause" : "Run animation"}</button>
                  <label>Frame<input aria-label="Animation frame" type="range" min="0" max={Math.max(0, spriteRects.length - 1)} value={Math.min(frame, Math.max(0, spriteRects.length - 1))} onChange={(event) => { setPlaying(false); setFrame(Number(event.target.value)); }} /></label>
                  <label>FPS<input type="number" min="1" max="30" value={animationFps} onChange={(event) => setAnimationFps(Math.max(1, Math.min(30, Number(event.target.value) || 1)))} /></label>
                  <label>Alignment<select value={anchorMode} onChange={(event) => { setAnchorMode(event.target.value as "subject" | "base"); setFrameAnchors(null); }}><option value="subject">Lock subject</option><option value="base">Pin base</option></select></label>
                  <label>Playback<select value={animationLoop} onChange={(event) => setAnimationLoop(event.target.value as "loop" | "once" | "ping-pong")}><option value="loop">Loop</option><option value="once">Once</option><option value="ping-pong">Ping-pong</option></select></label>
                  <p>{spriteRects.length ? `${frame + 1}/${spriteRects.length}` : "0/0"} · {animationFps} FPS · {animationLoop}{anchors ? ` · ${anchorMode === "subject" ? "subject locked" : "base pinned"} on a ${anchors.box.width}×${anchors.box.height} frame box` : " · source placement"}</p>
                </div>
                <div className="save-animation">
                  <label>Manifest name<input value={animationName} onChange={(event) => setAnimationName(event.target.value)} pattern="[a-z0-9\-]+" /></label>
                  <button disabled={!spriteRects.length || !animationName} onClick={async () => {
                    await api.saveAnimation({ gameId, name: animationName, loop: animationLoop, fps: animationFps, source: "sheet", frames: spriteRects.map((rect, index) => ({ assetId: selectedSpriteMap.id, sourcePath: selectedSpriteMap.relativePath, durationMs: 0, rect, ...(anchors ? { anchorOffset: anchors.offsets[index], anchorScale: anchors.scales[index], box: anchors.box } : {}) })) });
                    setSavedAnimations(await api.animations(gameId));
                    setNotice(`${animationName} manifest saved with ${spriteRects.length} frames.`);
                  }}>Save sprite-map manifest</button>
                </div>
              </aside>
            </div>
          )}
          <details>
            <summary>
              Saved animation manifests ({savedAnimations.length})
            </summary>
            {savedAnimations.length ? (
              <ul className="manifest-list">
                {savedAnimations.map((animation) => (
                  <li key={animation.id}>
                    <span>
                      <strong>{animation.name}</strong>
                      <small>{animation.frames.length} frames · {animation.fps} FPS · {animation.loop}</small>
                    </span>
                    <button className="danger" onClick={() => removeAnimation(animation)}>Delete</button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="empty-state">No saved manifests yet.</p>
            )}
          </details>
        </section>
      )}
      {compareKey && versionGroups.get(compareKey) && (
        <div
          className="lightbox"
          role="dialog"
          aria-modal="true"
          aria-label="Compare versions"
          onMouseDown={(event) => {
            if (event.currentTarget === event.target) setCompareKey(null);
          }}
          onKeyDown={(event) => {
            if (event.key === "Escape") setCompareKey(null);
          }}
        >
          <div className="lightbox-content compare">
            <div className="compare-heading">
              <strong>{compareKey.split("/").slice(1).join("/")} · {versionGroups.get(compareKey)!.length} versions</strong>
              <button className="lightbox-close" onClick={() => setCompareKey(null)} autoFocus>
                Close
              </button>
            </div>
            <div className="compare-grid">
              {versionGroups.get(compareKey)!.map((version) => (
                <figure key={version.id}>
                  <img src={`/api/assets/${version.id}/file?gameId=${gameId}`} alt={version.filename} />
                  <figcaption>
                    <strong>{version.filename}</strong>
                    <small>{version.state} · {version.inspection?.width}×{version.inspection?.height}{version.createdAt ? ` · ${new Date(version.createdAt).toLocaleDateString()}` : ""}</small>
                    {version.inspection?.warnings.length ? <small className="warning">{version.inspection.warnings.length} inspection warning(s)</small> : null}
                    {version.state !== "approved" && (
                      <button
                        onClick={async () => {
                          const result = await api.move(version.id, gameId, "approved");
                          setNotice(result?.error ? `Could not approve: ${result.error}` : `${version.filename} approved.`);
                          await load();
                        }}
                      >
                        Approve this version
                      </button>
                    )}
                  </figcaption>
                </figure>
              ))}
            </div>
          </div>
        </div>
      )}
      {lightboxAsset && (
        <div
          className="lightbox"
          role="dialog"
          aria-modal="true"
          aria-label={`${lightboxAsset.filename} full view`}
          onMouseDown={(event) => {
            if (event.currentTarget === event.target) setLightboxAsset(null);
          }}
        >
          <div className="lightbox-content">
            <div className="lightbox-toolbar">
              {lightboxList.length > 1 && lightboxIndex >= 0 && (
                <>
                  <button onClick={() => stepLightbox(-1)} aria-label="Previous asset" title="Previous (←)">‹</button>
                  <small>{lightboxIndex + 1} / {lightboxList.length}</small>
                  <button onClick={() => stepLightbox(1)} aria-label="Next asset" title="Next (→)">›</button>
                </>
              )}
              <button
                className="lightbox-close"
                onClick={() => setLightboxAsset(null)}
                autoFocus
              >
                Close full view
              </button>
            </div>
            <img
              src={`/api/assets/${lightboxAsset.id}/file?gameId=${lightboxAsset.gameId}`}
              alt={lightboxAsset.filename}
            />
            <small>
              {lightboxAsset.filename} · {lightboxAsset.inspection?.width}×
              {lightboxAsset.inspection?.height} ·{" "}
              <a href={`/api/assets/${lightboxAsset.id}/file?gameId=${lightboxAsset.gameId}`} download={lightboxAsset.filename}>
                Download
              </a>
            </small>
          </div>
        </div>
      )}
      </main>
      {dialog && <Modal key={dialog.key} request={dialog} onClose={() => setDialog((current) => current?.key === dialog.key ? null : current)} />}
    </div>
  );
}
