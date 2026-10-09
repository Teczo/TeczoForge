import { useEffect, useState } from "react";
import type { DragEvent, FormEvent } from "react";
import Media, { isVideo } from "./Media";
import { defaultValues, Field, ImageBox, ProgressView, startFormValues, toInputs } from "./Generate";
import type { FormValues, Preset, Progress } from "./Generate";
import { CloseIcon, PlayIcon, SparklesIcon } from "./Icons";

// The board (FRG-22): cards are prompts that are saved but not run yet.
// Idea and Ready are moved by the user. Generating and Done follow the job status.
// The board asks the backend for all cards every 1.5 seconds, so progress and other people's
// changes show up by themselves.

const REFRESH_MS = 1500;
// How much of the prompt a card shows.
const PROMPT_PREVIEW_LENGTH = 90;

// One card, as GET /api/board returns it (see backend/src/drafts.ts).
type Card = {
  id: string;
  presetId: string | null;
  inputs: Record<string, unknown>;
  status: "draft" | "queued" | "running" | "done" | "failed" | "cancelled";
  title?: string; // Missing on jobs started from the Generate page.
  column?: "idea" | "ready";
  error: string | null;
  imageUrl: string | null;
  createdBy: string | null;
  progress?: Progress | null;
};

type ColumnId = "idea" | "ready" | "generating" | "done";
const COLUMNS: { id: ColumnId; label: string; hint: string }[] = [
  { id: "idea", label: "Idea", hint: "Drop a card here, or add one." },
  { id: "ready", label: "Ready", hint: "Cards here are ready to generate." },
  { id: "generating", label: "Generating", hint: "Waiting or running jobs show here." },
  { id: "done", label: "Done", hint: "Finished cards show here." },
];

function columnOf(card: Card): ColumnId {
  if (card.status === "draft") return card.column ?? "idea";
  if (card.status === "done") return "done";
  return "generating";
}

// The add, edit and copy form. The chat uses it too, to edit a card Claude made (FRG-24).
export type FormState = { cardId: string | null; presetId: string; title: string; values: FormValues };

