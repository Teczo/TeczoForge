import { useEffect, useRef, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import { btn, FIELD, LABEL, Modal } from "./ui";

// In-app questions and messages. They replace the browser's own window.confirm, window.prompt
// and window.alert popups, so they look like the rest of the app (light and dark mode).
//
// Use them with await, the same way as the browser popups:
//   if (!(await askConfirm({ title: "Delete card?", message: "..." }))) return;
//   const name = await askText({ title: "Rename project", label: "Name", value: "Old name" });
//   await showMessage({ title: "Could not copy", message: "..." });
//
// <DialogHost /> draws them. It is placed once, in main.tsx.

type ConfirmOptions = {
  title: string;
  message?: ReactNode;
  confirmLabel?: string; // Default "OK".
  cancelLabel?: string; // Default "Cancel".
  danger?: boolean; // true: the confirm button is red, for things that delete or stop work.
};

type TextOptions = {
  title: string;
  label: string;
  value?: string; // The text already in the field.
  placeholder?: string;
  maxLength?: number;
  confirmLabel?: string; // Default "Save".
  // Optional: check or save the value. Return an error message to keep the dialog open and show it,
  // or null when it is fine. While it runs, the buttons are disabled.
  onSubmit?: (value: string) => Promise<string | null>;
};

type MessageOptions = {
  title: string;
  message: ReactNode;
};

type Request =
  | { kind: "confirm"; options: ConfirmOptions; resolve: (answer: boolean) => void }
  | { kind: "text"; options: TextOptions; resolve: (answer: string | null) => void }
  | { kind: "message"; options: MessageOptions; resolve: () => void };

// The one dialog that is open now (or null), and the host that draws it.
let show: ((request: Request | null) => void) | null = null;

function open<T>(make: (resolve: (answer: T) => void) => Request, fallback: T): Promise<T> {
  // No host on the page (should not happen): answer as if the user pressed Cancel.
  if (!show) return Promise.resolve(fallback);
  const draw = show;
  return new Promise<T>((resolve) => {
    draw(
      make((answer) => {
        draw(null);
        resolve(answer);
      }),
    );
  });
}

// Ask a yes/no question. Resolves to true for the confirm button, false for Cancel, X, Escape or a click outside.
export function askConfirm(options: ConfirmOptions): Promise<boolean> {
  return open<boolean>((resolve) => ({ kind: "confirm", options, resolve }), false);
}

// Ask for a line of text. Resolves to the trimmed text, or null when the user cancels or leaves it empty.
export function askText(options: TextOptions): Promise<string | null> {
  return open<string | null>((resolve) => ({ kind: "text", options, resolve }), null);
}

// Show a message with one OK button.
export function showMessage(options: MessageOptions): Promise<void> {
  return open<void>((resolve) => ({ kind: "message", options, resolve }), undefined);
}

export function DialogHost() {
  const [request, setRequest] = useState<Request | null>(null);

  useEffect(() => {
    show = setRequest;
    return () => {
      show = null;
    };
  }, []);

  if (!request) return null;
  if (request.kind === "confirm") return <ConfirmDialog options={request.options} answer={request.resolve} />;
  if (request.kind === "text") return <TextDialog options={request.options} answer={request.resolve} />;
  return <MessageDialog options={request.options} answer={request.resolve} />;
}

// Escape closes the dialog, the same as Cancel.
function useEscape(onEscape: () => void) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onEscape();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onEscape]);
}

function Message({ children }: { children: ReactNode }) {
  return <div className="m-0 text-sm leading-relaxed whitespace-pre-line text-ink-2">{children}</div>;
}

function Buttons({ children }: { children: ReactNode }) {
  return <div className="mt-5 flex justify-end gap-2">{children}</div>;
}

function ConfirmDialog({ options, answer }: { options: ConfirmOptions; answer: (yes: boolean) => void }) {
  const confirmRef = useRef<HTMLButtonElement>(null);
  const cancel = () => answer(false);
  useEscape(cancel);
  // The confirm button has the focus, so Enter says yes (like the browser popup).
  useEffect(() => confirmRef.current?.focus(), []);

  return (
    <Modal title={options.title} onClose={cancel}>
      {options.message && <Message>{options.message}</Message>}
      <Buttons>
        <button type="button" onClick={cancel} className={btn("secondary")}>
          {options.cancelLabel ?? "Cancel"}
        </button>
        <button ref={confirmRef} type="button" onClick={() => answer(true)} className={btn(options.danger ? "danger" : "primary")}>
          {options.confirmLabel ?? "OK"}
        </button>
      </Buttons>
    </Modal>
  );
}

function TextDialog({ options, answer }: { options: TextOptions; answer: (text: string | null) => void }) {
  const [value, setValue] = useState(options.value ?? "");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const cancel = () => {
    if (!busy) answer(null);
  };
  useEscape(cancel);
  useEffect(() => inputRef.current?.select(), []);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const text = value.trim();
    if (text === "") return;
    if (options.onSubmit) {
      setBusy(true);
      setError(null);
      const problem = await options.onSubmit(text);
      setBusy(false);
      if (problem) {
        setError(problem);
        return;
      }
    }
    answer(text);
  }

  return (
    <Modal title={options.title} onClose={cancel}>
      <form onSubmit={submit}>
        <label className="block">
          <span className={LABEL}>{options.label}</span>
          <input
            ref={inputRef}
            value={value}
            onChange={(event) => setValue(event.target.value)}
            maxLength={options.maxLength}
            placeholder={options.placeholder}
            className={`${FIELD} h-9`}
          />
        </label>
        {error && <p className="mt-3 mb-0 text-sm text-danger">{error}</p>}
        <Buttons>
          <button type="button" onClick={cancel} disabled={busy} className={btn("secondary")}>
            Cancel
          </button>
          <button type="submit" disabled={busy || value.trim() === ""} className={btn("primary")}>
            {busy ? "Saving..." : (options.confirmLabel ?? "Save")}
          </button>
        </Buttons>
      </form>
    </Modal>
  );
}

function MessageDialog({ options, answer }: { options: MessageOptions; answer: () => void }) {
  const okRef = useRef<HTMLButtonElement>(null);
  useEscape(answer);
  useEffect(() => okRef.current?.focus(), []);

  return (
    <Modal title={options.title} onClose={answer}>
      <Message>{options.message}</Message>
      <Buttons>
        <button ref={okRef} type="button" onClick={answer} className={btn("primary")}>
          OK
        </button>
      </Buttons>
    </Modal>
  );
}
