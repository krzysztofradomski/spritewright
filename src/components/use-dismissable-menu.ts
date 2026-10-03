import { useEffect, useRef } from "react";

/**
 * Closes a <details> menu when the user presses or focuses outside it, or presses Escape.
 * Closing on blur doesn't work: Safari never focuses a clicked button, so a blur-based menu
 * closed itself before the click on one of its options could land.
 */
export function useDismissableMenu() {
  const ref = useRef<HTMLDetailsElement>(null);
  const close = () => ref.current?.removeAttribute("open");
  useEffect(() => {
    const menu = ref.current;
    if (!menu) return;
    const onOutside = (event: Event) => {
      if (menu.open && event.target instanceof Node && !menu.contains(event.target)) close();
    };
    const onKey = (event: KeyboardEvent) => {
      if (menu.open && event.key === "Escape") close();
    };
    document.addEventListener("pointerdown", onOutside);
    document.addEventListener("focusin", onOutside);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onOutside);
      document.removeEventListener("focusin", onOutside);
      document.removeEventListener("keydown", onKey);
    };
  }, []);
  return { ref, close };
}
