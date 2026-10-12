import { useEffect, useRef, useState } from "react";
import type { ClipboardEvent, DragEvent, FormEvent, KeyboardEvent, ReactNode } from "react";
import { Paperclip, Send, Square, X } from "lucide-react";
import ChatCard from "./ChatCard";
import type { ChatCardRef } from "./ChatCard";
import type { Preset, StartValues } from "./Generate";
import type { Project } from "./App";
import type { ConversationSummary } from "./RecentChats";

// The chat page (FRG-23): talk with Claude about scenes and prompts. Text only.
// The messages in a centred column, and a box to type in that floats at the bottom (FRG-48).
// The list of chats is in the sidebar (RecentChats.tsx, FRG-47).
// The reply streams in piece by piece (SSE, see backend/src/chat.ts). Stop ends it early.
// Claude can make board cards (FRG-24). They show under its reply, with a Generate button.
// Pictures can be attached (FRG-25): Attach button, paste, or drag and drop. Claude sees them, and
// can use them as the start image of a card.

// Same limit as the backend.
const MAX_MESSAGE_LENGTH = 8000;

// The message box grows with its text up to this height, then it scrolls.
const MAX_BOX_HEIGHT = 250;

// Pictures: the same checks as the upload route (backend/src/upload.ts), plus the Claude API
// limits (backend/src/chatImages.ts). A picture Claude cannot take is refused before it is uploaded.
const IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp"];
const MAX_UPLOAD_MB = 20;
const MAX_IMAGE_BASE64_BYTES = 10_000_000;
const MAX_IMAGE_SIDE = 8000;
const MAX_IMAGES_PER_MESSAGE = 20;

// A picture attached to the next message. Its id is its file name in data/inputs.
export type Attachment = { id: string; width: number; height: number };

// The address of a kept picture.
function inputUrl(id: string): string {
  return `/api/inputs/${encodeURIComponent(id)}`;
}

// From the backend (see backend/src/db.ts).
type Message = {
  role: "user" | "assistant";
  text: string;
  createdAt: string;
  stopped?: boolean;
  cards?: ChatCardRef[];
  images?: { id: string; path: string }[];
};
type Conversation = ConversationSummary & { messages: Message[] };

const NO_BACKEND = "Could not reach the backend. Make sure it is running, then try again.";

type ChatProps = {
  // From #/chat/<id>: the open conversation. Keeps it open after a refresh.
  conversationId: string | null;
  // "Use in chat" in the gallery: a picture to attach to the next message.
  pendingAttachment?: Attachment | null;
  onPendingAttachmentUsed?: () => void;
  // "Send to -> Open in Generate" on a finished card (FRG-26).
  onOpenInGenerate: (values: StartValues) => void;
  // The project chosen in the sidebar (FRG-42): new chats go into it.
  // undefined while the projects load. null if they could not be loaded.
  project: Project | null | undefined;
  // The sidebar's chat list must load again: a chat was made by sending, or got its title (FRG-47).
  onListChanged: () => void;
  // A chat opened from a link is in another project: switch the picker to it.
  onShowProject: (projectId: string | undefined) => void;
};