export default function Board() {
  const [presets, setPresets] = useState<Preset[]>([]);
  const [cards, setCards] = useState<Card[] | null>(null);
  const [boardError, setBoardError] = useState<string | null>(null);
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);
  const [form, setForm] = useState<FormState | null>(null);
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState<string | null>(null);

  async function loadBoard() {
    try {
      const response = await fetch("/api/board");
      const body = await response.json().catch(() => null);
      if (!body) setBoardError("Could not reach the backend. Make sure it is running, then refresh the page.");
      else if (!response.ok) setBoardError(body.error ?? "Could not load the board.");
      else {
        setCards(body.cards);
        setBoardError(null);
      }
    } catch {
      setBoardError("Could not reach the backend. Make sure it is running, then refresh the page.");
    }
  }

  // Load the presets once, and the board now and every 1.5 seconds.
  useEffect(() => {
    fetch("/api/presets")
      .then((response) => response.json())
      .then((body) => setPresets(body.presets ?? []))
      .catch(() => {});
    loadBoard();
    const timer = setInterval(loadBoard, REFRESH_MS);
    return () => clearInterval(timer);
  }, []);

  // Send one change to the backend. Returns true if it worked. The board reloads after it.
  async function send(url: string, init: RequestInit): Promise<boolean> {
    try {
      const response = await fetch(url, init);
      const body = await response.json().catch(() => null);
      if (!body) {
        setMessage({ text: "Could not reach the backend. Make sure it is running, then try again.", error: true });
        return false;
      }
      if (!response.ok) {
        setMessage({ text: body.error ?? "That did not work. Please try again.", error: true });
        return false;
      }
      return true;
    } catch {
      setMessage({ text: "Could not reach the backend. Make sure it is running, then try again.", error: true });
      return false;
    } finally {
      loadBoard();
    }
  }

  function presetName(card: Card): string {
    return presets.find((p) => p.id === card.presetId)?.name ?? card.presetId ?? "Unknown preset";
  }

  async function moveCard(card: Card, column: "idea" | "ready") {
    if (card.status !== "draft" || card.column === column) return;
    // Move it on screen at once. The next reload shows what the backend saved.
    setCards((current) => current?.map((c) => (c.id === card.id ? { ...c, column } : c)) ?? null);
    await send(`/api/drafts/${card.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ column }),
    });
  }

  async function runCard(card: Card): Promise<boolean> {
    setMessage(null);
    return send(`/api/drafts/${card.id}/run`, { method: "POST" });
  }

  async function deleteCard(card: Card) {
    if (!window.confirm(`Delete the card "${card.title}"?`)) return;
    setMessage(null);
    if (await send(`/api/drafts/${card.id}`, { method: "DELETE" })) setMessage({ text: "Card deleted.", error: false });
  }

  async function generateAllReady() {
    const ready = (cards ?? []).filter((card) => columnOf(card) === "ready");
    const jobs = ready.length === 1 ? "1 job" : `${ready.length} jobs`;
    if (!window.confirm(`Generate all Ready cards? This starts ${jobs}.`)) return;
    setBusy(true);
    setMessage(null);
    let started = 0;
    for (const card of ready) {
      if (await runCard(card)) started++;
    }
    setBusy(false);
    if (started === ready.length) setMessage({ text: `Started ${jobs}.`, error: false });
    else setMessage({ text: `Started ${started} of ${jobs}. See the cards for what went wrong.`, error: true });
  }

  function openAddForm() {
    const first = presets[0];
    if (!first) return;
    setForm({ cardId: null, presetId: first.id, title: "", values: defaultValues(first) });
  }

  function openForm(card: Card, copy: boolean) {
    const preset = presets.find((p) => p.id === card.presetId);
    if (!preset) {
      setMessage({ text: `The preset "${card.presetId}" no longer exists.`, error: true });
      return;
    }
    setForm({
      cardId: copy ? null : card.id,
      presetId: preset.id,
      title: copy ? `Copy of ${card.title ?? preset.name}` : (card.title ?? ""),
      values: startFormValues(preset, { presetId: preset.id, inputs: card.inputs }),
    });
  }

  if (boardError && !cards) {
    return (
      <main className="page">
        <p className="message error">{boardError}</p>
      </main>
    );
  }
  if (!cards) return <main className="page empty">Loading the board...</main>;

  const readyCount = cards.filter((card) => columnOf(card) === "ready").length;

  // Native drag and drop: only drafts can be dragged, and only into Idea or Ready.
  function dropProps(column: ColumnId) {
    if (column !== "idea" && column !== "ready") return {};
    return {
      onDragOver: (event: DragEvent) => {
        if (dragging) event.preventDefault(); // Allows the drop.
      },
      onDrop: (event: DragEvent) => {
        event.preventDefault();
        const card = cards?.find((c) => c.id === event.dataTransfer.getData("text/plain"));
        if (card) moveCard(card, column);
        setDragging(null);
      },
    };
  }

  return (
    <main className="page board-page">
      <div className="gallery-head board-head">
        <div>
          <h1>Board</h1>
          <p>Save prompts as cards. Move them to Ready, then generate them with one click.</p>
        </div>
        <div className="button-row">
          <button className="button" onClick={generateAllReady} disabled={busy || readyCount === 0}>
            <PlayIcon size={16} /> Generate all Ready ({readyCount})
          </button>
          <button className="button primary" onClick={openAddForm} disabled={presets.length === 0}>
            <SparklesIcon size={18} /> Add card
          </button>
        </div>
      </div>

      {boardError && <p className="message error">{boardError}</p>}
      {message && <p className={`message ${message.error ? "error" : "info"}`}>{message.text}</p>}

      <div className="board">
        {COLUMNS.map((column) => {
          const columnCards = cards.filter((card) => columnOf(card) === column.id);
          const canDrop = dragging !== null && (column.id === "idea" || column.id === "ready");
          return (
            <section key={column.id} className={`board-column panel ${canDrop ? "drop-target" : ""}`} {...dropProps(column.id)}>
              <h2>
                {column.label} <span className="count">{columnCards.length}</span>
              </h2>
              {columnCards.length === 0 && <p className="board-hint">{column.hint}</p>}
              {columnCards.map((card) => (
                <CardView
                  key={card.id}
                  card={card}
                  column={column.id}
                  presetName={presetName(card)}
                  busy={busy}
                  onRun={() => runCard(card)}
                  onEdit={() => openForm(card, false)}
                  onCopy={() => openForm(card, true)}
                  onDelete={() => deleteCard(card)}
                  onMove={(to) => moveCard(card, to)}
                  onDragStart={(event) => {
                    event.dataTransfer.setData("text/plain", card.id);
                    setDragging(card.id);
                  }}
                  onDragEnd={() => setDragging(null)}
                />
              ))}
            </section>
          );
        })}
      </div>

      {form && (
        <CardForm
          presets={presets}
          state={form}
          onClose={() => setForm(null)}
          onSaved={(text) => {
            setForm(null);
            setMessage({ text, error: false });
            loadBoard();
          }}
        />
      )}
    </main>
  );
}

type CardViewProps = {
  card: Card;
  column: ColumnId;
  presetName: string;
  busy: boolean;
  onRun: () => void;
  onEdit: () => void;
  onCopy: () => void;
  onDelete: () => void;
  onMove: (to: "idea" | "ready") => void;
  onDragStart: (event: DragEvent) => void;
  onDragEnd: () => void;
};

function CardView(props: CardViewProps) {
  const { card, column, presetName, busy } = props;
  const isDraft = card.status === "draft";
  const prompt = String(card.inputs.prompt ?? "");
  const shortPrompt = prompt.length > PROMPT_PREVIEW_LENGTH ? `${prompt.slice(0, PROMPT_PREVIEW_LENGTH)}...` : prompt;

  return (
    <article
      className={`board-card ${isDraft ? "draggable" : ""}`}
      draggable={isDraft}
      onDragStart={isDraft ? props.onDragStart : undefined}
      onDragEnd={props.onDragEnd}
    >
      {card.status === "done" && card.imageUrl && (
        <div className="board-thumb">
          <Media url={card.imageUrl} mode="thumbnail" alt={prompt} />
          {isVideo(card.imageUrl) && (
            <span className="video-tag">
              <PlayIcon size={10} /> Video
            </span>
          )}
        </div>
      )}
      <h3>{card.title ?? presetName}</h3>
      <p className="board-meta">
        {presetName} · by {card.createdBy ?? "Unknown"}
      </p>
      {shortPrompt && <p className="board-prompt">{shortPrompt}</p>}
      {isDraft && card.error && <p className="message error">{card.error}</p>}
      {column === "generating" && <ProgressView progress={card.progress ?? null} onCancel={null} cancelling={false} />}

      {isDraft && (
        <div className="board-actions">
          <button className="button primary" onClick={props.onRun} disabled={busy}>
            <SparklesIcon size={16} /> Generate
          </button>
          <button className="button" onClick={props.onEdit} disabled={busy}>
            Edit
          </button>
          <button className="button" onClick={props.onDelete} disabled={busy}>
            Delete
          </button>
          <button className="button" onClick={() => props.onMove(column === "idea" ? "ready" : "idea")} disabled={busy}>
            {column === "idea" ? "To Ready →" : "← To Idea"}
          </button>
        </div>
      )}
      {card.status === "done" && (
        <div className="board-actions">
          <a className="button" href={`#/gallery/${card.id}`}>
            Open
          </a>
          <button className="button" onClick={props.onCopy}>
            Copy as new card
          </button>
        </div>
      )}
    </article>
  );
}

