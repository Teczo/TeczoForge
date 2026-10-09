import { useEffect, useState } from "react";
import Media from "./Media";
import { CardForm } from "./Board";
import type { FormState } from "./Board";
import { ProgressView, startFormValues } from "./Generate";
import type { Preset, Progress } from "./Generate";
import { SparklesIcon } from "./Icons";

// A board card that Claude made in the chat (FRG-24). It is the same card as on the board.
// Generate here runs it, the same as on the board. While it runs it shows progress,
// and when it is done it shows the image or video.

// How often to ask about a card that is waiting or running.
const REFRESH_MS = 1500;
const PROMPT_PREVIEW_LENGTH = 200;

// What the chat keeps about a card (see backend/src/chatTools.ts).
export type ChatCardRef = { id: string; title: string; presetId: string };

// The card as GET /api/jobs/<id> returns it. Only the parts this view uses.
type Card = {
  id: string;
  presetId: string;
  title?: string;
  inputs: Record<string, unknown>;
  status: "draft" | "queued" | "running" | "done" | "failed" | "cancelled";
  error: string | null;
  imageUrl: string | null;
  progress: Progress | null;
};

const NO_BACKEND = "Could not reach the backend. Make sure it is running, then try again.";

export default function ChatCard({ card: ref, presets }: { card: ChatCardRef; presets: Preset[] }) {
  const [card, setCard] = useState<Card | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState<FormState | null>(null);

  async function load() {
    try {
      const response = await fetch(`/api/jobs/${ref.id}`);
      const body = await response.json().catch(() => null);
      if (response.status === 404) setProblem("This card was deleted on the board.");
      else if (!body || !response.ok) setProblem(body?.error ?? NO_BACKEND);
      else {
        setCard(body);
        setProblem(null);
      }
    } catch {
      setProblem(NO_BACKEND);
    }
  }

  useEffect(() => {
    load();
  }, [ref.id]);

  // While it waits or runs, ask again every 1.5 seconds for the progress.
  const active = card?.status === "queued" || card?.status === "running";
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(load, REFRESH_MS);
    return () => clearInterval(timer);
  }, [active, ref.id]);

  // Generate: run the draft, the same as the board's Generate button.
  async function generate() {
    setBusy(true);
    setProblem(null);
    try {
      const response = await fetch(`/api/drafts/${ref.id}/run`, { method: "POST" });
      const body = await response.json().catch(() => null);
      if (!body) setProblem(NO_BACKEND);
      else if (!response.ok) setProblem(body.error ?? "Could not start the card.");
    } catch {
      setProblem(NO_BACKEND);
    } finally {
      setBusy(false);
      load();
    }
  }

  const preset = presets.find((p) => p.id === (card?.presetId ?? ref.presetId));

  function openEdit() {
    if (!card || !preset) return;
    setForm({
      cardId: card.id,
      presetId: preset.id,
      title: card.title ?? ref.title,
      values: startFormValues(preset, { presetId: preset.id, inputs: card.inputs }),
    });
  }

  const prompt = String(card?.inputs.prompt ?? "");
  const shortPrompt = prompt.length > PROMPT_PREVIEW_LENGTH ? `${prompt.slice(0, PROMPT_PREVIEW_LENGTH)}...` : prompt;

  return (
    <div className="chat-card">
      <div className="chat-card-head">
        <strong>{card?.title ?? ref.title}</strong>
        <span className="board-meta">{preset?.name ?? ref.presetId}</span>
      </div>
      {shortPrompt && <p className="board-prompt">{shortPrompt}</p>}

      {card?.status === "draft" && card.error && <p className="message error">{card.error}</p>}
      {active && <ProgressView progress={card.progress} onCancel={null} cancelling={false} />}
      {card?.status === "done" && card.imageUrl && (
        <div className="chat-card-result">
          <Media url={card.imageUrl} mode="full" alt={prompt} />
        </div>
      )}
      {problem && <p className="message error">{problem}</p>}

      <div className="board-actions">
        {card?.status === "draft" && (
          <>
            <button className="button primary" onClick={generate} disabled={busy}>
              <SparklesIcon size={16} /> Generate
            </button>
            <button className="button" onClick={openEdit} disabled={busy || !preset}>
              Edit
            </button>
          </>
        )}
        {card?.status === "done" && (
          <a className="button" href={`#/gallery/${ref.id}`}>
            Open in gallery
          </a>
        )}
        <a className="button" href="#/board">
          Open board
        </a>
      </div>

      {form && (
        <CardForm
          presets={presets}
          state={form}
          onClose={() => setForm(null)}
          onSaved={() => {
            setForm(null);
            load();
          }}
        />
      )}
    </div>
  );
}
