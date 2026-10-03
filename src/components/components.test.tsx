// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, expect, test, vi } from "vitest";
import { api, type ProviderStatus } from "../api/client.js";
import { AnimationThumbnail, type SavedAnimation } from "./animation-thumbnail.js";
import { GeneratorSelect } from "./generator-select.js";
import { Modal } from "./modal.js";
import { AnimationMotionsPanel } from "./animation-motions-panel.js";



beforeAll(() => {
  // jsdom has no <dialog> modal support; open/close just toggle the attribute and fire "close".
  HTMLDialogElement.prototype.showModal = function showModal() {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close = function close() {
    this.removeAttribute("open");
    this.dispatchEvent(new Event("close"));
  };
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

test("a typed confirmation shows the mismatch and keeps the dialog open until it matches", async () => {
  const onConfirm = vi.fn((typed: string) => (typed === "Pocket-River" ? undefined : "That doesn't match."));
  const onClose = vi.fn();
  render(
    <Modal
      request={{ title: "Delete Pocket-River?", message: "Type the name.", confirmLabel: "Delete project", danger: true, input: { label: "Project name" }, onConfirm }}
      onClose={onClose}
    />,
  );
  const input = screen.getByLabelText("Project name");
  const submit = screen.getByRole("button", { name: "Delete project" });
  expect(submit).toBeDisabled();

  fireEvent.change(input, { target: { value: "pocket river" } });
  fireEvent.click(submit);
  expect(await screen.findByRole("alert")).toHaveTextContent("That doesn't match.");
  expect(onClose).not.toHaveBeenCalled();

  fireEvent.change(input, { target: { value: "Pocket-River" } });
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  fireEvent.click(submit);
  await waitFor(() => expect(onClose).toHaveBeenCalled());
  expect(onConfirm).toHaveBeenLastCalledWith("Pocket-River");
});

const status = (id: ProviderStatus["id"], state: ProviderStatus["state"], extra: Partial<ProviderStatus> = {}): ProviderStatus =>
  ({ id, label: id, role: "", state, summary: `${id} ${state}`, details: [], canProbe: false, checkedAt: "2026-09-15T00:00:00Z", ...extra });

test("the generator dropdown lists exhausted providers but won't select them", () => {
  const onChange = vi.fn();
  render(
    <GeneratorSelect
      value="delegate-antigravity"
      checking={false}
      onChange={onChange}
      providers={[
        status("antigravity", "unknown"),
        status("grok", "limited"),
        status("codex", "unavailable"),
        status("openrouter", "ready", { quota: [{ label: "Account credit", usedPercent: 82, remaining: "$1.84 of $10.00 left" }] }),
      ]}
    />,
  );
  const options = screen.getAllByRole("option");
  expect(options.map((option) => option.textContent)).toEqual([
    expect.stringContaining("Antigravity"),
    expect.stringContaining("Grok Build"),
    expect.stringContaining("Codex"),
    expect.stringContaining("$1.84 of $10.00 left"),
    expect.stringContaining("Google AI Studio"),
    expect.stringContaining("OpenAI"),
    expect.stringContaining("Cloudflare Workers AI"),
    // No image provider behind it, so it shows its own note instead of a health summary.
    expect.stringContaining("ComfyUI (local)"),
    expect.stringContaining("Pixel art (SVG)"),
  ]);
  const grok = screen.getByRole("option", { name: /Grok Build/ });
  expect(grok).toHaveAttribute("aria-disabled", "true");
  fireEvent.click(grok);
  expect(onChange).not.toHaveBeenCalled();

  fireEvent.click(screen.getByRole("option", { name: /OpenRouter/ }));
  expect(onChange).toHaveBeenCalledWith("openrouter");
});

test("an option can be picked when the browser doesn't focus clicked buttons (Safari)", () => {
  const onChange = vi.fn();
  const { container } = render(
    <GeneratorSelect value="delegate-antigravity" checking={false} onChange={onChange} providers={[status("antigravity", "limited"), status("openrouter", "ready")]} />,
  );
  const menu = container.querySelector("details")!;
  const summary = container.querySelector("summary")!;
  summary.focus();
  fireEvent.click(summary);
  menu.setAttribute("open", "");
  // Safari: pressing an option blurs the summary without focusing the option.
  const option = screen.getByRole("option", { name: /OpenRouter/ });
  fireEvent.pointerDown(option);
  fireEvent.blur(summary, { relatedTarget: null });
  expect(menu).toHaveAttribute("open");
  fireEvent.click(option);
  expect(onChange).toHaveBeenCalledWith("openrouter");
  expect(menu).not.toHaveAttribute("open");

  // Pressing outside still closes it.
  menu.setAttribute("open", "");
  fireEvent.pointerDown(document.body);
  expect(menu).not.toHaveAttribute("open");
});

const sampleAnim: SavedAnimation = {
  id: "anim-1",
  name: "duck-walk",
  fps: 10,
  loop: "loop",
  frames: [
    { assetId: "asset-1", sourcePath: "a.png", rect: { x: 0, y: 0, width: 32, height: 32 } },
    { assetId: "asset-2", sourcePath: "b.png", rect: { x: 32, y: 0, width: 32, height: 32 } },
    { assetId: "asset-3", sourcePath: "c.png", rect: { x: 64, y: 0, width: 32, height: 32 } },
  ],
};

test("animation thumbnail is static by default and shows the play overlay button", () => {
  render(<AnimationThumbnail animation={sampleAnim} gameId="pocket-river" />);
  const playButton = screen.getByRole("button", { name: "Play duck-walk" });
  expect(playButton).toBeInTheDocument();
  expect(playButton).toHaveTextContent("Play");

  const img = screen.getByRole("img", { name: "duck-walk animation preview" });
  expect(img).toHaveAttribute("src", expect.stringContaining("asset-1"));
});

test("clicking the overlay button starts playback and cycles frames", () => {
  vi.useFakeTimers();
  render(<AnimationThumbnail animation={sampleAnim} gameId="pocket-river" />);

  const playButton = screen.getByRole("button", { name: "Play duck-walk" });
  const img = screen.getByRole("img", { name: "duck-walk animation preview" });
  expect(img).toHaveAttribute("src", expect.stringContaining("asset-1"));

  // Stays static while not played even if time passes
  act(() => {
    vi.advanceTimersByTime(500);
  });
  expect(img).toHaveAttribute("src", expect.stringContaining("asset-1"));

  // Click play
  fireEvent.click(playButton);
  const pauseButton = screen.getByRole("button", { name: "Pause duck-walk" });
  expect(pauseButton).toBeInTheDocument();
  expect(pauseButton).toHaveTextContent("Pause");

  // Advance time: 100ms per frame (10 FPS)
  act(() => {
    vi.advanceTimersByTime(100);
  });
  expect(img).toHaveAttribute("src", expect.stringContaining("asset-2"));

  act(() => {
    vi.advanceTimersByTime(100);
  });
  expect(img).toHaveAttribute("src", expect.stringContaining("asset-3"));

  // Loops back to frame 1
  act(() => {
    vi.advanceTimersByTime(100);
  });
  expect(img).toHaveAttribute("src", expect.stringContaining("asset-1"));
});

test("clicking the overlay button while playing pauses playback", () => {
  vi.useFakeTimers();
  render(<AnimationThumbnail animation={sampleAnim} gameId="pocket-river" />);

  fireEvent.click(screen.getByRole("button", { name: "Play duck-walk" }));
  act(() => {
    vi.advanceTimersByTime(100);
  });

  const img = screen.getByRole("img", { name: "duck-walk animation preview" });
  expect(img).toHaveAttribute("src", expect.stringContaining("asset-2"));

  // Pause
  const pauseButton = screen.getByRole("button", { name: "Pause duck-walk" });
  fireEvent.click(pauseButton);
  expect(screen.getByRole("button", { name: "Play duck-walk" })).toBeInTheDocument();

  // Time passes while paused; frame should not advance
  act(() => {
    vi.advanceTimersByTime(500);
  });
  expect(img).toHaveAttribute("src", expect.stringContaining("asset-2"));
});

test("an animation with loop='once' stops at the final frame and resets upon playing again", () => {
  vi.useFakeTimers();
  const onceAnim: SavedAnimation = { ...sampleAnim, loop: "once" };
  render(<AnimationThumbnail animation={onceAnim} gameId="pocket-river" />);

  fireEvent.click(screen.getByRole("button", { name: "Play duck-walk" }));
  const img = screen.getByRole("img", { name: "duck-walk animation preview" });

  act(() => {
    vi.advanceTimersByTime(100); // frame 2
  });
  expect(img).toHaveAttribute("src", expect.stringContaining("asset-2"));

  act(() => {
    vi.advanceTimersByTime(100); // frame 3 (last frame)
  });
  expect(img).toHaveAttribute("src", expect.stringContaining("asset-3"));

  // Next tick finishes 'once' loop and stops
  act(() => {
    vi.advanceTimersByTime(100);
  });
  expect(screen.getByRole("button", { name: "Play duck-walk" })).toBeInTheDocument();
  expect(img).toHaveAttribute("src", expect.stringContaining("asset-3"));

  // Clicking play again resets to frame 1 and plays
  fireEvent.click(screen.getByRole("button", { name: "Play duck-walk" }));
  expect(img).toHaveAttribute("src", expect.stringContaining("asset-1"));
});

test("AnimationMotionsPanel loads motions, allows add, modify, delete, and save", async () => {
  const mockMotions: Record<string, string> = {
    idle: "1 breathing",
    walk: "1 stepping",
  };
  vi.spyOn(api, "motions").mockResolvedValue(mockMotions);
  const saveSpy = vi.spyOn(api, "saveMotions").mockResolvedValue({ idle: "1 breathing", walk: "1 stepping updated", jump: "1 jumping" });
  const onNotice = vi.fn();
  const onMotionsChange = vi.fn();

  render(<AnimationMotionsPanel onNotice={onNotice} onMotionsChange={onMotionsChange} />);

  expect(await screen.findByRole("heading", { name: "Animation motions" })).toBeInTheDocument();
  expect(screen.getByDisplayValue("idle")).toBeInTheDocument();
  expect(screen.getByDisplayValue("1 breathing")).toBeInTheDocument();
  expect(screen.getByDisplayValue("walk")).toBeInTheDocument();

  // Modify walk motion
  const walkPoses = screen.getByDisplayValue("1 stepping");
  fireEvent.change(walkPoses, { target: { value: "1 stepping updated" } });
  expect(walkPoses).toHaveValue("1 stepping updated");

  // Add new motion
  fireEvent.click(screen.getByRole("button", { name: /New motion/i }));
  const newNameInput = screen.getByDisplayValue("new-motion");
  fireEvent.change(newNameInput, { target: { value: "jump" } });
  const jumpPoses = screen.getByLabelText("Key poses description for jump");
  fireEvent.change(jumpPoses, { target: { value: "1 jumping" } });

  // Save motions
  const saveButton = screen.getByRole("button", { name: "Save motions" });
  expect(saveButton).not.toBeDisabled();
  fireEvent.click(saveButton);

  await waitFor(() => {
    expect(saveSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        idle: "1 breathing",
        walk: "1 stepping updated",
        jump: "1 jumping",
      }),
    );
  });
  expect(onNotice).toHaveBeenCalledWith(expect.stringContaining("Saved 3 animation motions"));
  expect(onMotionsChange).toHaveBeenCalled();

  // Delete motion
  const deleteJumpBtn = screen.getByRole("button", { name: "Delete jump" });
  fireEvent.click(deleteJumpBtn);
  expect(screen.queryByDisplayValue("jump")).not.toBeInTheDocument();
});



test("pixel assets are styled to scale without smoothing", () => {
  // Read from the vitest root: under jsdom, import.meta.url is not a file: URL.
  const css = readFileSync(join(process.cwd(), "src/styles.css"), "utf8");
  expect(css).toMatch(/\.is-pixel[^{]*\{[^}]*image-rendering:\s*pixelated/);
});
