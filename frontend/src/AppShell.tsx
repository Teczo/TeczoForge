import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { ChevronDown, Folder, Image, LayoutDashboard, LogOut, Sparkles } from "lucide-react";
import type { Project } from "./App";
import Logo from "./Logo";
import RecentChats, { useRecentChats } from "./RecentChats";

// The frame around every page (FRG-46): the left sidebar, and a small status box at the top right.
// Built with Tailwind classes and lucide-react icons, after docs/design/teczoforge_redesign.tsx.

// What the page knows about each part.
export type Status = "checking" | "online" | "offline" | "unknown";

// The pages, by the name in the address (see currentPage() in App.tsx).
export type Page = "chat" | "generate" | "gallery" | "board" | "projects";

// The page links in the sidebar. Chat is not here: it is the home page, opened with "New chat" or a recent chat.
const NAV_ITEMS = [
  { page: "generate", href: "#/generate", label: "Generate", icon: Sparkles },
  { page: "gallery", href: "#/gallery", label: "Gallery", icon: Image },
  { page: "board", href: "#/board", label: "Board", icon: LayoutDashboard },
  { page: "projects", href: "#/projects", label: "Projects", icon: Folder },
] as const;

type AppShellProps = {
  page: Page;
  user: string;
  onLogOut: () => void;
  backend: Status;
  comfyui: Status;
  projects: Project[];
  project: Project | null | undefined;
  onChooseProject: (project: Project) => void;
  onCreatedProject: (project: Project) => void;
  conversationId: string | null; // The chat open on the Chat page (FRG-47).
  chatListVersion: number; // Goes up when the Chat page changed the chat list.
  children: ReactNode;
};

export default function AppShell(props: AppShellProps) {
  const projectId = props.project === undefined ? undefined : (props.project?.id ?? null);
  const chats = useRecentChats(projectId, props.chatListVersion);

  return (
    <div className="flex min-h-screen">
      <aside className="sticky top-0 flex h-screen w-72 shrink-0 flex-col border-r border-slate-700/50 bg-slate-800">
        {/* Top: logo */}
        <div className="flex h-16 shrink-0 items-center px-5 [&_.logo]:text-2xl [&_.logo_img]:h-8 [&_.logo-forge]:text-[26px]">
          <Logo />
        </div>

        {/* New chat: makes a chat in the current project and opens it (FRG-47). */}
        <div className="shrink-0 px-4 pb-4">
          <button
            type="button"
            onClick={chats.newChat}
            disabled={projectId === undefined}
            className="flex w-full cursor-pointer items-center justify-center gap-2 rounded-xl border-0 bg-teal-600/90 px-4 py-2.5 text-sm font-medium text-white shadow-sm shadow-teal-900/20 transition-colors duration-200 hover:bg-teal-500 disabled:cursor-wait disabled:opacity-60"
          >
            <Sparkles size={16} />
            New chat
          </button>
        </div>

        {/* Page links. The open page is highlighted. */}
        <nav className="mx-2 shrink-0 space-y-1 border-b border-slate-700/50 px-2 pb-4">
          {NAV_ITEMS.map((item) => {
            const active = props.page === item.page;
            const Icon = item.icon;
            return (
              <a
                key={item.page}
                href={item.href}
                aria-current={active ? "page" : undefined}
                className={`flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors duration-200 ${
                  active ? "bg-slate-700/50 text-teal-400" : "text-slate-400 hover:bg-slate-700/30 hover:text-slate-200"
                }`}
              >
                <Icon size={16} className={active ? "text-teal-400" : "text-slate-500"} />
                {item.label}
              </a>
            );
          })}
        </nav>

        {/* The current project (FRG-41), moved here from the old header. */}
        <div className="shrink-0 px-4 pt-4">
          <ProjectPicker
            projects={props.projects}
            project={props.project}
            onChoose={props.onChooseProject}
            onCreated={props.onCreatedProject}
          />
        </div>

        {/* Recent chats of the current project (FRG-47). Only this part scrolls. */}
        <div className="min-h-0 flex-1 overflow-y-auto px-2 pt-4 pb-4">
          <div className="px-3 pb-2 text-xs font-semibold uppercase tracking-wider text-slate-500">Recent</div>
          <RecentChats chats={chats} openId={props.conversationId} project={props.project} projects={props.projects} />
        </div>

        {/* Bottom: who is logged in, and "Log out". */}
        <UserMenu user={props.user} onLogOut={props.onLogOut} />
      </aside>

      {/* A plain block, like the page body was before: the pages center themselves with margin: 0 auto. */}
      <div className="min-w-0 flex-1">
        {/* Top right: is the backend and ComfyUI running? Same height as the old header, so the
            pages' sticky parts (they use --header-h in styles.css) still line up. */}
        <header className="sticky top-0 z-20 flex h-(--header-h) shrink-0 items-center justify-end bg-slate-900/90 px-6 backdrop-blur-sm">
          <div className="flex items-center gap-4 rounded-full border border-slate-700/50 bg-slate-800/50 px-4 py-1.5">
            <StatusLine label="Backend" status={props.backend} />
            <div className="h-3 w-px bg-slate-700" />
            <StatusLine label="ComfyUI" status={props.comfyui} />
          </div>
        </header>
        {props.children}
      </div>
    </div>
  );
}

