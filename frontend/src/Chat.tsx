import { useEffect, useRef, useState } from "react";
import type { FormEvent, KeyboardEvent, ReactNode } from "react";
import { CloseIcon, PencilIcon, SparklesIcon } from "./Icons";
import ChatCard from "./ChatCard";
import type { ChatCardRef } from "./ChatCard";
import type { Preset } from "./Generate";

// The chat page (FRG-23): talk with Claude about scenes and prompts. Text only.
// Left: my conversations. Right: the messages and a box to type in.
// The reply streams in piece by piece (SSE, see backend/src/chat.ts). Stop ends it early.
// Claude can make board cards (FRG-24). They show under its reply, with a Generate button.

// Same limit as the backend.
const MAX_MESSAGE_LENGTH = 8000;

// From the backend (see backend/src/db.ts).
type Message = {
  role: "user" | "assistant";
  text: string;
  createdAt: string;
  stopped?: boolean;
  cards?: ChatCardRef[];
};
type ConversationSummary = { id: string; title: string; updatedAt: string };
type Conversation = ConversationSummary & { messages: Message[] };

const NO_BACKEND = "Could not reach the backend. Make sure it is running, then try again.";

type ChatProps = {
  // From #/chat/<id>: the open conversation. Keeps it open after a refresh.
  conversationId: string | null;
};

export default function Chat({ conversationId }: ChatProps) {
  const [setupError, setSetupError] = useState<string | null>(null);
  const [list, setList] = useState<ConversationSummary[]>([]);
  const [listError, setListError] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [text, setText] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [replyText, setReplyText] = useState(""); // The reply while it streams.
  const [replyCards, setReplyCards] = useState<ChatCardRef[]>([]); // Cards made in that reply so far.
  const [presets, setPresets] = useState<Preset[]>([]);
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
    if (message.trim() === "" || streaming) return;
    setError(null);

    let id = conversationId;
    if (!id) {
      id = await newChat();
      if (!id) return;
      justCreatedRef.current = id;
    }

    setText("");
    setMessages((current) => [...current, { role: "user", text: message, createdAt: new Date().toISOString() }]);
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
        body: JSON.stringify({ text: message }),
        signal: controller.signal,
      });

      // Not a stream: a problem found before the reply started (not set up, limit reached, ...).
      if (!response.headers.get("Content-Type")?.includes("text/event-stream") || !response.body) {
        const body = await response.json().catch(() => null);
        setError(body?.error ?? NO_BACKEND);
        // The message was not saved, so take it off the screen and put it back in the box.
        setMessages((current) => current.slice(0, -1));
        setText(message);
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

      <section className="chat-main panel">
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
              {message.role === "assistant" ? <Markdown text={message.text} /> : <p>{message.text}</p>}
              {message.stopped && <p className="chat-note">Stopped.</p>}
              {message.cards?.map((card) => <ChatCard key={card.id} card={card} presets={presets} />)}
            </div>
          ))}
          {streaming && (
            <div className="chat-bubble assistant">
              {replyText ? <Markdown text={replyText} /> : <p className="chat-note">Claude is thinking...</p>}
              {replyCards.map((card) => (
                <ChatCard key={card.id} card={card} presets={presets} />
              ))}
            </div>
          )}
          {error && <p className="message error">{error}</p>}
          <div ref={endRef} />
        </div>

        <form className="chat-input" onSubmit={send}>
          <textarea
            className="prompt-box"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={handleKey}
            placeholder="Type a message. Enter sends, Shift+Enter makes a new line."
            disabled={!!setupError}
          />
          <div className="chat-input-row">
            <span className={`char-count ${tooLong ? "over" : ""}`}>
              {text.length} / {MAX_MESSAGE_LENGTH}
            </span>
            {streaming ? (
              <button type="button" className="button" onClick={() => stopRef.current?.abort()}>
                Stop
              </button>
            ) : (
              <button type="submit" className="button primary" disabled={!!setupError || tooLong || text.trim() === ""}>
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
