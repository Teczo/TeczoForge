import { useEffect, useState } from "react";
import type { Preset, StartValues } from "./Generate";
import { ChevronDownIcon } from "./Icons";

// "Send to" (FRG-26): use a finished picture as the start image of another preset.
// The menu lists every preset with an image input, so a new preset folder shows up here with no
// code change (after a page refresh). Each item has two choices:
// - Open in Generate: the form opens filled in with the picture. Nothing starts until Generate.
// - Add to board: a new card in Ready with the picture. Its prompt is written later with Edit.

// The preset list, loaded once per page load and shared by every menu on the page.
let presetsLoad: Promise<Preset[]> | null = null;
function loadPresets(): Promise<Preset[]> {
  presetsLoad ??= fetch("/api/presets")
    .then((response) => response.json())
    .then((body) => body.presets ?? [])
    .catch(() => {
      presetsLoad = null; // Try again next time.
      return [];
    });
  return presetsLoad;
}

type SendToMenuProps = {
  jobId: string; // A finished picture job.
  onOpenInGenerate: (values: StartValues) => void;
  align?: "left" | "right"; // Which side the menu opens to.
};

export default function SendToMenu({ jobId, onOpenInGenerate, align = "left" }: SendToMenuProps) {
  const [targets, setTargets] = useState<Preset[]>([]);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);

  useEffect(() => {
    loadPresets().then((list) => setTargets(list.filter((p) => p.inputs.some((input) => input.kind === "image"))));
  }, []);

  // Close the menu when the user clicks anywhere else.
  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    window.addEventListener("click", close);
    return () => window.removeEventListener("click", close);
  }, [open]);

  async function send(preset: Preset, target: "generate" | "board") {
    setOpen(false);
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch("/api/send-to", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jobId, presetId: preset.id, target }),
      });
      const body = await response.json().catch(() => null);
      if (!body) setMessage({ text: "Could not reach the backend. Make sure it is running, then try again.", error: true });
      else if (!response.ok) setMessage({ text: body.error ?? "That did not work. Please try again.", error: true });
      else if (target === "generate") onOpenInGenerate({ presetId: body.presetId, inputs: body.inputs, sourceJobId: body.sourceJobId });
      else setMessage({ text: `Card "${body.card.title}" is in Ready on the board.`, error: false });
    } catch {
      setMessage({ text: "Could not reach the backend. Make sure it is running, then try again.", error: true });
    } finally {
      setBusy(false);
    }
  }

  if (targets.length === 0) return null;

  return (
    <div className="send-to" onClick={(event) => event.stopPropagation()}>
      <button type="button" className="button" onClick={() => setOpen(!open)} disabled={busy} aria-expanded={open}>
        {busy ? "Sending..." : "Send to"} <ChevronDownIcon size={16} />
      </button>
      {open && (
        <div className={`send-to-menu ${align}`}>
          {targets.map((preset) => (
            <div key={preset.id} className="send-to-item">
              <span>{preset.sendToLabel || preset.name}</span>
              <button type="button" onClick={() => send(preset, "generate")}>
                Open in Generate
              </button>
              <button type="button" onClick={() => send(preset, "board")}>
                Add to board
              </button>
            </div>
          ))}
        </div>
      )}
      {message && (
        <p className={`message ${message.error ? "error" : "info"}`}>
          {message.text} {!message.error && <a href="#/board">Open board</a>}
        </p>
      )}
    </div>
  );
}
