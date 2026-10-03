import { useEffect, useRef, useState } from "react";

export type DialogRequest = {
  title: string;
  message: string;
  confirmLabel: string;
  danger?: boolean;
  input?: { label: string; placeholder?: string };
  /** Return a message to keep the dialog open and show it as an error. */
  onConfirm: (value: string) => Promise<string | void> | string | void;
};

/** In-app replacement for window.confirm / window.prompt, built on the native <dialog>. */
export function Modal({ request, onClose }: { request: DialogRequest; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [value, setValue] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    ref.current?.showModal();
  }, []);
  return (
    <dialog
      ref={ref}
      className="modal"
      aria-labelledby="modal-title"
      onClose={onClose}
      onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); if (!busy) ref.current?.close(); } }}
      onClick={(event) => { if (event.target === event.currentTarget && !busy) ref.current?.close(); }}
    >
      <form
        method="dialog"
        onSubmit={async (event) => {
          event.preventDefault();
          setBusy(true);
          const problem = await request.onConfirm(value.trim());
          setBusy(false);
          if (problem) return setError(problem);
          ref.current?.close();
        }}
      >
        <h2 id="modal-title">{request.title}</h2>
        <p className="quiet">{request.message}</p>
        {request.input && (
          <label>
            {request.input.label}
            <input
              autoFocus
              value={value}
              placeholder={request.input.placeholder}
              aria-invalid={Boolean(error)}
              onChange={(event) => { setValue(event.target.value); setError(""); }}
            />
          </label>
        )}
        {error && <p className="modal-error" role="alert">{error}</p>}
        <div className="modal-actions">
          <button type="button" disabled={busy} onClick={() => ref.current?.close()}>Cancel</button>
          <button type="submit" className={request.danger ? "danger-solid" : "primary"} disabled={busy || (Boolean(request.input) && !value.trim())} autoFocus={!request.input}>
            {busy ? "Working…" : request.confirmLabel}
          </button>
        </div>
      </form>
    </dialog>
  );
}
