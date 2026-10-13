import { useEffect, useRef, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import { Archive, Image, LayoutDashboard, MessageSquare, MoreHorizontal, Pencil, Plus, X } from "lucide-react";
import type { Project } from "./App";
import { changeProject, UNSORTED_NAME } from "./ProjectDialogs";

// The Projects page (FRG-50): every project as a tile, and "Create project".
// A click on a tile makes it the current project and opens the Chat page.
// The tile menu renames or archives a project (before FRG-50 this was the "Manage projects" dialog).

const NO_BACKEND = "Could not reach the backend. Make sure it is running, then try again.";

// The longest project name the backend accepts (backend/src/projects.ts).
const MAX_NAME_LENGTH = 60;

// One project, as GET /api/projects?summary=1 returns it (FRG-49).
type ProjectTile = Project & {
  jobCount: number;
  chatCount: number;
  cardCount: number;
  lastActivityAt: string;
  cover: string | null;
};

type ProjectsPageProps = {
  currentProjectId: string | undefined;
  onOpen: (project: Project) => void; // A tile was clicked: make it current and open the Chat page.
  onChanged: () => void; // A project was made, renamed or archived: the sidebar picker loads the list again.
};

export default function ProjectsPage({ currentProjectId, onOpen, onChanged }: ProjectsPageProps) {
  const [tiles, setTiles] = useState<ProjectTile[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  async function load() {
    try {
      const response = await fetch("/api/projects?summary=1");
      const body = await response.json().catch(() => null);
      if (!body) setError(NO_BACKEND);
      else if (!response.ok) setError(body.error ?? "Could not load the projects.");
      else {
        setTiles(body.projects);
        setError(null);
      }
    } catch {
      setError(NO_BACKEND);
    }
  }

  useEffect(() => {
    load();
  }, []);

  // Rename or archive (the same calls as the old "Manage projects" dialog), then load again.
  async function change(tile: ProjectTile, fields: { name?: string; archived?: boolean }) {
    const problem = await changeProject(tile.id, fields);
    if (problem) window.alert(problem);
    else onChanged();
    await load();
  }

  function rename(tile: ProjectTile) {
    const name = window.prompt(`New name for this project (at most ${MAX_NAME_LENGTH} characters):`, tile.name);
    if (name === null || name.trim() === "" || name.trim() === tile.name) return;
    change(tile, { name });
  }

  function archive(tile: ProjectTile) {
    const files = tile.jobCount === 1 ? "1 file" : `${tile.jobCount} files`;
    const question = `Archive "${tile.name}"? It leaves the project picker. Its ${files}, cards and chats are kept.`;
    if (!window.confirm(question)) return;
    change(tile, { archived: true });
  }

  return (
    <main className="mx-auto w-full max-w-6xl px-8 pt-2 pb-12">
      <div className="mb-6 flex flex-wrap items-center justify-between gap-4">
        <h1 className="m-0 text-2xl font-semibold text-slate-100">Projects</h1>
        <button
          type="button"
          onClick={() => setCreating(true)}
          disabled={!!error && !tiles}
          className="flex cursor-pointer items-center gap-2 rounded-xl border-0 bg-teal-600/90 px-4 py-2.5 text-sm font-medium text-white shadow-sm shadow-teal-900/20 transition-colors hover:bg-teal-500 disabled:cursor-not-allowed disabled:opacity-50"
        >
          <Plus size={16} />
          Create project
        </button>
      </div>

      {/* MongoDB offline, or the backend is not running: the backend's message instead of tiles. */}
      {error && <p className="message error">{error}</p>}
      {!tiles && !error && <p className="text-sm text-slate-500">Loading the projects...</p>}

      {tiles && (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-5">
          {tiles.map((tile) => (
            <Tile
              key={tile.id}
              tile={tile}
              current={tile.id === currentProjectId}
              onOpen={() => onOpen({ id: tile.id, name: tile.name })}
              onRename={() => rename(tile)}
              onArchive={() => archive(tile)}
            />
          ))}
        </div>
      )}

      {creating && (
        <CreateProjectDialog
          onClose={() => setCreating(false)}
          onCreated={() => {
            setCreating(false);
            onChanged();
            load();
          }}
        />
      )}
    </main>
  );
}

type TileProps = {
  tile: ProjectTile;
  current: boolean;
  onOpen: () => void;
  onRename: () => void;
  onArchive: () => void;
};

// One project: cover picture (or its first letter), name, counts and last activity.
function Tile({ tile, current, onOpen, onRename, onArchive }: TileProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [coverFailed, setCoverFailed] = useState(false);

  // Close the menu when the user clicks anywhere else.
  useEffect(() => {
    if (!menuOpen) return;
    const close = () => setMenuOpen(false);
    window.addEventListener("click", close);
    return () => window.removeEventListener("click", close);
  }, [menuOpen]);

  const showCover = tile.cover && !coverFailed;

  return (
    <div
      className={`relative overflow-hidden rounded-2xl border bg-slate-800/60 transition-colors ${
        current ? "border-teal-500/70 ring-2 ring-teal-500/30" : "border-slate-700/60 hover:border-slate-600"
      }`}
    >
      <button
        type="button"
        onClick={onOpen}
        title={`Open "${tile.name}"`}
        className="block w-full cursor-pointer border-0 bg-transparent p-0 text-left"
      >
        <div className="flex aspect-video items-center justify-center bg-slate-900/60">
          {showCover ? (
            <img src={tile.cover!} alt="" className="h-full w-full object-cover" onError={() => setCoverFailed(true)} />
          ) : (
            <span className="text-4xl font-semibold text-slate-600">{tile.name.charAt(0).toUpperCase()}</span>
          )}
        </div>
        <div className="px-4 pt-3 pb-4">
          <div className="flex items-center gap-2 pr-6">
            <span className="truncate text-sm font-semibold text-slate-100">{tile.name}</span>
            {current && (
              <span className="shrink-0 rounded-full bg-teal-500/15 px-2 py-0.5 text-[11px] font-medium text-teal-300">Current</span>
            )}
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-400">
            <Count icon={<Image size={13} />} value={tile.jobCount} one="file" many="files" />
            <Count icon={<MessageSquare size={13} />} value={tile.chatCount} one="chat" many="chats" />
            <Count icon={<LayoutDashboard size={13} />} value={tile.cardCount} one="card" many="cards" />
          </div>
          <div className="mt-2 text-xs text-slate-500" title={new Date(tile.lastActivityAt).toLocaleString()}>
            {timeAgo(tile.lastActivityAt)}
          </div>
        </div>
      </button>

      {/* Unsorted cannot be renamed or archived, so it has no menu. */}
      {tile.name !== UNSORTED_NAME && (
        <div className="absolute top-2 right-2">
          <button
            type="button"
            title="More"
            aria-label={`More for "${tile.name}"`}
            aria-expanded={menuOpen}
            onClick={(event) => {
              event.stopPropagation();
              setMenuOpen(!menuOpen);
            }}
            className="flex cursor-pointer items-center rounded-lg border-0 bg-slate-900/70 p-1.5 text-slate-300 backdrop-blur-sm transition-colors hover:bg-slate-700 hover:text-white"
          >
            <MoreHorizontal size={16} />
          </button>
          {menuOpen && (
            <div className="absolute top-full right-0 z-20 mt-1 w-36 rounded-xl border border-slate-600 bg-slate-700 py-1.5 shadow-2xl">
              <MenuItem icon={<Pencil size={14} />} label="Rename" onClick={onRename} />
              <MenuItem icon={<Archive size={14} />} label="Archive" onClick={onArchive} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function Count({ icon, value, one, many }: { icon: ReactNode; value: number; one: string; many: string }) {
  return (
    <span className="flex items-center gap-1">
      {icon}
      {value} {value === 1 ? one : many}
    </span>
  );
}

function MenuItem({ icon, label, onClick }: { icon: ReactNode; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full cursor-pointer items-center gap-2.5 border-0 bg-transparent px-3.5 py-2 text-left text-sm text-slate-200 transition-colors hover:bg-slate-600"
    >
      <span className="text-slate-400">{icon}</span>
      {label}
    </button>
  );
}

// "Create project": a small dialog with a name field. Shows the backend's error, for example a used name.
function CreateProjectDialog({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  async function create(event: FormEvent) {
    event.preventDefault();
    if (name.trim() === "") return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      const body = await response.json().catch(() => null);
      if (!body) setError(NO_BACKEND);
      else if (!response.ok) setError(body.error ?? "Could not make the project.");
      else onCreated();
    } catch {
      setError(NO_BACKEND);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4" onClick={onClose}>
      <form
        onSubmit={create}
        onClick={(event) => event.stopPropagation()}
        className="w-full max-w-sm rounded-2xl border border-slate-700 bg-slate-800 p-5 shadow-2xl"
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="m-0 text-base font-semibold text-slate-100">Create project</h2>
          <button
            type="button"
            onClick={onClose}
            title="Close"
            className="flex cursor-pointer items-center rounded-lg border-0 bg-transparent p-1.5 text-slate-400 hover:bg-slate-700 hover:text-slate-200"
          >
            <X size={16} />
          </button>
        </div>
        <label className="block text-xs font-medium text-slate-400">
          Name
          <input
            ref={inputRef}
            value={name}
            onChange={(event) => setName(event.target.value)}
            maxLength={MAX_NAME_LENGTH}
            placeholder="For example: Summer campaign"
            className="mt-1.5 block w-full rounded-lg border border-slate-600 bg-slate-900/60 px-3 py-2 text-sm text-slate-100 outline-none placeholder:text-slate-500 focus:border-teal-500/60"
          />
        </label>
        {error && <p className="mt-3 mb-0 text-sm text-red-400">{error}</p>}
        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="cursor-pointer rounded-lg border border-slate-600 bg-transparent px-4 py-2 text-sm text-slate-300 hover:bg-slate-700"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={busy || name.trim() === ""}
            className="cursor-pointer rounded-lg border-0 bg-teal-600 px-4 py-2 text-sm font-medium text-white hover:bg-teal-500 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {busy ? "Creating..." : "Create"}
          </button>
        </div>
      </form>
    </div>
  );
}

// "just now", "5 minutes ago", "yesterday", "2 days ago", ...
function timeAgo(iso: string): string {
  const seconds = Math.round((new Date(iso).getTime() - Date.now()) / 1000);
  const format = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
  const steps: [Intl.RelativeTimeFormatUnit, number][] = [
    ["year", 365 * 24 * 3600],
    ["month", 30 * 24 * 3600],
    ["week", 7 * 24 * 3600],
    ["day", 24 * 3600],
    ["hour", 3600],
    ["minute", 60],
  ];
  for (const [unit, size] of steps) {
    if (Math.abs(seconds) >= size) return format.format(Math.round(seconds / size), unit);
  }
  return "just now";
}
