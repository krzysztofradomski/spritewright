import { useDismissableMenu } from "./use-dismissable-menu.js";
import { Icon } from "./icon.js";

/** Top-bar project picker: a styled, light-dismissing menu that marks the current project. */
export function ProjectSwitcher({ games, value, onChange }: {
  games: Array<{ id: string; label: string }>;
  value: string;
  onChange: (id: string) => void;
}) {
  const { ref, close } = useDismissableMenu();
  const current = games.find((game) => game.id === value);
  return (
    <div className="game-switcher">
      <span className="game-switcher-caption" id="project-switcher-caption">Project</span>
      <details
        ref={ref}
        className="menu project-switcher"
      >
        <summary aria-labelledby="project-switcher-caption" aria-label={`Project: ${current?.label ?? "none"}`}>
          <Icon name="game" />
          <span>{current?.label ?? "Choose a project"}</span>
          <Icon name="chevron" />
        </summary>
        <div className="menu-list" role="listbox" aria-label="Projects">
          {games.map((game) => (
            <button
              key={game.id}
              type="button"
              role="option"
              aria-selected={game.id === value}
              onClick={() => { onChange(game.id); close(); }}
            >
              <Icon name={game.id === value ? "check" : "game"} />
              <span>{game.label}</span>
            </button>
          ))}
        </div>
      </details>
    </div>
  );
}
