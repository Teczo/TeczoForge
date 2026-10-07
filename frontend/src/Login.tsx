import { useState } from "react";
import type { FormEvent } from "react";
import Logo from "./Logo";

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
    <main className="login-page">
      <section className="login-card panel">
        <Logo />
        <p>Log in to start creating.</p>
        {notice && <p className="message error">{notice}</p>}
        <form onSubmit={handleSubmit}>
          <label>
            <span className="field-label">Username</span>
            <input
              className="input"
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              autoComplete="username"
              autoFocus
            />
          </label>
          <label>
            <span className="field-label">Password</span>
            <input
              className="input"
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete="current-password"
            />
          </label>
          {error && <p className="message error">{error}</p>}
          <button className="button primary" type="submit" disabled={busy || username === "" || password === ""}>
            {busy ? "Logging in..." : "Log in"}
          </button>
        </form>
      </section>
    </main>
  );
}
