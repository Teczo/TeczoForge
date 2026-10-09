import { useEffect, useState } from "react";
import Generate from "./Generate";
import type { StartValues } from "./Generate";
import Gallery from "./Gallery";
import Board from "./Board";
import Chat from "./Chat";
import type { Attachment } from "./Chat";
import Login from "./Login";
import Logo from "./Logo";
import { ChatIcon, ChevronDownIcon, ImageIcon, LayersIcon, LogoutIcon, SparklesIcon } from "./Icons";

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
        <div className="status-list">
          <StatusLine label="Backend" status={backend} />
          <StatusLine label="ComfyUI" status={comfyui} />
        </div>
        <UserMenu user={user} onLogOut={logOut} />
      </header>
      {page === "board" ? (
        <Board />
      ) : page === "chat" ? (
        <Chat
          conversationId={conversationId}
          pendingAttachment={chatAttachment}
          onPendingAttachmentUsed={() => setChatAttachment(null)}
        />
      ) : page === "gallery" ? (
        <Gallery onUseAgain={handleUseAgain} onUseInChat={handleUseInChat} openJobId={openJobId} />
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
