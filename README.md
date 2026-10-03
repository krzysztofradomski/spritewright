# Diorama Asset Studio

Local art-production studio for the three game prototypes. It keeps generated images in each game's `assets/candidates/` folder until a human promotes them to `approved/`; companion JSON manifests retain prompts, provider, version, alpha inspection, and lineage.

## Run locally

```bash
pnpm install
pnpm dev
```

Open [http://127.0.0.1:5173](http://127.0.0.1:5173). The UI uses a local API on port 4174.

## Generation

Generation runs `delegate.sh image` locally, using the existing Delegate/Antigravity subscription. Run `delegate.sh providers --check` before the first production batch. Asset prompts should specify the game, asset family, fixed isometric camera, transparent background, and constraints. Every submitted item is a separate job; failures retain their log and can be retried.

The application never stores API keys and does not automate a ChatGPT web session. Images made through a Codex chat can be imported through the same candidate/manifests workflow.

## Animation Lab

Choose imported PNG/WebP assets in display order to preview an animation and save a non-destructive sequence manifest under `games/<game>/assets/animations/manifest.json`. Source images are not changed. Sprite grids use frame dimensions, rows, columns, spacing, and margin and are validated in the server animation module. The studio intentionally has no free rotation or 3D view: it is for fixed-camera 2D/2.5D art.

## Validation

The inspector records dimensions, file size, format, SHA-256, alpha coverage, opaque bounds, and crop warnings. These are review aids; only a person can approve an asset. Review lighting, camera, silhouette, scale, crop, alpha, provenance, and baked-in labels/checkerboards before promotion.
