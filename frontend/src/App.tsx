import { useEffect, useRef, useState } from "react";
import Generate from "./Generate";
import type { StartValues } from "./Generate";
import Gallery from "./Gallery";
import Board from "./Board";
import Chat from "./Chat";
import type { Attachment } from "./Chat";
import Login from "./Login";
import Logo from "./Logo";
import { ChatIcon, ChevronDownIcon, FolderIcon, ImageIcon, LayersIcon, LogoutIcon, SparklesIcon } from "./Icons";

// Which page to show comes from the address: #/board, #/chat (or #/chat/<conversation id>),
// #/gallery (or #/gallery/<job id> to open one job), or the Generate page.
// Using the # part means a refresh or bookmark keeps the same page.
function currentPage() {
  const hash = window.location.hash;
  if (hash === "#/board") return "board";
  if (hash === "#/chat" || hash.startsWith("#/chat/")) return "chat";
  if (hash === "#/gallery" || hash.startsWith("#/gallery/")) return "gallery";
  return "generate";
}

// The conversation id in #/chat/<id>, or null.
function chatConversationId(): string | null {
  return window.location.hash.match(/^#\/chat\/(.+)$/)?.[1] ?? null;
}

// The job id in #/gallery/<job id>, or null.
function galleryJobId(): string | null {
  return window.location.hash.match(/^#\/gallery\/(.+)$/)?.[1] ?? null;
}

// One project, as GET /api/projects returns it (see backend/src/projects.ts). Only the parts the page uses.
export type Project = { id: string; name: string };

// The project that always exists (FRG-39). New files go here when nothing else is chosen.
const UNSORTED_NAME = "Unsorted";

// The chosen project is remembered in this browser only (FRG-41).
const PROJECT_KEY = "teczoforge.project";

function readStoredProject(): string | null {
  try {
    return localStorage.getItem(PROJECT_KEY);
  } catch {
    return null; // No storage (for example a private window). Then "Unsorted" is used.
  }
}

function storeProject(id: string) {
  try {
    localStorage.setItem(PROJECT_KEY, id);
  } catch {
    // No storage: the choice is kept until the page is refreshed.
  }
}

// What the page knows about each part.
type Status = "checking" | "online" | "offline" | "unknown";

// The shape of the answer from GET /api/health (see backend/src/server.ts).
type HealthResponse = {
  backend: string;
  comfyui: { reachable: boolean };
};

export default function App() {
  // Who is logged in: undefined while checking, null when nobody is.
  const [user, setUser] = useState<string | null | undefined>(undefined);
  const [loginNotice, setLoginNotice] = useState<string | undefined>(undefined);
  const [backend, setBackend] = useState<Status>("checking");
  const [comfyui, setComfyui] = useState<Status>("checking");
  const [page, setPage] = useState(currentPage);
  const [openJobId, setOpenJobId] = useState(galleryJobId);
  const [conversationId, setConversationId] = useState(chatConversationId);
  // The projects for the picker, and the current one (FRG-41). project is undefined while loading,
  // and null if the projects could not be loaded (MongoDB offline): then pages work without a project.
  const [projects, setProjects] = useState<Project[]>([]);
  const [project, setProject] = useState<Project | null | undefined>(undefined);
  // A project asked for by a link before the projects were loaded (FRG-42). It wins over the remembered one.
  const wantedProjectRef = useRef<string | null>(null);
  // Set by "Use again" in the gallery: the preset and values to fill into the Generate page.
  const [useAgain, setUseAgain] = useState<StartValues | null>(null);

  function handleUseAgain(values: StartValues) {
    setUseAgain(values);
    window.location.hash = "#/"; // Go to the Generate page.
  }

  // Set by "Use in chat" in the gallery: a picture to attach in the chat (FRG-25).
  const [chatAttachment, setChatAttachment] = useState<Attachment | null>(null);

  // The last chat that was open, so "Use in chat" goes back to it. Only kept in this browser.
  useEffect(() => {
    if (!conversationId) return;
    try {
      localStorage.setItem("teczoforge.lastChat", conversationId);
    } catch {
      // No storage (for example a private window). Then "Use in chat" opens the chat page.
    }
  }, [conversationId]);

  function handleUseInChat(attachment: Attachment) {
    setChatAttachment(attachment);
    let last: string | null = null;
    try {
      last = localStorage.getItem("teczoforge.lastChat");
    } catch {
      // No storage: open the chat page without a conversation.
    }
    window.location.hash = last ? `#/chat/${last}` : "#/chat";
  }

  // Switch page when the address changes (link click, back button).
  useEffect(() => {
    const onHashChange = () => {
      setPage(currentPage());
      setOpenJobId(galleryJobId());
      setConversationId(chatConversationId());
    };
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  // First ask who is logged in. 401 means nobody: show the login form.
  useEffect(() => {
    async function checkLogin() {
      try {
        const response = await fetch("/api/me");
        if (response.ok) {
          setUser((await response.json()).username);
        } else {
          setUser(null);
          if (response.status !== 401) setLoginNotice("Could not reach the backend. Make sure it is running, then refresh.");
        }
      } catch {
        setUser(null);
        setLoginNotice("Could not reach the backend. Make sure it is running, then refresh.");
      }
    }
    checkLogin();
  }, []);

  async function logOut() {
    await fetch("/api/logout", { method: "POST" }).catch(() => {});
    window.location.reload(); // Start again from the login form.
  }

  // Ask the backend about the system once, after logging in.
  useEffect(() => {
    if (!user) return;
    async function checkHealth() {
      try {
        const response = await fetch("/api/health");
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const health: HealthResponse = await response.json();
        setBackend("online");
        setComfyui(health.comfyui.reachable ? "online" : "offline");
      } catch {
        // No answer from the backend, so we cannot know about ComfyUI either.
        setBackend("offline");
        setComfyui("unknown");
      }
    }
    checkHealth();
  }, [user]);

  // Load the projects once, after logging in. Pick the remembered project, or "Unsorted" if
  // nothing is remembered or that project is gone (archived).
  useEffect(() => {
    if (!user) return;
    async function loadProjects() {
      try {
        const response = await fetch("/api/projects");
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const list: Project[] = (await response.json()).projects;
        const stored = readStoredProject();
        const chosen =
          list.find((p) => p.id === wantedProjectRef.current) ??
          list.find((p) => p.id === stored) ??
          list.find((p) => p.name === UNSORTED_NAME) ??
          null;
        setProjects(list);
        setProject(chosen);
        if (chosen) storeProject(chosen.id);
      } catch {
        setProject(null);
      }
    }
    loadProjects();
  }, [user]);

  function chooseProject(chosen: Project) {
    setProject(chosen);
    storeProject(chosen.id);
  }

  // A link opened a chat or a job of another project (FRG-42): switch the picker to that project.
  // An archived project is not in the picker: then the item still opens, and the picker stays.
  function showProjectOf(projectId: string | undefined) {
    if (!projectId) return;
    if (project === undefined) {
      wantedProjectRef.current = projectId; // The projects are still loading.
      return;
    }
    const found = projects.find((p) => p.id === projectId);
    if (found && found.id !== project?.id) chooseProject(found);
  }

  // "+ New project": add it to the list (sorted by name, like the backend) and choose it.
  function addProject(created: Project) {
    setProjects((list) => [...list, created].sort((a, b) => a.name.localeCompare(b.name, "en", { sensitivity: "base" })));
    chooseProject(created);
  }

  if (user === undefined) {
    return <div className="loading-page">Loading...</div>;
  }
  if (user === null) {
    return <Login onLoggedIn={setUser} notice={loginNotice} />;
  }

  return (
    <>
      <header className="header">
        <Logo />
        <nav className="nav">
          <a href="#/" className={page === "generate" ? "active" : ""}>
            <SparklesIcon size={22} /> <span>Generate</span>
          </a>
          <a href="#/gallery" className={page === "gallery" ? "active" : ""}>
            <ImageIcon size={22} /> <span>Gallery</span>
          </a>
          <a href="#/board" className={page === "board" ? "active" : ""}>
            <LayersIcon size={22} /> <span>Board</span>
          </a>
          <a href="#/chat" className={page === "chat" ? "active" : ""}>
            <ChatIcon size={22} /> <span>Chat</span>
          </a>
        </nav>
        <ProjectPicker projects={projects} project={project} onChoose={chooseProject} onCreated={addProject} />
        <div className="status-list">
          <StatusLine label="Backend" status={backend} />
          <StatusLine label="ComfyUI" status={comfyui} />
        </div>
        <UserMenu user={user} onLogOut={logOut} />
      </header>
      {page === "board" ? (
        <Board onOpenInGenerate={handleUseAgain} project={project} />
      ) : page === "chat" ? (
        <Chat
          conversationId={conversationId}
          pendingAttachment={chatAttachment}
          onPendingAttachmentUsed={() => setChatAttachment(null)}
          onOpenInGenerate={handleUseAgain}
          project={project}
          onShowProject={showProjectOf}
        />
      ) : page === "gallery" ? (
        <Gallery
          onUseAgain={handleUseAgain}
          onUseInChat={handleUseInChat}
          openJobId={openJobId}
          project={project}
          onShowProject={showProjectOf}
        />
      ) : (
        <Generate startValues={useAgain} onStartValuesUsed={() => setUseAgain(null)} project={project} />
      )}
    </>
  );
}

const statusText: Record<Status, string> = {
  checking: "Checking...",
  online: "Online",
  offline: "Offline",
  unknown: "Unknown",
};

// A colored dot and a word, for example "Backend  Online". The color comes from styles.css.
function StatusLine({ label, status }: { label: string; status: Status }) {
  const title = status === "unknown" ? "Unknown, because the backend is offline" : undefined;
  return (
    <span className={`status status-${status}`} title={title}>
      <span className="status-dot" />
      {label} <span className="status-word">{statusText[status]}</span>
    </span>
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

// The current project, in the header (FRG-41). New files go into it, and the gallery shows only its files.
// The last item, "+ New project", asks for a name and makes the project.
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

  if (project === null) {
    return (
      <span className="project-picker project-offline" title="Projects need MongoDB, which cannot be reached right now.">
        <FolderIcon size={18} /> <span>No projects</span>
      </span>
    );
  }

  return (
    <label className="project-picker select-wrap" title="Current project: new files go here, and the gallery shows its files">
      <FolderIcon size={18} />
      <select
        className="select"
        aria-label="Project"
        value={project?.id ?? ""}
        onChange={(event) => onChange(event.target.value)}
        disabled={project === undefined || creating}
      >
        {project === undefined && <option value="">Loading...</option>}
        {projects.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
        {project !== undefined && <option value={NEW_PROJECT}>+ New project</option>}
      </select>
      <ChevronDownIcon size={18} />
    </label>
  );
}

// The round letter, the name, and a small menu with "Log out".
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
    <div className="user-menu">
      <button
        className="user-button"
        onClick={(event) => {
          event.stopPropagation();
          setOpen(!open);
        }}
        aria-expanded={open}
      >
        <span className="avatar">{user.charAt(0).toUpperCase()}</span>
        <span className="user-name">{user}</span>
        <ChevronDownIcon size={18} />
      </button>
      {open && (
        <div className="user-dropdown">
          <p>
            Logged in as <strong>{user}</strong>
          </p>
          <button onClick={onLogOut}>
            <LogoutIcon size={18} /> Log out
          </button>
        </div>
      )}
    </div>
  );
}
