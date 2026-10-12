import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Folder, MessageSquare, Pencil, X } from "lucide-react";
import type { Project } from "./App";
import { MoveToProject } from "./ProjectDialogs";

// The chats of the current project, in the sidebar's "Recent" area (FRG-47).
// Before FRG-47 this list was on the Chat page. Same API and the same project filter.

const NO_BACKEND = "Could not reach the backend. Make sure it is running, then try again.";

// One chat, as GET /api/chat/conversations returns it (see backend/src/chat.ts). Newest first.
export type ConversationSummary = { id: string; title: string; updatedAt: string; projectId?: string };

function open(id: string | null) {
  window.location.hash = id ? `#/chat/${id}` : "#/chat";
}

// The list and the actions on it. Used by AppShell: its "New chat" button and the Recent area share it.
// projectId: undefined while the projects load, null if they could not be loaded (then all chats).
// version: goes up when the Chat page changed the list (a chat made by sending, a new title).
export function useRecentChats(projectId: string | null | undefined, version: number) {
  const [list, setList] = useState<ConversationSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // The project of the list on screen, so a slow answer for the project before is ignored.
  const listProjectRef = useRef(projectId);

  async function load() {
    const forProject = listProjectRef.current;
    if (forProject === undefined) return; // Wait for the projects.
    try {
      const filter = forProject ? `?projectId=${encodeURIComponent(forProject)}` : "";
      const response = await fetch(`/api/chat/conversations${filter}`);
      const body = await response.json().catch(() => null);
      if (forProject !== listProjectRef.current) return;
      if (!body) setError(NO_BACKEND);
      else if (!response.ok) setError(body.error ?? "Could not load your conversations.");
      else {
        setList(body.conversations);
        setError(null);
      }
    } catch {
      setError(NO_BACKEND);
    }
  }

  // Load again when the project changes (a new list) or the Chat page says the list changed.
  useEffect(() => {
    if (listProjectRef.current !== projectId) {
      listProjectRef.current = projectId;
      setList([]);
      setNotice(null);
    }
    load();
  }, [projectId, version]);

  // "New chat": make the chat in the current project (FRG-42), then open it.
  async function newChat() {
    setError(null);
    try {
      const response = await fetch("/api/chat/conversations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(projectId ? { projectId } : {}),
      });
      const body = await response.json().catch(() => null);
      if (!body) setError(NO_BACKEND);
      else if (!response.ok) setError(body.error ?? "Could not start a new chat.");
      else {
        await load();
        open(body.id);
      }
    } catch {
      setError(NO_BACKEND);
    }
  }

  async function rename(conversation: ConversationSummary) {
    const title = window.prompt("New name for this chat:", conversation.title);
    if (title === null || title.trim() === "" || title === conversation.title) return;
    const response = await fetch(`/api/chat/conversations/${conversation.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title }),
    }).catch(() => null);
    const body = await response?.json().catch(() => null);
    if (!response?.ok) setError(body?.error ?? NO_BACKEND);
    load();
  }

  // openId: the chat open on the Chat page. If it is deleted, the Chat page shows an empty chat.
  async function remove(conversation: ConversationSummary, openId: string | null) {
    if (!window.confirm(`Delete the chat "${conversation.title}"? This cannot be undone.`)) return;
    const response = await fetch(`/api/chat/conversations/${conversation.id}`, { method: "DELETE" }).catch(() => null);
    const body = await response?.json().catch(() => null);
    if (!response?.ok) setError(body?.error ?? NO_BACKEND);
    else if (conversation.id === openId) open(null);
    load();
  }

  // Move a chat to another project (FRG-43). It leaves this project's list. If it was open, it closes.
  async function moveTo(conversation: ConversationSummary, target: Project, openId: string | null): Promise<string | null> {
    try {
      const response = await fetch(`/api/chat/conversations/${conversation.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId: target.id }),
      });
      const body = await response.json().catch(() => null);
      if (!body) return NO_BACKEND;
      if (!response.ok) return body.error ?? "Could not move this chat.";
      setNotice(`"${conversation.title}" moved to the project "${target.name}".`);
      if (conversation.id === openId && projectId && target.id !== projectId) open(null);
      load();
      return null;
    } catch {
      return NO_BACKEND;
    }
  }

  return { list, error, notice, newChat, rename, remove, moveTo };
}

type RecentChatsProps = {
  chats: ReturnType<typeof useRecentChats>;
  openId: string | null; // The chat open on the Chat page: highlighted.
  project: Project | null | undefined;
  projects: Project[]; // For "Move to project".
};

// The "Recent" area. Long titles are cut with "…". On hover: Rename, Move to project, Delete.
export default function RecentChats({ chats, openId, project, projects }: RecentChatsProps) {
  const [moving, setMoving] = useState<ConversationSummary | null>(null);

  return (
    <>
      {chats.error && <p className="mx-3 mb-2 text-xs text-red-400">{chats.error}</p>}
      {chats.notice && <p className="mx-3 mb-2 text-xs text-teal-300">{chats.notice}</p>}
      {chats.list.length === 0 && !chats.error && project !== undefined && (
        <p className="mx-3 text-xs text-slate-500">{project ? `No chats in "${project.name}" yet.` : "No chats yet."}</p>
      )}
      <ul className="m-0 list-none space-y-0.5 p-0">
        {chats.list.map((conversation) => {
          const active = conversation.id === openId;
          return (
            <li
              key={conversation.id}
              className={`group flex items-center rounded-lg transition-colors duration-200 ${
                active ? "bg-slate-700/80" : "hover:bg-slate-700/50"
              }`}
            >
              <a
                href={`#/chat/${conversation.id}`}
                title={conversation.title}
                aria-current={active ? "page" : undefined}
                className={`flex min-w-0 flex-1 items-center gap-3 py-2 pl-3 text-sm ${
                  active ? "text-teal-100" : "text-slate-400 group-hover:text-slate-200"
                }`}
              >
                <MessageSquare size={14} className={`shrink-0 ${active ? "text-teal-400" : "text-slate-500"}`} />
                <span className="truncate">{conversation.title}</span>
              </a>
              {/* Shown on hover, or when one of the buttons has keyboard focus. */}
              <div className="flex shrink-0 items-center gap-0.5 pr-1 opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100">
                <IconButton title="Rename" onClick={() => chats.rename(conversation)}>
                  <Pencil size={12} />
                </IconButton>
                {projects.length > 0 && (
                  <IconButton title="Move to project..." onClick={() => setMoving(conversation)}>
                    <Folder size={12} />
                  </IconButton>
                )}
                <IconButton title="Delete" danger onClick={() => chats.remove(conversation, openId)}>
                  <X size={12} />
                </IconButton>
              </div>
            </li>
          );
        })}
      </ul>
      {moving && (
        <MoveToProject
          what={`the chat "${moving.title}"`}
          projects={projects}
          currentProjectId={moving.projectId}
          onMove={(target) => chats.moveTo(moving, target, openId)}
          onClose={() => setMoving(null)}
        />
      )}
    </>
  );
}

function IconButton(props: { title: string; danger?: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      title={props.title}
      aria-label={props.title}
      onClick={props.onClick}
      className={`flex cursor-pointer items-center rounded-md border-0 bg-transparent p-1.5 text-slate-400 transition-colors hover:bg-slate-600 ${
        props.danger ? "hover:text-red-400" : "hover:text-slate-200"
      }`}
    >
      {props.children}
    </button>
  );
}
