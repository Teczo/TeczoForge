import { useState } from "react";
import type { Project } from "./App";
import { CloseIcon, FolderIcon } from "./Icons";

// Small tools to tidy up projects (FRG-43).
// - changeProject: rename or archive a project. Used by the Projects page (FRG-50), which replaced
//   the "Manage projects" dialog.
// - MoveToProject: pick the project to move one job or one chat to.
// Projects are never deleted. An archived project keeps its jobs; it only leaves the picker.

const NO_BACKEND = "Could not reach the backend. Make sure it is running, then try again.";

// The project that always exists (FRG-39). It cannot be renamed or archived.
export const UNSORTED_NAME = "Unsorted";

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
            <CloseIcon size={18} />
          </button>
        </div>
        {error && <p className="message error">{error}</p>}
        {targets.length === 0 ? (
          <p className="board-hint">There is no other project. Make one with "+ New project" in the project picker.</p>
        ) : (
          <div className="project-targets">
            {targets.map((project) => (
              <button key={project.id} type="button" className="button" onClick={() => move(project)} disabled={busy}>
                <FolderIcon size={18} /> {project.name}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
