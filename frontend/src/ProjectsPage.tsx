import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { Archive, Image, LayoutDashboard, MessageSquare, MoreHorizontal, Pencil, Plus } from "lucide-react";
import type { Project } from "./App";
import { askConfirm, askText, showMessage } from "./dialogs";
import { changeProject, CreateProjectDialog, MAX_NAME_LENGTH, UNSORTED_NAME } from "./ProjectDialogs";
import { Badge, btn, Loading, Notice, PageHeader } from "./ui";

// The Projects page (FRG-50): every project as a tile, and "Create project".
// A click on a tile makes it the current project and opens the Chat page.
// The tile menu renames or archives a project (before FRG-50 this was the "Manage projects" dialog).

const NO_BACKEND = "Could not reach the backend. Make sure it is running, then try again.";

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

  // Rename: the dialog saves the new name itself, so a backend error (for example a used name)
  // shows inside the dialog and the user can fix it.
  async function rename(tile: ProjectTile) {
    const name = await askText({
      title: "Rename project",
      label: "Name",
      value: tile.name,
      maxLength: MAX_NAME_LENGTH,
      onSubmit: (value) => (value === tile.name ? Promise.resolve(null) : changeProject(tile.id, { name: value })),
    });
    if (name === null || name === tile.name) return;
    onChanged();
    await load();
  }

  // Archive (the same call as the old "Manage projects" dialog), then load again.
  async function archive(tile: ProjectTile) {
    const files = tile.jobCount === 1 ? "1 file" : `${tile.jobCount} files`;
    const message = `"${tile.name}" leaves the project picker. Its ${files}, cards and chats are kept.`;
    if (!(await askConfirm({ title: "Archive project?", message, confirmLabel: "Archive" }))) return;
    const problem = await changeProject(tile.id, { archived: true });
    if (problem) await showMessage({ title: "Could not archive the project", message: problem });
    else onChanged();
    await load();
  }

  return (
    <main className="mx-auto w-full max-w-6xl px-8 pt-8 pb-16">
      <PageHeader title="Projects">
        <button type="button" onClick={() => setCreating(true)} disabled={!!error && !tiles} className={btn("primary")}>
          <Plus size={16} />
          Create project
        </button>
      </PageHeader>

      {/* MongoDB offline, or the backend is not running: the backend's message instead of tiles. */}
      {error && <Notice tone="danger">{error}</Notice>}
      {!tiles && !error && <Loading>Loading the projects...</Loading>}

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
      className={`relative overflow-hidden rounded-[14px] border bg-card transition-colors ${
        current ? "border-line-strong ring-3 ring-focus-ring" : "border-line hover:border-line-strong"
      }`}
    >
      <button
        type="button"
        onClick={onOpen}
        title={`Open "${tile.name}"`}
        className="block w-full cursor-pointer border-0 bg-transparent p-0 text-left"
      >
        <div className="flex aspect-video items-center justify-center bg-frame">
          {showCover ? (
            <img src={tile.cover!} alt="" className="h-full w-full object-cover" onError={() => setCoverFailed(true)} />
          ) : (
            <span className="text-4xl font-medium text-ink-3">{tile.name.charAt(0).toUpperCase()}</span>
          )}
        </div>
        <div className="px-4 pt-3 pb-4">
          <div className="flex items-center gap-2 pr-6">
            <span className="truncate text-sm font-medium text-ink">{tile.name}</span>
            {current && (
              <Badge tone="accent">Current</Badge>
            )}
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-2">
            <Count icon={<Image size={13} />} value={tile.jobCount} one="file" many="files" />
            <Count icon={<MessageSquare size={13} />} value={tile.chatCount} one="chat" many="chats" />
            <Count icon={<LayoutDashboard size={13} />} value={tile.cardCount} one="card" many="cards" />
          </div>
          <div className="mt-2 text-xs text-ink-3" title={new Date(tile.lastActivityAt).toLocaleString()}>
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
            className="flex cursor-pointer items-center rounded-lg border border-line bg-card p-1 text-ink-2 transition-colors hover:bg-hover hover:text-ink"
          >
            <MoreHorizontal size={16} />
          </button>
          {menuOpen && (
            <div className="absolute top-full right-0 z-20 mt-1 w-36 overflow-hidden rounded-xl border border-line bg-card py-1 shadow-float">
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
      className="flex w-full cursor-pointer items-center gap-2.5 border-0 bg-transparent px-3.5 py-2 text-left text-sm text-ink transition-colors hover:bg-hover"
    >
      <span className="text-ink-2">{icon}</span>
      {label}
    </button>
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