const statusText: Record<Status, string> = {
  checking: "Checking...",
  online: "Online",
  offline: "Offline",
  unknown: "Unknown",
};

const dotColor: Record<Status, string> = {
  checking: "bg-slate-500",
  online: "bg-emerald-500",
  offline: "bg-red-500",
  unknown: "bg-slate-500",
};

const wordColor: Record<Status, string> = {
  checking: "text-slate-500",
  online: "text-emerald-500/90",
  offline: "text-red-400",
  unknown: "text-slate-500",
};

// A colored dot and a word, for example "Backend  Online".
function StatusLine({ label, status }: { label: string; status: Status }) {
  const title = status === "unknown" ? "Unknown, because the backend is offline" : undefined;
  return (
    <div className="flex items-center gap-2 whitespace-nowrap" title={title}>
      <span className={`inline-flex h-2 w-2 rounded-full ${dotColor[status]}`} />
      <span className="text-xs font-medium text-slate-400">
        {label} <span className={wordColor[status]}>{statusText[status]}</span>
      </span>
    </div>
  );
}

// Value of the last item in the picker. Not a project id, so it can never clash with one.
const NEW_PROJECT = "new";

type ProjectPickerProps = {
  projects: Project[];
  project: Project | null | undefined;
  onChoose: (project: Project) => void;
  onCreated: (project: Project) => void;
};

// The current project (FRG-41). New files go into it, and the gallery shows only its files.
// "+ New project" asks for a name and makes the project. Rename and archive are on the Projects page (FRG-50).
function ProjectPicker({ projects, project, onChoose, onCreated }: ProjectPickerProps) {
  const [creating, setCreating] = useState(false);

  async function createProject() {
    const name = window.prompt("Name of the new project (at most 60 characters):");
    if (name === null || name.trim() === "") return;
    setCreating(true);
    try {
      const response = await fetch("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      const body = await response.json().catch(() => null);
      if (!body) window.alert("Could not reach the backend. Make sure it is running, then try again.");
      else if (!response.ok) window.alert(body.error ?? "Could not make the project.");
      else onCreated(body);
    } catch {
      window.alert("Could not reach the backend. Make sure it is running, then try again.");
    } finally {
      setCreating(false);
    }
  }

  function onChange(value: string) {
    if (value === NEW_PROJECT) {
      createProject();
      return;
    }
    const chosen = projects.find((p) => p.id === value);
    if (chosen) onChoose(chosen);
  }

  const label = <div className="px-1 pb-1.5 text-xs font-semibold uppercase tracking-wider text-slate-500">Project</div>;

  if (project === null) {
    return (
      <div>
        {label}
        <div
          className="flex items-center gap-2 px-3 py-2 text-sm text-slate-500"
          title="Projects need MongoDB, which cannot be reached right now."
        >
          <Folder size={16} /> No projects
        </div>
      </div>
    );
  }

  return (
    <label className="block" title="Current project: new files go here, and the gallery shows its files">
      {label}
      <div className="relative">
        <Folder size={16} className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-slate-500" />
        <select
          aria-label="Project"
          value={project?.id ?? ""}
          onChange={(event) => onChange(event.target.value)}
          disabled={project === undefined || creating}
          className="w-full cursor-pointer appearance-none truncate rounded-lg border border-slate-700 bg-slate-900/60 py-2 pr-9 pl-9 text-sm text-slate-200 outline-none hover:border-slate-600 focus:border-teal-500/60 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {project === undefined && <option value="">Loading...</option>}
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
          {project !== undefined && <option value={NEW_PROJECT}>+ New project</option>}
        </select>
        <ChevronDown size={16} className="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 text-slate-500" />
      </div>
    </label>
  );
}

// The round letter and the name. A click opens a small menu with only "Log out".
function UserMenu({ user, onLogOut }: { user: string; onLogOut: () => void }) {
  const [open, setOpen] = useState(false);

  // Close the menu when the user clicks anywhere else.
  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    window.addEventListener("click", close);
    return () => window.removeEventListener("click", close);
  }, [open]);

  return (
    <div className="relative shrink-0 border-t border-slate-700/50 p-4">
      {open && (
        <div className="absolute right-4 bottom-full left-4 z-50 mb-2 rounded-xl border border-slate-600 bg-slate-700 py-2 shadow-2xl">
          <button
            onClick={onLogOut}
            className="flex w-full cursor-pointer items-center gap-3 border-0 bg-transparent px-4 py-2 text-left text-sm text-red-400 transition-colors hover:bg-slate-600 hover:text-red-300"
          >
            <LogOut size={16} />
            Log out
          </button>
        </div>
      )}
      <button
        onClick={(event) => {
          event.stopPropagation();
          setOpen(!open);
        }}
        aria-expanded={open}
        className={`flex w-full cursor-pointer items-center gap-3 rounded-xl border-0 p-2 text-left transition-colors duration-200 ${
          open ? "bg-slate-700" : "bg-transparent hover:bg-slate-700/50"
        }`}
      >
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-teal-600 bg-teal-700/80 text-sm font-semibold text-teal-100">
          {user.charAt(0).toUpperCase()}
        </span>
        <span className="truncate text-sm font-medium text-slate-200">{user}</span>
      </button>
    </div>
  );
}
