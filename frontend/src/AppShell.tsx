import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { ChevronDown, Folder, Gamepad2, Image, Languages, LayoutDashboard, LogOut, MessageSquare, Moon, Package, PanelLeft, Plus, Sparkles, Sun, UserRound } from "lucide-react";
import type { Project } from "./App";
import Logo from "./Logo";
import { CreateProjectDialog } from "./ProjectDialogs";
import RecentChats, { useRecentChats } from "./RecentChats";
import { useTheme } from "./theme";
import type { Theme } from "./theme";
import { btn, ICON, ICON_BUTTON } from "./ui";

// The frame around every page (FRG-46): the left sidebar and the thin top bar.
// Built with Tailwind classes and lucide-react icons. Colours come from theme.css.

// What the page knows about each part.
export type Status = "checking" | "online" | "offline" | "unknown";

// The pages, by the name in the address (see currentPage() in App.tsx).
export type Page = "chat" | "generate" | "avatar" | "gallery" | "board" | "projects" | "games" | "packs" | "translate";

// The page links in the sidebar. Chat is the home page: it is also opened with "New chat" or a recent chat.
export const NAV_ITEMS = [
  { page: "chat", href: "#/chat", label: "Chat", icon: MessageSquare },
  { page: "generate", href: "#/generate", label: "Generate", icon: Sparkles },
  { page: "avatar", href: "#/avatar", label: "Avatar", icon: UserRound }, // The Generate page, on the Avatar category (FRG-86).
  { page: "gallery", href: "#/gallery", label: "Gallery", icon: Image },
  { page: "board", href: "#/board", label: "Board", icon: LayoutDashboard },
  { page: "projects", href: "#/projects", label: "Projects", icon: Folder },
  { page: "games", href: "#/games", label: "Games", icon: Gamepad2 }, // FRG-67
  { page: "packs", href: "#/packs", label: "Packs", icon: Package }, // FRG-78
  { page: "translate", href: "#/translate", label: "Translate", icon: Languages }, // FRG-92
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

// Is the sidebar closed? Remembered in this browser only.
const SIDEBAR_KEY = "teczoforge.sidebarClosed";

function readSidebarClosed(): boolean {
  try {
    return localStorage.getItem(SIDEBAR_KEY) === "1";
  } catch {
    return false; // No storage (for example a private window): the sidebar starts open.
  }
}

// The small grey label above a group in the sidebar.
const GROUP_LABEL = "px-3 pb-1.5 text-xs text-ink-3";

export default function AppShell(props: AppShellProps) {
  const projectId = props.project === undefined ? undefined : (props.project?.id ?? null);
  const chats = useRecentChats(projectId, props.chatListVersion);
  const [theme, toggleTheme] = useTheme();
  const [closed, setClosed] = useState(readSidebarClosed);

  function toggleSidebar() {
    const next = !closed;
    setClosed(next);
    try {
      localStorage.setItem(SIDEBAR_KEY, next ? "1" : "0");
    } catch {
      // No storage: the choice is kept until the page is refreshed.
    }
  }

  const title = NAV_ITEMS.find((item) => item.page === props.page)?.label ?? "";

  return (
    <div className="flex min-h-screen bg-page text-sm text-ink">
      {!closed && (
        <aside className="sticky top-0 flex h-screen w-60 shrink-0 flex-col border-r border-line bg-sidebar">
          {/* Top: logo */}
          <div className="flex h-(--header-h) shrink-0 items-center px-4 [&_.logo]:text-xl [&_.logo_img]:h-6">
            <Logo />
          </div>

          {/* New chat: makes a chat in the current project and opens it (FRG-47). */}
          <div className="shrink-0 px-3 pt-1 pb-3">
            <button type="button" onClick={chats.newChat} disabled={projectId === undefined} className={`${btn("secondary", "sm")} w-full disabled:cursor-wait`}>
              <Plus {...ICON} />
              New chat
            </button>
          </div>

          {/* Page links. The open page has a light grey fill. */}
          <nav className="shrink-0 space-y-0.5 px-3 pb-4">
            {NAV_ITEMS.map((item) => {
              const active = props.page === item.page;
              const Icon = item.icon;
              return (
                <a
                  key={item.page}
                  href={item.href}
                  aria-current={active ? "page" : undefined}
                  className={`group flex h-8 w-full items-center gap-2.5 rounded-lg px-3 text-sm no-underline transition-colors ${
                    active ? "bg-hover font-medium text-ink" : "text-ink-2 hover:bg-hover hover:text-ink"
                  }`}
                >
                  <Icon {...ICON} className={active ? "text-ink" : "text-ink-3 group-hover:text-ink"} />
                  {item.label}
                </a>
              );
            })}
          </nav>

          {/* The current project (FRG-41). */}
          <div className="shrink-0 px-3">
            <ProjectPicker projects={props.projects} project={props.project} onChoose={props.onChooseProject} onCreated={props.onCreatedProject} />
          </div>

          {/* Recent chats of the current project (FRG-47). Only this part scrolls. */}
          <div className="min-h-0 flex-1 overflow-y-auto px-3 pt-5 pb-3">
            <div className={GROUP_LABEL}>Recent</div>
            <RecentChats chats={chats} openId={props.conversationId} project={props.project} projects={props.projects} />
          </div>

          {/* Bottom: who is logged in, the theme toggle, and "Log out". */}
          <UserMenu user={props.user} onLogOut={props.onLogOut} theme={theme} onToggleTheme={toggleTheme} />
        </aside>
      )}

      {/* A plain block: the pages center themselves with margin: 0 auto. */}
      <div className="min-w-0 flex-1">
        {/* The top bar: the page title on the left, the system status on the right.
            Pages use its height (--header-h in theme.css) for their sticky parts. */}
        <header className="sticky top-0 z-20 flex h-(--header-h) shrink-0 items-center gap-2 border-b border-line bg-page px-4">
          <button
            type="button"
            onClick={toggleSidebar}
            title={closed ? "Show the sidebar" : "Hide the sidebar"}
            aria-label={closed ? "Show the sidebar" : "Hide the sidebar"}
            aria-expanded={!closed}
            className={ICON_BUTTON}
          >
            <PanelLeft {...ICON} />
          </button>
          <span className="text-sm font-medium text-ink">{title}</span>
          <div className="ml-auto flex items-center gap-2">
            <StatusPill label="Backend" status={props.backend} />
            <StatusPill label="ComfyUI" status={props.comfyui} />
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
  checking: "bg-ink-3",
  online: "bg-success",
  offline: "bg-danger",
  unknown: "bg-ink-3",
};

const wordColor: Record<Status, string> = {
  checking: "text-ink-3",
  online: "text-ink-2",
  offline: "text-danger",
  unknown: "text-ink-3",
};

// A small outlined pill: a colored dot and a word, for example "Backend  Online".
function StatusPill({ label, status }: { label: string; status: Status }) {
  const title = status === "unknown" ? "Unknown, because the backend is offline" : undefined;
  return (
    <div className="flex h-7 items-center gap-2 rounded-full border border-line bg-card px-3 whitespace-nowrap" title={title}>
      <span className={`inline-flex h-1.5 w-1.5 rounded-full ${dotColor[status]}`} />
      <span className="text-xs font-medium text-ink">
        {label} <span className={`font-normal ${wordColor[status]}`}>{statusText[status]}</span>
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

  function onChange(value: string) {
    if (value === NEW_PROJECT) {
      setCreating(true);
      return;
    }
    const chosen = projects.find((p) => p.id === value);
    if (chosen) onChoose(chosen);
  }

  const label = <div className={GROUP_LABEL}>Project</div>;

  if (project === null) {
    return (
      <div>
        {label}
        <div
          className="flex items-center gap-2 px-3 py-2 text-sm text-ink-3"
          title="Projects need MongoDB, which cannot be reached right now."
        >
          <Folder {...ICON} /> No projects
        </div>
      </div>
    );
  }

  return (
    <>
      <label className="block" title="Current project: new files go here, and the gallery shows its files">
        {label}
        <div className="relative">
          <Folder {...ICON} className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-ink-3" />
          <select
            aria-label="Project"
            value={project?.id ?? ""}
            onChange={(event) => onChange(event.target.value)}
            disabled={project === undefined || creating}
            className="h-8 w-full cursor-pointer appearance-none truncate rounded-lg border border-line bg-card pr-8 pl-9 text-sm text-ink outline-none hover:border-line-strong focus:border-accent focus:ring-3 focus:ring-focus-ring disabled:cursor-not-allowed disabled:opacity-60"
          >
            {project === undefined && <option value="">Loading...</option>}
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
            {project !== undefined && <option value={NEW_PROJECT}>+ New project</option>}
          </select>
          <ChevronDown {...ICON} className="pointer-events-none absolute top-1/2 right-2.5 -translate-y-1/2 text-ink-3" />
        </div>
      </label>
      {/* "+ New project": the same dialog as on the Projects page. The new project becomes the current one. */}
      {creating && (
        <CreateProjectDialog
          onClose={() => setCreating(false)}
          onCreated={(created) => {
            setCreating(false);
            onCreated(created);
          }}
        />
      )}
    </>
  );
}

// The round letter and the name, with a small theme button next to it.
// A click on the name opens a menu: the theme toggle and "Log out".
function UserMenu({ user, onLogOut, theme, onToggleTheme }: { user: string; onLogOut: () => void; theme: Theme; onToggleTheme: () => void }) {
  const [open, setOpen] = useState(false);

  // Close the menu when the user clicks anywhere else.
  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    window.addEventListener("click", close);
    return () => window.removeEventListener("click", close);
  }, [open]);

  const themeLabel = theme === "dark" ? "Light mode" : "Dark mode";
  const ThemeIcon = theme === "dark" ? Sun : Moon;
  const menuItem = "flex w-full cursor-pointer items-center gap-2.5 border-0 bg-transparent px-3 py-2 text-left text-sm transition-colors hover:bg-hover";

  return (
    <div className="relative flex shrink-0 items-center gap-1 border-t border-line p-2">
      {open && (
        <div className="absolute right-2 bottom-full left-2 z-50 mb-1 overflow-hidden rounded-xl border border-line bg-card py-1 shadow-float">
          <button type="button" onClick={onToggleTheme} className={`${menuItem} text-ink`}>
            <ThemeIcon {...ICON} className="text-ink-2" />
            {themeLabel}
          </button>
          <button type="button" onClick={onLogOut} className={`${menuItem} text-danger`}>
            <LogOut {...ICON} />
            Log out
          </button>
        </div>
      )}
      <button
        type="button"
        onClick={(event) => {
          event.stopPropagation();
          setOpen(!open);
        }}
        aria-expanded={open}
        className={`flex min-w-0 flex-1 cursor-pointer items-center gap-2.5 rounded-lg border-0 p-1.5 text-left transition-colors ${
          open ? "bg-hover" : "bg-transparent hover:bg-hover"
        }`}
      >
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary text-xs font-medium text-on-primary">
          {user.charAt(0).toUpperCase()}
        </span>
        <span className="truncate text-sm font-medium text-ink">{user}</span>
      </button>
      <button type="button" onClick={onToggleTheme} title={`Switch to ${themeLabel.toLowerCase()}`} aria-label={`Switch to ${themeLabel.toLowerCase()}`} className={ICON_BUTTON}>
        <ThemeIcon {...ICON} />
      </button>
    </div>
  );
}
