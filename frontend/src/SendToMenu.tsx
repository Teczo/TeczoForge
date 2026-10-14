import { useEffect, useState } from "react";
import type { Preset, StartValues } from "./Generate";
import { ChevronDown, FastForward } from "lucide-react";

// "Send to" (FRG-26): use a finished picture as the start image of another preset.
// The menu lists every preset with an image input, so a new preset folder shows up here with no
// code change (after a page refresh). Each item has two choices:
// - Open in Generate: the form opens filled in with the picture. Nothing starts until Generate.
// - Add to board: a new card in Ready with the picture. Its prompt is written later with Edit.
// For a video, the menu has one item instead: "Extend" (FRG-54). It continues the clip from its
// last frame, with the same preset. Only for presets with a start image (image to video).

// The preset list, loaded once per page load and shared by every menu on the page.
let presetsLoad: Promise<Preset[]> | null = null;
export function loadPresets(): Promise<Preset[]> {
  presetsLoad ??= fetch("/api/presets")
    .then((response) => response.json())
    .then((body) => body.presets ?? [])
    .catch(() => {
      presetsLoad = null; // Try again next time.
      return [];
    });
  return presetsLoad;
}

const OFFLINE = "Could not reach the backend. Make sure it is running, then try again.";

// Can this video be extended? Only if its preset takes a start image (FRG-54).
function canExtend(presets: Preset[], presetId: string | null | undefined): boolean {
  return presets.some((p) => p.id === presetId && p.inputs.some((input) => input.kind === "image"));
}

// "Extend" (FRG-54): the backend saves the clip's last frame as a start image and answers with the
// values for the Generate form. Returns those values, or an error to show.
async function requestExtend(jobId: string): Promise<{ values: StartValues } | { error: string }> {
  try {
    const response = await fetch(`/api/jobs/${jobId}/extend`, { method: "POST" });
    const body = await response.json().catch(() => null);
    if (!body) return { error: OFFLINE };
    if (!response.ok) return { error: body.error ?? "Could not extend this video." };
    return { values: { presetId: body.presetId, inputs: body.inputs, parentJobId: body.parentJobId } };
  } catch {
    return { error: OFFLINE };
  }
}

// The "Extend" button on a finished video (FRG-54): opens the Generate form, filled in to continue
// the clip from its last frame. Hidden if the video's preset has no start image.
export function ExtendButton(props: { jobId: string; presetId: string | null | undefined; onOpenInGenerate: (values: StartValues) => void }) {
  const { jobId, presetId, onOpenInGenerate } = props;
  const [shown, setShown] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    loadPresets().then((list) => setShown(canExtend(list, presetId)));
  }, [presetId]);

  // Another video: forget the last error.
  useEffect(() => setError(null), [jobId]);

  async function extend() {
    setBusy(true);
    setError(null);
    const result = await requestExtend(jobId);
    setBusy(false);
    if ("error" in result) setError(result.error);
    else onOpenInGenerate(result.values);
  }

  if (!shown) return null;
  return (
    <span className="send-to">
      <button type="button" className="button" onClick={extend} disabled={busy} title="Continue this video from its last frame">
        <FastForward size={18} /> {busy ? "Getting the last frame..." : "Extend"}
      </button>
      {error && <p className="message error">{error}</p>}
    </span>
  );
}

type SendToMenuProps = {
  jobId: string; // A finished picture or video job.
  onOpenInGenerate: (values: StartValues) => void;
  align?: "left" | "right"; // Which side the menu opens to.
  // A video only offers "Extend" with its own preset (FRG-54). Default: a picture.
  kind?: "image" | "video";
  presetId?: string | null;
};

export default function SendToMenu({ jobId, onOpenInGenerate, align = "left", kind = "image", presetId }: SendToMenuProps) {
  const [targets, setTargets] = useState<Preset[]>([]);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);

  useEffect(() => {
    loadPresets().then((list) =>
      setTargets(
        kind === "video"
          ? list.filter((p) => p.id === presetId && canExtend(list, p.id))
          : list.filter((p) => p.inputs.some((input) => input.kind === "image")),
      ),
    );
  }, [kind, presetId]);

  // Close the menu when the user clicks anywhere else.
  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    window.addEventListener("click", close);
    return () => window.removeEventListener("click", close);
  }, [open]);

  async function extend() {
    setOpen(false);
    setBusy(true);
    setMessage(null);
    const result = await requestExtend(jobId);
    setBusy(false);
    if ("error" in result) setMessage({ text: result.error, error: true });
    else onOpenInGenerate(result.values);
  }

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
        {busy ? "Sending..." : "Send to"} <ChevronDown size={16} />
      </button>
      {open && (
        <div className={`send-to-menu ${align}`}>
          {kind === "video" && (
            <div className="send-to-item">
              <span>Extend (continue from the last frame)</span>
              <button type="button" onClick={extend}>
                Open in Generate
              </button>
            </div>
          )}
          {kind === "image" && targets.map((preset) => (
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
