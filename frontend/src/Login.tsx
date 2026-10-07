import { useState } from "react";
import type { FormEvent } from "react";

// The login form. Accounts are made on System 1 with "npm run user" (see backend/src/setUser.ts).
export default function Login({ onLoggedIn, notice }: { onLoggedIn: (username: string) => void; notice?: string }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      const body = await response.json().catch(() => null);
      if (!body) setError("Could not reach the backend. Make sure it is running, then try again.");
      else if (!response.ok) setError(body.error ?? "Logging in did not work. Please try again.");
      else onLoggedIn(body.username);
    } catch {
      setError("Could not reach the backend. Make sure it is running, then try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section style={{ maxWidth: 320 }}>
      <h2>Log in</h2>
      {notice && <p style={{ color: "red" }}>{notice}</p>}
      <form onSubmit={handleSubmit}>
        <label style={{ display: "block", marginBottom: 12 }}>
          <strong>Username</strong>
          <input
            value={username}
            onChange={(event) => setUsername(event.target.value)}
            autoComplete="username"
            autoFocus
            style={{ display: "block", width: "100%", marginTop: 4 }}
          />
        </label>
        <label style={{ display: "block", marginBottom: 12 }}>
          <strong>Password</strong>
          <input
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            autoComplete="current-password"
            style={{ display: "block", width: "100%", marginTop: 4 }}
          />
        </label>
        <button type="submit" disabled={busy || username === "" || password === ""}>
          {busy ? "Logging in..." : "Log in"}
        </button>
      </form>
      {error && <p style={{ color: "red" }}>{error}</p>}
    </section>
  );
}
