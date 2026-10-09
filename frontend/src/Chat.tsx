import { useEffect, useRef, useState } from "react";
import type { ClipboardEvent, DragEvent, FormEvent, KeyboardEvent, ReactNode } from "react";
import { CloseIcon, PaperclipIcon, PencilIcon, SparklesIcon } from "./Icons";
import ChatCard from "./ChatCard";
import type { ChatCardRef } from "./ChatCard";
import type { Preset, StartValues } from "./Generate";

// The chat page (FRG-23): talk with Claude about scenes and prompts. Text only.
// Left: my conversations. Right: the messages and a box to type in.
// The reply streams in piece by piece (SSE, see backend/src/chat.ts). Stop ends it early.
// Claude can make board cards (FRG-24). They show under its reply, with a Generate button.
// Pictures can be attached (FRG-25): Attach button, paste, or drag and drop. Claude sees them, and
// can use them as the start image of a card.

// Same limit as the backend.
const MAX_MESSAGE_LENGTH = 8000;

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
type ConversationSummary = { id: string; title: string; updatedAt: string };
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
};

export default function Chat({
  conversationId,
  pendingAttachment = null,
  onPendingAttachmentUsed,
  onOpenInGenerate,
}: ChatProps) {
  const [setupError, setSetupError] = useState<string | null>(null);
  const [list, setList] = useState<ConversationSummary[]>([]);
  const [listError, setListError] = useState<string | null>(null);
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
  // A chat that send() just made: its messages are already on screen, so do not load it again.
  const justCreatedRef = useRef<string | null>(null);

  function open(id: string | null) {
    window.location.hash = id ? `#/chat/${id}` : "#/chat";
  }

  async function loadList() {
    try {
      const response = await fetch("/api/chat/conversations");
      const body = await response.json().catch(() => null);
      if (!body) setListError(NO_BACKEND);
      else if (!response.ok) setListError(body.error ?? "Could not load your conversations.");
      else {
        setList(body.conversations);
        setListError(null);
      }
    } catch {
      setListError(NO_BACKEND);
    }
  }

  // Is chat set up? And my conversations. Once, when the page opens.
  useEffect(() => {
    fetch("/api/chat/status")
      .then((response) => response.json())
      .then((body) => setSetupError(body.ready ? null : (body.error ?? "Chat is not set up.")))
      .catch(() => setSetupError(NO_BACKEND));
    fetch("/api/presets")
      .then((response) => response.json())
      .then((body) => setPresets(body.presets ?? []))
      .catch(() => {});
    loadList();
  }, []);

  // Open the conversation from the address.
  useEffect(() => {
    if (conversationId && conversationId === justCreatedRef.current) {
      justCreatedRef.current = null;
      return;
    }
    stopRef.current?.abort(); // Another chat was opened: stop the reply that is still coming in.
    setMessages([]);
    setError(null);
    if (!conversationId) return;
    async function loadConversation() {
      try {
        const response = await fetch(`/api/chat/conversations/${encodeURIComponent(conversationId!)}`);
        const body = await response.json().catch(() => null);
        if (!body) setError(NO_BACKEND);
        else if (!response.ok) setError(body.error ?? "Could not open this conversation.");
        else setMessages((body as Conversation).messages);
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

  // Keep the newest message in view.
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [messages, replyText]);

  async function newChat(): Promise<string | null> {
    setError(null);
    try {
      const response = await fetch("/api/chat/conversations", { method: "POST" });
      const body = await response.json().catch(() => null);
      if (!body) setError(NO_BACKEND);
      else if (!response.ok) setError(body.error ?? "Could not start a new chat.");
      else {
        await loadList();
        open(body.id);
        return body.id;
      }
    } catch {
      setError(NO_BACKEND);
    }
    return null;
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
    loadList();
  }

  async function remove(conversation: ConversationSummary) {
    if (!window.confirm(`Delete the chat "${conversation.title}"? This cannot be undone.`)) return;
    const response = await fetch(`/api/chat/conversations/${conversation.id}`, { method: "DELETE" }).catch(() => null);
    const body = await response?.json().catch(() => null);
    if (!response?.ok) setError(body?.error ?? NO_BACKEND);
    else if (conversation.id === conversationId) open(null);
    loadList();
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
      loadList(); // The title and the order may have changed.
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

  return (
    <main className="page chat-page">
      <aside className="chat-list panel">
        <button className="button primary" onClick={() => newChat()} disabled={streaming}>
          <SparklesIcon size={18} /> New chat
        </button>
        {listError && <p className="message error">{listError}</p>}
        {list.length === 0 && !listError && <p className="board-hint">No chats yet.</p>}
        {list.map((conversation) => (
          <div key={conversation.id} className={`chat-item ${conversation.id === conversationId ? "active" : ""}`}>
            <a href={`#/chat/${conversation.id}`} title={conversation.title}>
              {conversation.title}
            </a>
            <button className="icon-button" onClick={() => rename(conversation)} title="Rename" disabled={streaming}>
              <PencilIcon size={15} />
            </button>
            <button className="icon-button" onClick={() => remove(conversation)} title="Delete" disabled={streaming}>
              <CloseIcon size={15} />
            </button>
          </div>
        ))}
      </aside>

      <section
        className={`chat-main panel ${dragOver ? "drop-target" : ""}`}
        onDragOver={(event) => {
          if (!event.dataTransfer.types.includes("Files")) return;
          event.preventDefault(); // Allows the drop.
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={handleDrop}
      >
        <div className="chat-messages">
          {setupError && <p className="message error">{setupError}</p>}
          {!setupError && messages.length === 0 && !streaming && (
            <p className="board-hint">
              Plan a scene or ask for a prompt. Claude answers short. The chat text is sent to the Claude API on the
              internet; images and videos are still made on this PC.
            </p>
          )}
          {messages.map((message, index) => (
            <div key={index} className={`chat-bubble ${message.role}`}>
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
            </div>
          ))}
          {streaming && (
            <div className="chat-bubble assistant">
              {replyText ? <Markdown text={replyText} /> : <p className="chat-note">Claude is thinking...</p>}
              {replyCards.map((card) => (
                <ChatCard key={card.id} card={card} presets={presets} onOpenInGenerate={onOpenInGenerate} />
              ))}
            </div>
          )}
          {error && <p className="message error">{error}</p>}
          <div ref={endRef} />
        </div>

        <form className="chat-input" onSubmit={send}>
          {(attached.length > 0 || attaching) && (
            <div className="chat-attached">
              {attached.map((a) => (
                <span key={a.id} className="chat-attached-item" title={`${a.id} (${a.width} x ${a.height})`}>
                  <img src={inputUrl(a.id)} alt={`Picture ${a.id}`} />
                  <button
                    type="button"
                    onClick={() => setAttached((current) => current.filter((c) => c.id !== a.id))}
                    title="Remove"
                    disabled={streaming}
                  >
                    <CloseIcon size={12} />
                  </button>
                </span>
              ))}
              {attaching && <span className="chat-note">Uploading...</span>}
            </div>
          )}
          <textarea
            className="prompt-box"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={handleKey}
            onPaste={handlePaste}
            placeholder="Type a message. Enter sends, Shift+Enter makes a new line."
            disabled={!!setupError}
          />
          <div className="chat-input-row">
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
              className="button"
              onClick={() => fileRef.current?.click()}
              disabled={!!setupError || attaching}
              title="Attach a picture (or paste it, or drop it here)"
            >
              <PaperclipIcon size={16} /> Attach
            </button>
            <span className={`char-count ${tooLong ? "over" : ""}`}>
              {text.length} / {MAX_MESSAGE_LENGTH}
            </span>
            {streaming ? (
              <button type="button" className="button" onClick={() => stopRef.current?.abort()}>
                Stop
              </button>
            ) : (
              <button
                type="submit"
                className="button primary"
                disabled={!!setupError || tooLong || attaching || (text.trim() === "" && attached.length === 0)}
              >
                Send
              </button>
            )}
          </div>
        </form>
      </section>
    </main>
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