type CardFormProps = {
  presets: Preset[];
  state: FormState;
  onClose: () => void;
  onSaved: (message: string) => void;
};

// Add a card, edit one, or copy a finished one. The backend checks the values like a real job.
export function CardForm({ presets, state, onClose, onSaved }: CardFormProps) {
  const [presetId, setPresetId] = useState(state.presetId);
  const [title, setTitle] = useState(state.title);
  const [values, setValues] = useState<FormValues>(state.values);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const editing = state.cardId !== null;
  const preset = presets.find((p) => p.id === presetId);

  function choosePreset(id: string) {
    const chosen = presets.find((p) => p.id === id);
    if (!chosen) return;
    setPresetId(id);
    setValues(defaultValues(chosen));
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (!preset) return;
    setSaving(true);
    setError(null);
    const inputs = toInputs(preset, values);
    try {
      const response = await fetch(editing ? `/api/drafts/${state.cardId}` : "/api/drafts", {
        method: editing ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(editing ? { title, inputs } : { presetId, title, inputs }),
      });
      const body = await response.json().catch(() => null);
      if (!body) setError("Could not reach the backend. Make sure it is running, then try again.");
      else if (!response.ok) setError(body.error ?? "Could not save the card.");
      else onSaved(editing ? "Card saved." : "Card added to Idea.");
    } catch {
      setError("Could not reach the backend. Make sure it is running, then try again.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <form className="modal panel" onClick={(event) => event.stopPropagation()} onSubmit={handleSubmit}>
        <div className="modal-head">
          <h2>{editing ? "Edit card" : "Add card"}</h2>
          <button type="button" className="icon-button" onClick={onClose} title="Close">
            <CloseIcon size={18} />
          </button>
        </div>

        <label>
          <span className="field-label">Preset</span>
          <select className="input" value={presetId} onChange={(e) => choosePreset(e.target.value)} disabled={editing || saving}>
            {presets.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>

        <label>
          <span className="field-label">Title</span>
          <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={100} disabled={saving} />
        </label>

        {preset?.inputs.map((input) => {
          const value = values[input.key] ?? "";
          const onChange = (next: string) => setValues((current) => ({ ...current, [input.key]: next }));
          if (input.kind === "text") {
            return (
              <label key={input.key}>
                <span className="field-label">{input.label}</span>
                <textarea
                  className="prompt-box"
                  value={value}
                  onChange={(e) => onChange(e.target.value)}
                  disabled={saving}
                />
              </label>
            );
          }
          if (input.kind === "image") {
            return <ImageBox key={`${presetId}/${input.key}`} input={input} value={value} disabled={saving} onChange={onChange} />;
          }
          return <Field key={input.key} input={input} value={value} disabled={saving} onChange={onChange} />;
        })}

        {error && <p className="message error">{error}</p>}
        <div className="button-row">
          <button type="submit" className="button primary" disabled={saving || !preset}>
            {saving ? "Saving..." : editing ? "Save card" : "Add card"}
          </button>
          <button type="button" className="button" onClick={onClose}>
            Cancel
          </button>
        </div>
      </form>
    </div>
  );
}
