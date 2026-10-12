import { useEffect, useState } from "react";
import type { Project } from "./App";
import { CloseIcon, FolderIcon } from "./Icons";

// Small tools to tidy up projects (FRG-43).
// - ManageProjects: rename and archive projects, with the number of jobs in each.
// - MoveToProject: pick the project to move one job or one chat to.
// Projects are never deleted. An archived project keeps its jobs; it only leaves the picker.

const NO_BACKEND = "Could not reach the backend. Make sure it is running, then try again.";

// The project that always exists (FRG-39). It cannot be renamed or archived.
const UNSORTED_NAME = "Unsorted";

// A project with its number of jobs, from GET /api/projects?counts=1.
type ProjectWithCount = Project & { jobCount: number };

// Change one project with PATCH /api/projects/<id>. Returns an error message, or null when it worked.
async function changeProject(id: string, fields: { name?: string; archived?: boolean }): Promise<string | null> {
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

type ManageProjectsProps = {
  onClose: () => void;
  // A project was renamed or archived: the header loads the projects again.
  onChanged: () => void;
};

// "Manage projects", opened from the project picker.
export function ManageProjects({ onClose, onChanged }: ManageProjectsProps) {
  const [projects, setProjects] = useState<ProjectWithCount[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function load() {
    try {
      const response = await fetch("/api/projects?counts=1");
      const body = await response.json().catch(() => null);
      if (!body) setError(NO_BACKEND);
      else if (!response.ok) setError(body.error ?? "Could not load the projects.");
      else setProjects(body.projects);
    } catch {
      setError(NO_BACKEND);
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function change(project: ProjectWithCount, fields: { name?: string; archived?: boolean }) {
    setBusy(true);
    setError(null);
    const problem = await changeProject(project.id, fields);
    if (problem) setError(problem);
    else onChanged();
    await load();
    setBusy(false);
  }

  function rename(project: ProjectWithCount) {
    const name = window.prompt("New name for this project (at most 60 characters):", project.name);
    if (name === null || name.trim() === "" || name.trim() === project.name) return;
    change(project, { name });
  }

  function archive(project: ProjectWithCount) {
    const jobs = project.jobCount === 1 ? "1 job" : `${project.jobCount} jobs`;
    const question = `Archive "${project.name}"? It leaves the project picker. Its ${jobs}, cards and chats are kept.`;
    if (!window.confirm(question)) return;
    change(project, { archived: true });
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal panel" onClick={(event) => event.stopPropagation()}>
        <div className="modal-head">
          <h2>Manage projects</h2>
          <button type="button" className="icon-button" onClick={onClose} title="Close">
            <CloseIcon size={18} />
          </button>
        </div>
        {error && <p className="message error">{error}</p>}
        {!projects && !error && <p className="board-hint">Loading the projects...</p>}
        {projects && (
          <ul className="project-list">
            {projects.map((project) => (
              <li key={project.id}>
                <FolderIcon size={18} />
                <span className="project-list-name">{project.name}</span>
                <span className="board-meta">{project.jobCount === 1 ? "1 job" : `${project.jobCount} jobs`}</span>
                {project.name === UNSORTED_NAME ? (
                  <span className="board-meta" title="Unsorted always exists. It cannot be renamed or archived.">
                    Always here
                  </span>
                ) : (
                  <>
                    <button type="button" className="button" onClick={() => rename(project)} disabled={busy}>
                      Rename
                    </button>
                    <button type="button" className="button" onClick={() => archive(project)} disabled={busy}>
                      Archive
                    </button>
                  </>
                )}
              </li>
            ))}
          </ul>
        )}
        <p className="board-hint">Archiving does not delete anything. Projects cannot be deleted.</p>
      </div>
    </div>
  );
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
