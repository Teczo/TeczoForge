import { useEffect, useState } from "react";
import Generate from "./Generate";
import type { StartValues } from "./Generate";
import Gallery from "./Gallery";
import Login from "./Login";

// Which page to show comes from the address: #/gallery or the Generate page.
// Using the # part means a refresh or bookmark keeps the same page.
function currentPage() {
  return window.location.hash === "#/gallery" ? "gallery" : "generate";
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
  // Set by "Use again" in the gallery: the preset and values to fill into the Generate page.
  const [useAgain, setUseAgain] = useState<StartValues | null>(null);

  function handleUseAgain(values: StartValues) {
    setUseAgain(values);
    window.location.hash = "#/"; // Go to the Generate page.
  }

  // Switch page when the address changes (link click, back button).
  useEffect(() => {
    const onHashChange = () => setPage(currentPage());
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

  const mainStyle = { fontFamily: "system-ui, sans-serif", padding: 24 };

  if (user === undefined) {
    return (
      <main style={mainStyle}>
        <h1>TeczoForge</h1>
        <p>Loading...</p>
      </main>
    );
  }
  if (user === null) {
    return (
      <main style={mainStyle}>
        <h1>TeczoForge</h1>
        <Login onLoggedIn={setUser} notice={loginNotice} />
      </main>
    );
  }

  return (
    <main style={mainStyle}>
      <h1>TeczoForge</h1>
      <p>
        Logged in as <strong>{user}</strong> &middot; <button onClick={logOut}>Log out</button>
      </p>
      <nav style={{ display: "flex", gap: 16 }}>
        <a href="#/" style={{ fontWeight: page === "generate" ? "bold" : "normal" }}>Generate</a>
        <a href="#/gallery" style={{ fontWeight: page === "gallery" ? "bold" : "normal" }}>Gallery</a>
      </nav>
      <h2>System status</h2>
      <StatusLine label="Backend" status={backend} />
      <StatusLine label="ComfyUI" status={comfyui} />
      {page === "gallery" ? (
        <Gallery onUseAgain={handleUseAgain} />
      ) : (
        <Generate startValues={useAgain} onStartValuesUsed={() => setUseAgain(null)} />
      )}
    </main>
  );
}

const statusText: Record<Status, string> = {
  checking: "Checking...",
  online: "Online",
  offline: "Offline",
  unknown: "Unknown (backend is offline)",
};

const statusColor: Record<Status, string> = {
  checking: "gray",
  online: "green",
  offline: "red",
  unknown: "gray",
};

function StatusLine({ label, status }: { label: string; status: Status }) {
  return (
    <p>
      <strong>{label}:</strong>{" "}
      <span style={{ color: statusColor[status] }}>{statusText[status]}</span>
    </p>
  );
}
