import { useEffect, useState } from "react";

// What the page knows about each part.
type Status = "checking" | "online" | "offline" | "unknown";

// The shape of the answer from GET /api/health (see backend/src/server.ts).
type HealthResponse = {
  backend: string;
  comfyui: { reachable: boolean };
};

export default function App() {
  const [backend, setBackend] = useState<Status>("checking");
  const [comfyui, setComfyui] = useState<Status>("checking");

  // Ask the backend once, when the page loads.
  useEffect(() => {
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
  }, []);

  return (
    <main style={{ fontFamily: "system-ui, sans-serif", padding: 24 }}>
      <h1>TeczoForge</h1>
      <h2>System status</h2>
      <StatusLine label="Backend" status={backend} />
      <StatusLine label="ComfyUI" status={comfyui} />
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
