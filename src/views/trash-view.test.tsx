// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { api } from "../api/client.js";
import { TrashView } from "./trash-view.js";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

test("lists trashed assets and projects and restores an asset", async () => {
  vi.spyOn(api, "trash").mockResolvedValue({
    assets: [{ path: ".trash/plants/reed.png", family: "plants", filename: "reed.png", removedAt: "2026-09-15T08:00:00Z" }],
    projects: [{ name: "moss-town-2026-09-14T22-47-39-276Z", label: "Moss Town", trashedAt: "2026-09-14T22:47:39.276Z" }],
  });
  const restore = vi.spyOn(api, "restoreAsset").mockResolvedValue({ id: "a1", gameId: "pocket-river", family: "plants", state: "candidates", filename: "reed.png", relativePath: "candidates/plants/reed.png", tags: [] });
  const onAssetRestored = vi.fn(async () => undefined);
  const onNotice = vi.fn();
  render(<TrashView gameId="pocket-river" projectLabel="Pocket-River" onNotice={onNotice} onAssetRestored={onAssetRestored} onProjectRestored={async () => undefined} openDialog={vi.fn()} />);

  expect(await screen.findByText("reed.png")).toBeInTheDocument();
  expect(screen.getByText(/restores as a new candidate/)).toBeInTheDocument();
  expect(screen.getByText("Moss Town")).toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: "Restore" }));
  await waitFor(() => expect(restore).toHaveBeenCalledWith("pocket-river", ".trash/plants/reed.png"));
  await waitFor(() => expect(onAssetRestored).toHaveBeenCalled());
  expect(onNotice).toHaveBeenCalledWith("reed.png restored.");
});

test("deletes a selection forever only after confirming, and empty trash needs the typed word", async () => {
  vi.spyOn(api, "trash").mockResolvedValue({
    assets: [
      { path: ".trash/plants/reed.png", family: "plants", filename: "reed.png", removedAt: "2026-09-15T08:00:00Z" },
      { path: ".trash/plants/fern.png", family: "plants", filename: "fern.png", removedAt: "2026-09-15T07:00:00Z" },
    ],
    projects: [{ name: "moss-town-2026-09-14T22-47-39-276Z", label: "Moss Town", trashedAt: "2026-09-14T22:47:39.276Z" }],
  });
  const deleteAssets = vi.spyOn(api, "deleteTrashedAssets").mockResolvedValue({ deleted: [".trash/plants/reed.png"] });
  const deleteProjects = vi.spyOn(api, "deleteTrashedProjects").mockResolvedValue({ deleted: ["moss-town-2026-09-14T22-47-39-276Z"] });
  const dialogs: Array<Parameters<React.ComponentProps<typeof TrashView>["openDialog"]>[0]> = [];
  render(<TrashView gameId="pocket-river" projectLabel="Pocket-River" onNotice={vi.fn()} onAssetRestored={async () => undefined} onProjectRestored={async () => undefined} openDialog={(request) => dialogs.push(request)} />);

  fireEvent.click(await screen.findByLabelText("Select reed.png"));
  fireEvent.click(screen.getByLabelText("Select Moss Town"));
  fireEvent.click(screen.getByRole("button", { name: "Delete selected forever" }));
  expect(deleteAssets).not.toHaveBeenCalled(); // nothing happens before confirming
  expect(dialogs[0]!.message).toContain("Moss Town project folder");
  await dialogs[0]!.onConfirm("");
  expect(deleteAssets).toHaveBeenCalledWith("pocket-river", [".trash/plants/reed.png"]);
  expect(deleteProjects).toHaveBeenCalledWith(["moss-town-2026-09-14T22-47-39-276Z"]);

  deleteAssets.mockClear();
  fireEvent.click(screen.getByRole("button", { name: /Empty trash/ }));
  const empty = dialogs[1]!;
  expect(empty.input).toBeDefined();
  expect(await empty.onConfirm("nope")).toBe("Type delete to confirm.");
  expect(deleteAssets).not.toHaveBeenCalled();
  await empty.onConfirm("delete");
  expect(deleteAssets).toHaveBeenCalledWith("pocket-river", [".trash/plants/reed.png", ".trash/plants/fern.png"]);
});