export default function Chat({
  conversationId,
  pendingAttachment = null,
  onPendingAttachmentUsed,
  onOpenInGenerate,
  project,
  onListChanged,
  onShowProject,
}: ChatProps) {
  const [setupError, setSetupError] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [text, setText] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [replyText, setReplyText] = useState(""); // The reply while it streams.
  const [replyCards, setReplyCards] = useState<ChatCardRef[]>([]); // Cards made in that reply so far.
  const [presets, setPresets] = useState<Preset[]>([]);
  const [attached, setAttached] = useState<Attachment[]>([]);
  const [attaching, setAttaching] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);
  const stopRef = useRef<AbortController | null>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const boxRef = useRef<HTMLTextAreaElement>(null);
  // The floating input box and its height, so the last message can always be scrolled above it.
  const formRef = useRef<HTMLFormElement>(null);
  const [formHeight, setFormHeight] = useState(0);
  // The scrolling message area, and the column of messages in it.
  const scrollRef = useRef<HTMLDivElement>(null);
  const columnRef = useRef<HTMLDivElement>(null);
  // A chat that send() just made: its messages are already on screen, so do not load it again.
  const justCreatedRef = useRef<string | null>(null);
  const projectId = project === undefined ? undefined : (project?.id ?? null);
  // The project of the open chat (FRG-42). When another project is chosen, the chat closes.
  const [openProjectId, setOpenProjectId] = useState<string | null>(null);

  function open(id: string | null) {
    window.location.hash = id ? `#/chat/${id}` : "#/chat";
  }

  // Is chat set up? And the presets for the cards. Once, when the page opens.
  useEffect(() => {
    fetch("/api/chat/status")
      .then((response) => response.json())
      .then((body) => setSetupError(body.ready ? null : (body.error ?? "Chat is not set up.")))
      .catch(() => setSetupError(NO_BACKEND));
    fetch("/api/presets")
      .then((response) => response.json())
      .then((body) => setPresets(body.presets ?? []))
      .catch(() => {});
  }, []);

  // Another project was chosen while a chat of the project before is open: close that chat (FRG-42).
  useEffect(() => {
    if (projectId && openProjectId && openProjectId !== projectId) open(null);
  }, [projectId]);

  // Open the conversation from the address.
  useEffect(() => {
    if (conversationId && conversationId === justCreatedRef.current) {
      justCreatedRef.current = null;
      return;
    }
    stopRef.current?.abort(); // Another chat was opened: stop the reply that is still coming in.
    setMessages([]);
    setError(null);
    setOpenProjectId(null);
    if (!conversationId) return;
    async function loadConversation() {
      try {
        const response = await fetch(`/api/chat/conversations/${encodeURIComponent(conversationId!)}`);
        const body = await response.json().catch(() => null);
        if (!body) setError(NO_BACKEND);
        else if (!response.ok) setError(body.error ?? "Could not open this conversation.");
        else {
          setMessages((body as Conversation).messages);
          // A chat of another project (for example from a link): switch the picker to it (FRG-42).
          setOpenProjectId((body as Conversation).projectId ?? null);
          onShowProject((body as Conversation).projectId);
        }
      } catch {
        setError(NO_BACKEND);
      }
    }
    loadConversation();
  }, [conversationId]);

  // "Use in chat" from the gallery: attach that picture to the next message.
  useEffect(() => {
    if (!pendingAttachment) return;
    setAttached((current) =>
      current.some((a) => a.id === pendingAttachment.id) ? current : [...current, pendingAttachment],
    );
    onPendingAttachmentUsed?.();
  }, [pendingAttachment]);

  // Check a picture against the upload and Claude limits, then upload it like the Generate page does.
  async function attachFile(file: File) {
    setError(null);
    if (!IMAGE_TYPES.includes(file.type)) {
      setError(`"${file.name}" is not a PNG, JPEG or WebP picture.`);
      return;
    }
    if (file.size > MAX_UPLOAD_MB * 1024 * 1024) {
      setError(`"${file.name}" is too big. The limit is ${MAX_UPLOAD_MB} MB.`);
      return;
    }
    if (Math.ceil(file.size / 3) * 4 > MAX_IMAGE_BASE64_BYTES) {
      const mb = (file.size / 1_000_000).toFixed(1);
      setError(`"${file.name}" is too large for Claude (${mb} MB). Claude accepts pictures up to about 7.5 MB. Make it smaller and attach it again.`);
      return;
    }
    try {
      const bitmap = await createImageBitmap(file);
      const { width, height } = bitmap;
      bitmap.close();
      if (width > MAX_IMAGE_SIDE || height > MAX_IMAGE_SIDE) {
        setError(`"${file.name}" is ${width} x ${height} pixels. Claude accepts at most ${MAX_IMAGE_SIDE} x ${MAX_IMAGE_SIDE}. Make it smaller and attach it again.`);
        return;
      }
    } catch {
      setError(`"${file.name}" could not be read as a picture.`);
      return;
    }

    setAttaching(true);
    try {
      const response = await fetch("/api/upload", { method: "POST", headers: { "Content-Type": file.type }, body: file });
      const body = await response.json().catch(() => null);
      if (!body) setError(NO_BACKEND);
      else if (!response.ok) setError(body.error ?? "The upload did not work. Please try again.");
      else setAttached((current) => [...current, { id: body.name, width: body.width, height: body.height }]);
    } catch {
      setError(NO_BACKEND);
    } finally {
      setAttaching(false);
    }
  }

  async function attachFiles(files: File[]) {
    const room = MAX_IMAGES_PER_MESSAGE - attached.length;
    if (files.length > room) {
      setError(`You can attach at most ${MAX_IMAGES_PER_MESSAGE} pictures to one message.`);
      return;
    }
    for (const file of files) await attachFile(file);
  }

  // Paste a picture into the message box.
  function handlePaste(event: ClipboardEvent<HTMLTextAreaElement>) {
    const files = [...event.clipboardData.files].filter((f) => f.type.startsWith("image/"));
    if (files.length === 0) return; // Plain text: paste as usual.
    event.preventDefault();
    attachFiles(files);
  }

  // Drop pictures anywhere on the chat.
  function handleDrop(event: DragEvent) {
    event.preventDefault();
    setDragOver(false);
    attachFiles([...event.dataTransfer.files]);
  }

  // Keep the newest message in view (also when the input box grows over it).
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [messages, replyText, formHeight]);

  // The message box grows with its text, up to MAX_BOX_HEIGHT.
  useEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    box.style.height = "auto";
    box.style.height = `${Math.min(box.scrollHeight, MAX_BOX_HEIGHT)}px`;
  }, [text]);

  // Measure the floating input box. It gets taller with more lines and with attached pictures.
  useEffect(() => {
    const form = formRef.current;
    if (!form) return;
    const observer = new ResizeObserver(() => setFormHeight(form.offsetHeight));
    observer.observe(form);
    return () => observer.disconnect();
  }, []);

  // Pictures and cards finish loading after the messages are shown, and make them taller.
  // If the user was at the bottom, stay at the bottom, so the last message is not hidden.
  useEffect(() => {
    const scroller = scrollRef.current;
    const column = columnRef.current;
    if (!scroller || !column) return;
    // The height before the change: the user was at the bottom if the view reached (almost) its end.
    let lastHeight = scroller.scrollHeight;
    const observer = new ResizeObserver(() => {
      if (lastHeight - scroller.scrollTop - scroller.clientHeight < 40) scroller.scrollTop = scroller.scrollHeight;
      lastHeight = scroller.scrollHeight;
    });
    observer.observe(column);
    return () => observer.disconnect();
  }, []);

  async function newChat(): Promise<string | null> {
    setError(null);
    try {
      // A new chat goes into the current project (FRG-42).
      const response = await fetch("/api/chat/conversations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(project ? { projectId: project.id } : {}),
      });
      const body = await response.json().catch(() => null);
      if (!body) setError(NO_BACKEND);
      else if (!response.ok) setError(body.error ?? "Could not start a new chat.");
      else {
        setOpenProjectId(body.projectId ?? null);
        onListChanged();
        open(body.id);
        return body.id;
      }
    } catch {
      setError(NO_BACKEND);
    }
    return null;
  }

  // Send the message, then read the reply as it streams in.
  async function send(event?: FormEvent) {
    event?.preventDefault();
    const message = text;
    const images = attached;
    if ((message.trim() === "" && images.length === 0) || streaming || attaching) return;
    setError(null);

    let id = conversationId;
    if (!id) {
      id = await newChat();
      if (!id) return;
      justCreatedRef.current = id;
    }

    setText("");
    setAttached([]);
    setMessages((current) => [
      ...current,
      {
        role: "user",
        text: message,
        createdAt: new Date().toISOString(),
        images: images.map((a) => ({ id: a.id, path: `data/inputs/${a.id}` })),
      },
    ]);
    setStreaming(true);
    setReplyText("");
    setReplyCards([]);
    const controller = new AbortController();
    stopRef.current = controller;
    let received = "";
    const cards: ChatCardRef[] = [];

    try {
      const response = await fetch(`/api/chat/${id}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: message, images: images.map((a) => a.id) }),
        signal: controller.signal,
      });

      // Not a stream: a problem found before the reply started (not set up, limit reached, ...).
      if (!response.headers.get("Content-Type")?.includes("text/event-stream") || !response.body) {
        const body = await response.json().catch(() => null);
        setError(body?.error ?? NO_BACKEND);
        // The message was not saved, so take it off the screen and put it back in the box.
        setMessages((current) => current.slice(0, -1));
        setText(message);
        setAttached(images);
        return;
      }

      // Read the SSE events. They are separated by a blank line.
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let end;
        while ((end = buffer.indexOf("\n\n")) >= 0) {
          const block = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          const name = block.match(/^event: (.*)$/m)?.[1];
          const data = JSON.parse(block.match(/^data: (.*)$/m)?.[1] ?? "{}");
          if (name === "text") {
            received += data.text;
            setReplyText(received);
          } else if (name === "card") {
            cards.push(data.card);
            setReplyCards([...cards]);
          } else if (name === "error") {
            setError(data.error);
          }
        }
      }
    } catch (caught) {
      // Stop pressed: keep the text so far (the backend saves it too).
      if (!(caught instanceof DOMException && caught.name === "AbortError")) setError(NO_BACKEND);
    } finally {
      const stopped = controller.signal.aborted;
      if (received !== "" || cards.length > 0) {
        setMessages((current) => [
          ...current,
          { role: "assistant", text: received, createdAt: new Date().toISOString(), stopped, cards },
        ]);
      }
      setReplyText("");
      setReplyCards([]);
      setStreaming(false);
      stopRef.current = null;
      onListChanged(); // The title and the order may have changed.
    }
  }

  // Enter sends, Shift+Enter makes a new line.
  function handleKey(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      send();
    }
  }

  const tooLong = text.length > MAX_MESSAGE_LENGTH;
  const canSend = !setupError && !tooLong && !attaching && (text.trim() !== "" || attached.length > 0);

  return (
    <main
      className={`relative h-[calc(100vh-var(--header-h))] ${dragOver ? "outline-2 -outline-offset-8 outline-teal-500/60 outline-dashed" : ""}`}
      onDragOver={(event) => {
        if (!event.dataTransfer.types.includes("Files")) return;
        event.preventDefault(); // Allows the drop.
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={handleDrop}
    >
      {/* The messages scroll here, in a centred column. */}
      <div ref={scrollRef} className="h-full overflow-y-auto px-8">
        <div ref={columnRef} className="mx-auto flex w-full max-w-4xl flex-col gap-4 pt-2">
          {setupError && <p className="message error">{setupError}</p>}
          {!setupError && messages.length === 0 && !streaming && (
            <p className="mt-4 text-sm font-medium text-slate-500">
              Plan a scene or ask for a prompt. Claude answers short. The chat text is sent to the Claude API on the
              internet; images and videos are still made on this PC.
            </p>
          )}
          {messages.map((message, index) => (
            <Bubble key={index} role={message.role}>
              {message.images && message.images.length > 0 && (
                <div className="chat-images">
                  {message.images.map((image) => (
                    <a key={image.id} href={inputUrl(image.id)} target="_blank" rel="noreferrer" title={image.id}>
                      <img src={inputUrl(image.id)} alt={`Attached picture ${image.id}`} />
                    </a>
                  ))}
                </div>
              )}
              {message.role === "assistant" ? <Markdown text={message.text} /> : message.text && <p>{message.text}</p>}
              {message.stopped && <p className="chat-note">Stopped.</p>}
              {message.cards?.map((card) => (
                <ChatCard key={card.id} card={card} presets={presets} onOpenInGenerate={onOpenInGenerate} />
              ))}
            </Bubble>
          ))}
          {streaming && (
            <Bubble role="assistant">
              {replyText ? <Markdown text={replyText} /> : <p className="chat-note">Claude is thinking...</p>}
              {replyCards.map((card) => (
                <ChatCard key={card.id} card={card} presets={presets} onOpenInGenerate={onOpenInGenerate} />
              ))}
            </Bubble>
          )}
          {error && <p className="message error">{error}</p>}
          {/* Empty space as tall as the input box, so the last message can scroll above it. */}
          <div ref={endRef} className="shrink-0" style={{ height: formHeight + 40 }} />
        </div>
      </div>

      {/* The floating input box. */}
      <div className="pointer-events-none absolute right-0 bottom-6 left-0 flex justify-center px-8">
        <form
          ref={formRef}
          onSubmit={send}
          className="pointer-events-auto flex w-full max-w-4xl flex-col gap-1 rounded-2xl border border-slate-700 bg-slate-800/90 p-2.5 shadow-2xl shadow-black/50 backdrop-blur-xl transition-all focus-within:border-teal-500/50 focus-within:ring-4 focus-within:ring-teal-500/10"
        >
          {(attached.length > 0 || attaching) && (
            <div className="chat-attached mx-2 mt-2">
              {attached.map((a) => (
                <span key={a.id} className="chat-attached-item" title={`${a.id} (${a.width} x ${a.height})`}>
                  <img src={inputUrl(a.id)} alt={`Picture ${a.id}`} />
                  <button
                    type="button"
                    onClick={() => setAttached((current) => current.filter((c) => c.id !== a.id))}
                    title="Remove"
                    disabled={streaming}
                  >
                    <X size={12} />
                  </button>
                </span>
              ))}
              {attaching && <span className="chat-note">Uploading...</span>}
            </div>
          )}
          <textarea
            ref={boxRef}
            rows={1}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={handleKey}
            onPaste={handlePaste}
            placeholder="Type a message. Enter sends, Shift+Enter makes a new line."
            disabled={!!setupError}
            className="min-h-[50px] w-full resize-none overflow-y-auto border-0 bg-transparent px-3 py-2 text-sm text-slate-100 outline-none placeholder:text-slate-500 disabled:cursor-not-allowed"
            style={{ maxHeight: MAX_BOX_HEIGHT }}
          />
          <div className="flex items-center justify-between px-1">
            <input
              ref={fileRef}
              type="file"
              accept={IMAGE_TYPES.join(",")}
              multiple
              hidden
              onChange={(e) => {
                attachFiles([...(e.target.files ?? [])]);
                e.target.value = ""; // So the same file can be picked again.
              }}
            />
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              disabled={!!setupError || attaching}
              title="Attach a picture (or paste it, or drop it here)"
              className="flex cursor-pointer items-center gap-2 rounded-lg border-0 bg-transparent px-3 py-1.5 text-sm font-medium text-slate-400 transition-colors hover:bg-slate-700/80 hover:text-slate-200 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Paperclip size={16} />
              Attach
            </button>
            <div className="flex items-center gap-4">
              <span className={`text-xs font-medium ${tooLong ? "text-red-400" : "text-slate-500"}`}>
                {text.length} / {MAX_MESSAGE_LENGTH}
              </span>
              {streaming ? (
                <button
                  type="button"
                  onClick={() => stopRef.current?.abort()}
                  title="Stop the reply"
                  className="flex h-9 cursor-pointer items-center gap-2 rounded-xl border border-slate-600 bg-slate-700 px-3 text-sm font-medium text-slate-200 transition-colors hover:bg-slate-600"
                >
                  <Square size={12} className="fill-current" />
                  Stop
                </button>
              ) : (
                <button
                  type="submit"
                  disabled={!canSend}
                  title="Send"
                  aria-label="Send"
                  className={`flex h-9 w-9 items-center justify-center rounded-xl border-0 transition-all duration-200 ${
                    canSend
                      ? "cursor-pointer bg-teal-600 text-white shadow-lg shadow-teal-900/40 hover:bg-teal-500"
                      : "cursor-not-allowed bg-slate-700 text-slate-500"
                  }`}
                >
                  <Send size={16} className={canSend ? "ml-0.5" : ""} />
                </button>
              )}
            </div>
          </div>
        </form>
      </div>
    </main>
  );
}

// One message. Mine on the right, Claude's on the left. The "chat-bubble" class in styles.css
// styles the text inside (paragraphs, lists, code, pictures).
function Bubble({ role, children }: { role: "user" | "assistant"; children: ReactNode }) {
  return (
    <div
      className={`chat-bubble rounded-2xl border px-4 py-2.5 text-sm ${
        role === "user"
          ? "self-end whitespace-pre-wrap border-teal-500/25 bg-teal-600/15 text-slate-100"
          : "self-start border-slate-700/60 bg-slate-800/80 text-slate-200"
      }`}
    >
      {children}
    </div>
  );
}

// ---- Simple markdown: paragraphs, lists, bold, code ----
// Built as React elements (not HTML), so nothing in a reply can run as code on the page.

// **bold** and `code` inside a line.
function inline(text: string): ReactNode[] {
  return text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).map((part, index) => {
    if (part.startsWith("**") && part.endsWith("**") && part.length > 4) return <strong key={index}>{part.slice(2, -2)}</strong>;
    if (part.startsWith("`") && part.endsWith("`") && part.length > 2) return <code key={index}>{part.slice(1, -1)}</code>;
    return part;
  });
}

const BULLET = /^\s*[-*] (.*)$/;
const NUMBERED = /^\s*\d+[.)] (.*)$/;
const HEADING = /^#{1,6} (.*)$/;

function Markdown({ text }: { text: string }) {
  const lines = text.split("\n");
  const blocks: ReactNode[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (line.trim().startsWith("```")) {
      // A code block, until the closing ``` (or the end while it is still streaming).
      const code: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith("```")) code.push(lines[i++]);
      i++;
      blocks.push(
        <pre key={blocks.length}>
          <code>{code.join("\n")}</code>
        </pre>,
      );
    } else if (BULLET.test(line) || NUMBERED.test(line)) {
      const numbered = NUMBERED.test(line);
      const pattern = numbered ? NUMBERED : BULLET;
      const items: ReactNode[] = [];
      while (i < lines.length && pattern.test(lines[i])) {
        items.push(<li key={items.length}>{inline(lines[i].match(pattern)![1])}</li>);
        i++;
      }
      blocks.push(numbered ? <ol key={blocks.length}>{items}</ol> : <ul key={blocks.length}>{items}</ul>);
    } else if (HEADING.test(line)) {
      blocks.push(
        <p key={blocks.length}>
          <strong>{inline(line.match(HEADING)![1])}</strong>
        </p>,
      );
      i++;
    } else if (line.trim() === "") {
      i++;
    } else {
      // A paragraph: lines until a blank line or another kind of block.
      const paragraph: string[] = [];
      while (
        i < lines.length &&
        lines[i].trim() !== "" &&
        !lines[i].trim().startsWith("```") &&
        !BULLET.test(lines[i]) &&
        !NUMBERED.test(lines[i]) &&
        !HEADING.test(lines[i])
      ) {
        paragraph.push(lines[i++]);
      }
      blocks.push(
        <p key={blocks.length}>
          {paragraph.map((part, index) => (
            <span key={index}>
              {index > 0 && <br />}
              {inline(part)}
            </span>
          ))}
        </p>,
      );
    }
  }
  return <>{blocks}</>;
}
