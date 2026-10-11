// Licence badge and "Test" label of a preset (FRG-32), from "clientWork", "licenceNote",
// "licence" and "experimental" in preset.json. Used on the Generate page, the board and the gallery.

// Only the preset fields these helpers need.
type PresetInfo = {
  name: string;
  licence?: string;
  clientWork?: "yes" | "no" | "conditions" | null;
  licenceNote?: string;
  experimental?: boolean;
};

const BADGES = {
  yes: { text: "Client work OK", className: "ok" },
  conditions: { text: "Check licence", className: "check" },
  no: { text: "Research only", className: "research" },
};

// The badge, plus the note for "Check licence", plus "Test" for an experimental preset.
// Nothing for a preset that says neither.
export default function PresetBadges({ preset }: { preset: PresetInfo }) {
  const badge = preset.clientWork ? BADGES[preset.clientWork] : null;
  if (!badge && !preset.experimental) return null;
  const tooltip = [preset.licence && `Licence: ${preset.licence}`, preset.licenceNote].filter(Boolean).join(". ");
  return (
    <span className="preset-badges">
      {badge && (
        <span className={`licence-badge ${badge.className}`} title={tooltip || undefined}>
          {badge.text}
        </span>
      )}
      {preset.clientWork === "conditions" && preset.licenceNote && <span className="licence-note">{preset.licenceNote}</span>}
      {preset.experimental && (
        <span className="test-label" title="This preset is still being tested.">
          Test
        </span>
      )}
    </span>
  );
}

// Before running a "Research only" preset: ask once. Returns true if it may run.
export function confirmResearchOnly(preset: PresetInfo | undefined | null): boolean {
  if (preset?.clientWork !== "no") return true;
  const note = preset.licenceNote ? `\n\n${preset.licenceNote}` : "";
  return window.confirm(
    `"${preset.name}" is Research only: its licence does not allow client work.${note}\n\nRun it anyway?`,
  );
}

// A run time in words, for example "about 4 min 30 s" or "about 20 s".
export function formatSeconds(seconds: number): string {
  if (seconds < 60) return `about ${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest === 0 ? `about ${minutes} min` : `about ${minutes} min ${rest} s`;
}
