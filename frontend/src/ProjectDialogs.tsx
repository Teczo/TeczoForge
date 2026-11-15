import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import type { Project } from "./App";
import { Folder, X } from "lucide-react";
import { btn, FIELD, LABEL, Modal } from "./ui";

// Small tools to tidy up projects (FRG-43).
// - changeProject: rename or archive a project. Used by the Projects page (FRG-50), which replaced
//   the "Manage projects" dialog.
// - MoveToProject: pick the project to move one job or one chat to.
// - CreateProjectDialog: "Create project", used by the Projects page and the sidebar's project picker.
// Projects are never deleted. An archived project keeps its jobs; it only leaves the picker.

const NO_BACKEND = "Could not reach the backend. Make sure it is running, then try again.";

// The project that always exists (FRG-39). It cannot be renamed or archived.
export const UNSORTED_NAME = "Unsorted";

// The longest project name the backend accepts (backend/src/projects.ts).
export const MAX_NAME_LENGTH = 60;

// Change one project with PATCH /api/projects/<id>. Returns an error message, or null when it worked.
export async function changeProject(id: string, fields: { name?: string; archived?: boolean }): Promise<string | null> {
  try {
    const response = await fetch(`/api/projects/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(fields),
    });
    const body = await response.json().catch(() => null);
    if (!body) return NO_BACKEND;
    if (!response.ok) return body.error ?? "That did not work. Please try again.";
    return null;
  } catch {
    return NO_BACKEND;
  }
}

type MoveToProjectProps = {
  what: string; // What is moved, for the title, for example "this image" or the chat's title.
  projects: Project[];
  currentProjectId: string | undefined; // Not offered: the item is already there.
  // Move the item. Returns an error message, or null when it worked.
  onMove: (project: Project) => Promise<string | null>;
  onClose: () => void;
};

// "Move to project": a list of the other projects. A click moves the item there.
export function MoveToProject({ what, projects, currentProjectId, onMove, onClose }: MoveToProjectProps) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const targets = projects.filter((project) => project.id !== currentProjectId);

  async function move(project: Project) {
    setBusy(true);
    setError(null);
    const problem = await onMove(project);
    setBusy(false);
    if (problem) setError(problem);
    else onClose();
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal panel" onClick={(event) => event.stopPropagation()}>
        <div className="modal-head">
          <h2>Move {what} to project</h2>
          <button type="button" className="icon-button" onClick={onClose} title="Close">
            <X size={18} />
          </button>
        </div>
        {error && <p className="message error">{error}</p>}
        {targets.length === 0 ? (
          <p className="board-hint">There is no other project. Make one with "+ New project" in the project picker.</p>
        ) : (
          <div className="project-targets">
            {targets.map((project) => (
              <button key={project.id} type="button" className="button" onClick={() => move(project)} disabled={busy}>
                <Folder size={18} /> {project.name}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// "Create project": a small dialog with a name field. Shows the backend's error, for example a used name.
export function CreateProjectDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (project: Project) => void }) {
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  async function create(event: FormEvent) {
    event.preventDefault();
    if (name.trim() === "") return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      const body = await response.json().catch(() => null);
      if (!body) setError(NO_BACKEND);
      else if (!response.ok) setError(body.error ?? "Could not make the project.");
      else onCreated(body);
    } catch {
      setError(NO_BACKEND);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title="Create project" onClose={onClose}>
      <form onSubmit={create}>
        <label className="block">
          <span className={LABEL}>Name</span>
          <input
            ref={inputRef}
            value={name}
            onChange={(event) => setName(event.target.value)}
            maxLength={MAX_NAME_LENGTH}
            placeholder="For example: Summer campaign"
            className={`${FIELD} h-9`}
          />
        </label>
        {error && <p className="mt-3 mb-0 text-sm text-danger">{error}</p>}
        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className={btn("secondary")}
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={busy || name.trim() === ""}
            className={btn("primary")}
          >
            {busy ? "Creating..." : "Create"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
