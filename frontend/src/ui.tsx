import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode, TextareaHTMLAttributes } from "react";
import { X } from "lucide-react";

// The shared parts of the look: Button, Input, Card, Modal, Tabs, Badge, Notice, EmptyState, PageHeader.
// Pages use these instead of writing their own colours. The colours come from theme.css
// (classes like bg-card, text-ink, border-line), so every part works in light and dark mode.

// Icons: 16-18px, thin lines. Pass these to a lucide-react icon: <Plus {...ICON} />.
export const ICON = { size: 16, strokeWidth: 1.5 } as const;

// ---------- Button ----------

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger" | "success";
export type ButtonSize = "md" | "sm" | "xs";

const BUTTON_BASE =
  "inline-flex shrink-0 cursor-pointer items-center justify-center gap-2 whitespace-nowrap border font-medium no-underline transition-colors disabled:cursor-not-allowed disabled:opacity-50";

const BUTTON_VARIANT: Record<ButtonVariant, string> = {
  primary: "border-primary bg-primary text-on-primary hover:border-primary-hover hover:bg-primary-hover",
  secondary: "border-line bg-card text-ink hover:bg-hover",
  ghost: "border-transparent bg-transparent text-ink-2 hover:bg-hover hover:text-ink",
  danger: "border-danger-line bg-card text-danger hover:bg-danger-soft",
  success: "border-success-line bg-success-soft text-success hover:border-success",
};

const BUTTON_SIZE: Record<ButtonSize, string> = {
  md: "h-9 rounded-[10px] px-4 text-sm",
  sm: "h-8 rounded-lg px-3 text-[13px]",
  xs: "h-7 rounded-lg px-2.5 text-xs",
};

// The classes of a button. Use it for a link that should look like a button: <a className={btn("secondary")}>.
export function btn(variant: ButtonVariant = "secondary", size: ButtonSize = "md", pill = false): string {
  return `${BUTTON_BASE} ${BUTTON_VARIANT[variant]} ${BUTTON_SIZE[size]} ${pill ? "rounded-full" : ""}`;
}

// A square button with only an icon in it (close, more, ...).
export const ICON_BUTTON =
  "inline-flex shrink-0 cursor-pointer items-center justify-center rounded-lg border-0 bg-transparent p-1.5 text-ink-2 transition-colors hover:bg-hover hover:text-ink disabled:cursor-not-allowed disabled:opacity-50";

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant; size?: ButtonSize; pill?: boolean };

export function Button({ variant = "secondary", size = "md", pill = false, className = "", type = "button", ...rest }: ButtonProps) {
  return <button type={type} className={`${btn(variant, size, pill)} ${className}`} {...rest} />;
}

// ---------- Input ----------

// The classes of a text field: white, thin border, clear focus ring.
export const FIELD =
  "block w-full rounded-[10px] border border-line bg-card px-3 text-sm text-ink outline-none transition-shadow placeholder:text-ink-3 hover:border-line-strong focus:border-accent focus:ring-3 focus:ring-focus-ring disabled:cursor-not-allowed disabled:opacity-60";

