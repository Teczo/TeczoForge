import { useEffect, useRef, useState } from "react";
import Generate from "./Generate";
import type { StartValues } from "./Generate";
import Gallery from "./Gallery";
import Board from "./Board";
import Chat from "./Chat";
import type { Attachment } from "./Chat";
import Login from "./Login";
import AppShell from "./AppShell";
import type { Page, Status } from "./AppShell";
import { ManageProjects } from "./ProjectDialogs";

// Which page to show comes from the address: #/generate, #/board, #/projects,
// #/gallery (or #/gallery/<job id> to open one job), or the Chat page, which is the home page:
// #/, #/chat, or #/chat/<conversation id> (FRG-46).
// Using the # part means a refresh or bookmark keeps the same page.
function currentPage(): Page {
  const hash = window.location.hash;
  if (hash === "#/generate") return "generate";
  if (hash === "#/board") return "board";
  if (hash === "#/projects") return "projects";
  if (hash === "#/gallery" || hash.startsWith("#/gallery/")) return "gallery";
  return "chat";
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
  // "Manage projects" is open (FRG-43).
  const [managing, setManaging] = useState(false);
  // A project asked for by a link before the projects were loaded (FRG-42). It wins over the remembered one.
  const wantedProjectRef = useRef<string | null>(null);
  // Set by "Use again" in the gallery: the preset and values to fill into the Generate page.
  const [useAgain, setUseAgain] = useState<StartValues | null>(null);

  function handleUseAgain(values: StartValues) {
    setUseAgain(values);
    window.location.hash = "#/generate"; // Go to the Generate page.
  }

  // Goes up when the Chat page changed the chat list, so the sidebar loads it again (FRG-47).
  const [chatListVersion, setChatListVersion] = useState(0);

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

  // A project was renamed or archived in "Manage projects" (FRG-43): load the list again.
  // The current project keeps its new name. If it was archived, "Unsorted" is chosen.
  async function reloadProjects() {
    try {
      const response = await fetch("/api/projects");
      if (!response.ok) return;
      const list: Project[] = (await response.json()).projects;
      setProjects(list);
      const current = list.find((p) => p.id === project?.id) ?? list.find((p) => p.name === UNSORTED_NAME);
      if (current) chooseProject(current);
    } catch {
      // The backend is not answering. The picker keeps the list it has.
    }
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
    <AppShell
      page={page}
      user={user}
      onLogOut={logOut}
      backend={backend}
      comfyui={comfyui}
      projects={projects}
      project={project}
      onChooseProject={chooseProject}
      onCreatedProject={addProject}
      onManageProjects={() => setManaging(true)}
      conversationId={page === "chat" ? conversationId : null}
      chatListVersion={chatListVersion}
    >
      {page === "board" ? (
        <Board onOpenInGenerate={handleUseAgain} project={project} />
      ) : page === "chat" ? (
        <Chat
          conversationId={conversationId}
          pendingAttachment={chatAttachment}
          onPendingAttachmentUsed={() => setChatAttachment(null)}
          onOpenInGenerate={handleUseAgain}
          project={project}
          onListChanged={() => setChatListVersion((v) => v + 1)}
          onShowProject={showProjectOf}
        />
      ) : page === "gallery" ? (
        <Gallery
          onUseAgain={handleUseAgain}
          onUseInChat={handleUseInChat}
          openJobId={openJobId}
          project={project}
          projects={projects}
          onShowProject={showProjectOf}
        />
      ) : page === "projects" ? (
        <ProjectsPlaceholder />
      ) : (
        <Generate startValues={useAgain} onStartValuesUsed={() => setUseAgain(null)} project={project} />
      )}
      {managing && <ManageProjects onClose={() => setManaging(false)} onChanged={reloadProjects} />}
    </AppShell>
  );
}

// The Projects page is built in FRG-50. Until then, projects are managed from the picker in the sidebar.
function ProjectsPlaceholder() {
  return (
    <div className="flex min-h-[calc(100vh-var(--header-h))] flex-col items-center justify-center px-6 pb-16 text-center text-slate-500">
      <span className="text-lg font-medium text-slate-300">Projects</span>
      <span className="mt-2 text-sm">This page is coming soon. For now, use "Manage projects..." in the project picker.</span>
    </div>
  );
}
