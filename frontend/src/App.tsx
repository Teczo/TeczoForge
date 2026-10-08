import { useEffect, useState } from "react";
import Generate from "./Generate";
import type { StartValues } from "./Generate";
import Gallery from "./Gallery";
import Board from "./Board";
import Login from "./Login";
import Logo from "./Logo";
import { ChevronDownIcon, ImageIcon, LayersIcon, LogoutIcon, SparklesIcon } from "./Icons";

// Which page to show comes from the address: #/board, #/gallery (or #/gallery/<job id> to open
// one job), or the Generate page. Using the # part means a refresh or bookmark keeps the same page.
function currentPage() {
  const hash = window.location.hash;
  if (hash === "#/board") return "board";
  if (hash === "#/gallery" || hash.startsWith("#/gallery/")) return "gallery";
  return "generate";
}

// The job id in #/gallery/<job id>, or null.
function galleryJobId(): string | null {
  return window.location.hash.match(/^#\/gallery\/(.+)$/)?.[1] ?? null;
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
  // Set by "Use again" in the gallery: the preset and values to fill into the Generate page.
  const [useAgain, setUseAgain] = useState<StartValues | null>(null);

  function handleUseAgain(values: StartValues) {
    setUseAgain(values);
    window.location.hash = "#/"; // Go to the Generate page.
  }

  // Switch page when the address changes (link click, back button).
  useEffect(() => {
    const onHashChange = () => {
      setPage(currentPage());
      setOpenJobId(galleryJobId());
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
        </nav>
        <div className="status-list">
          <StatusLine label="Backend" status={backend} />
          <StatusLine label="ComfyUI" status={comfyui} />
        </div>
        <UserMenu user={user} onLogOut={logOut} />
      </header>
      {page === "board" ? (
        <Board />
      ) : page === "gallery" ? (
        <Gallery onUseAgain={handleUseAgain} openJobId={openJobId} />
      ) : (
        <Generate startValues={useAgain} onStartValuesUsed={() => setUseAgain(null)} />
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