export function Input({ className = "", ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={`${FIELD} h-9 ${className}`} {...rest} />;
}

export function Textarea({ className = "", ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={`${FIELD} py-2 leading-relaxed ${className}`} {...rest} />;
}

// The small label above a field.
export const LABEL = "mb-1.5 block text-[13px] font-medium text-ink";

// ---------- Card ----------

// The classes of a card: white, thin border, rounded.
export const CARD = "rounded-[14px] border border-line bg-card";
// A card that can be clicked: a light hover state.
export const CARD_HOVER = "transition-colors hover:border-line-strong hover:bg-hover/40";
// The light grey frame behind a picture, a video, a 3D model or a sound.
export const MEDIA_FRAME = "bg-frame";

export function Card({ className = "", children }: { className?: string; children: ReactNode }) {
  return <div className={`${CARD} ${className}`}>{children}</div>;
}

// ---------- Modal ----------

type ModalProps = {
  title: string;
  subtitle?: ReactNode;
  onClose: () => void;
  size?: "sm" | "lg" | "xl"; // sm: a small form. lg and xl: a wide preview that can scroll.
  children: ReactNode;
};

const MODAL_WIDTH = { sm: "max-w-sm", lg: "max-w-4xl", xl: "max-w-5xl" };

// A dialog on top of the page. A click outside it, or on the X, calls onClose.
export function Modal({ title, subtitle, onClose, size = "sm", children }: ModalProps) {
  const tall = size !== "sm";
  return (
    <div
      className={`fixed inset-0 z-50 flex justify-center bg-overlay px-4 ${tall ? "items-start overflow-y-auto py-10" : "items-center"}`}
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-label={title}
        onClick={(event) => event.stopPropagation()}
        className={`w-full ${MODAL_WIDTH[size]} rounded-2xl border border-line bg-card ${tall ? "p-6" : "p-5"} shadow-float`}
      >
        <div className="mb-4 flex items-start justify-between gap-4">
          <div className="min-w-0">
            <h2 className={`m-0 font-medium tracking-tight text-ink ${tall ? "text-lg" : "text-base"}`}>{title}</h2>
            {subtitle && <div className="mt-1 truncate text-sm text-ink-2">{subtitle}</div>}
          </div>
          <button type="button" onClick={onClose} title="Close" aria-label="Close" className={ICON_BUTTON}>
            <X {...ICON} />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

// ---------- Tabs ----------

type TabsProps<T extends string> = {
  label: string; // For screen readers, for example "Run mode".
  items: { value: T; label: string; title?: string }[];
  value: T;
  onChange: (value: T) => void;
  disabled?: boolean;
};

// Simple text tabs. The active tab has a small bordered pill.
export function Tabs<T extends string>({ label, items, value, onChange, disabled }: TabsProps<T>) {
  return (
    <div className="inline-flex items-center gap-1" role="group" aria-label={label}>
      {items.map((item) => {
        const active = item.value === value;
        return (
          <button
            key={item.value}
            type="button"
            title={item.title}
            aria-pressed={active}
            disabled={disabled}
            onClick={() => onChange(item.value)}
            className={`cursor-pointer rounded-full border px-3 py-1 text-[13px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
              active ? "border-line bg-card text-ink shadow-soft" : "border-transparent bg-transparent text-ink-2 hover:text-ink"
            }`}
          >
            {item.label}
          </button>
        );
      })}
    </div>
  );
}

// ---------- Badge ----------

export type Tone = "neutral" | "info" | "warning" | "success" | "danger" | "special" | "accent" | "muted";

// The colours of a tone: a light tinted background with matching text.
export const TONE: Record<Tone, string> = {
  neutral: "bg-hover text-ink-2",
  muted: "bg-hover text-ink-3",
  info: "bg-info-soft text-info",
  warning: "bg-warning-soft text-warning",
  success: "bg-success-soft text-success",
  danger: "bg-danger-soft text-danger",
  special: "bg-special-soft text-special",
  accent: "bg-accent-soft text-accent",
};

export function Badge({ tone = "neutral", className = "", children }: { tone?: Tone; className?: string; children: ReactNode }) {
  return (
    <span className={`inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium whitespace-nowrap ${TONE[tone]} ${className}`}>
      {children}
    </span>
  );
}

// ---------- Notice ----------

const NOTICE_TONE = {
  danger: "border-danger-line bg-danger-soft text-danger",
  warning: "border-warning-line bg-warning-soft text-warning",
  success: "border-success-line bg-success-soft text-success",
  info: "border-info-line bg-info-soft text-info",
  neutral: "border-line bg-card text-ink-2",
};

// A message box inside the page: an error, a warning, or a plain note.
export function Notice({ tone = "neutral", className = "", children }: { tone?: keyof typeof NOTICE_TONE; className?: string; children: ReactNode }) {
  return <div className={`rounded-xl border px-4 py-3 text-sm ${NOTICE_TONE[tone]} ${className}`}>{children}</div>;
}

// ---------- EmptyState ----------

// Shown when a list has nothing in it yet.
export function EmptyState({ icon, title, text }: { icon?: ReactNode; title: string; text?: string }) {
  return (
    <div className="flex flex-col items-center justify-center rounded-[14px] border border-dashed border-line px-6 py-14 text-center">
      {icon && <div className="mb-3 flex h-11 w-11 items-center justify-center rounded-full border border-line text-ink-2">{icon}</div>}
      <div className="text-sm font-medium text-ink">{title}</div>
      {text && <div className="mt-1 max-w-sm text-[13px] text-ink-2">{text}</div>}
    </div>
  );
}

// A small grey line for "Loading...".
export function Loading({ children }: { children: ReactNode }) {
  return <p className="m-0 text-sm text-ink-3">{children}</p>;
}

// ---------- PageHeader ----------

// The classes of a page: centred, with a max width and generous space.
export const PAGE = "mx-auto w-full max-w-6xl px-8 pt-8 pb-16";

// The big title of a page, with its buttons on the right.
export function PageHeader({ title, children }: { title: ReactNode; children?: ReactNode }) {
  return (
    <div className="mb-8 flex flex-wrap items-center justify-between gap-4">
      <h1 className="m-0 text-[28px] leading-tight font-medium tracking-[-0.02em] text-ink">{title}</h1>
      {children && <div className="flex flex-wrap items-center gap-2">{children}</div>}
    </div>
  );
}

// A section title inside a page.
export const SECTION_TITLE = "m-0 text-base font-medium text-ink";
