import { useDismissableMenu } from "./use-dismissable-menu.js";
import { Icon } from "./icon.js";

/** A styled, light-dismissing menu for sending an asset to another project. */
export function ProjectMenu({ games, disabled, onPick }: {
  games: Array<{ id: string; label: string }>;
  disabled: boolean;
  onPick: (game: { id: string; label: string }) => void;
}) {
  const { ref, close } = useDismissableMenu();
  return (
    <details
      ref={ref}
      className={`menu${disabled || !games.length ? " is-disabled" : ""}`}
    >
      <summary className="button" title={games.length ? undefined : "Create another project to move assets"}>
        <Icon name="game" />
        <span>Move to…</span>
        <Icon name="chevron" />
      </summary>
      <div className="menu-list" role="menu">
        <small>Move to project</small>
        {games.map((game) => (
          <button key={game.id} role="menuitem" onClick={() => { close(); onPick(game); }}>
            <Icon name="game" />
            <span>{game.label}</span>
          </button>
        ))}
      </div>
    </details>
  );
}
