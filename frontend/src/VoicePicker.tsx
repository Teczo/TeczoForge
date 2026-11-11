import { useEffect, useState } from "react";
import type { DragEvent } from "react";
import { Music, Trash2, Upload } from "lucide-react";
import type { PresetInput } from "./Generate";

// The voice for an "audio" input (FRG-86): pick or drop a file, upload it straight away, then show
// its name and length with a player. Same limits as the backend (backend/src/upload.ts).
const AUDIO_ENDINGS = /\.(wav|mp3|flac)$/i;
const MAX_UPLOAD_MB = 20;

// The file picked here. The player plays it from this PC; only the upload goes to the backend.
type Picked = { name: string; fileName: string; seconds: number; url: string };

type VoicePickerProps = {
  input: PresetInput;
  value: string; // The file name the backend gave back. Empty until the upload is done.
  disabled: boolean;
  fitSeconds: number | null; // How much of the voice the video uses, from the preset. null: all of it.
  onChange: (value: string) => void;
};

export default function VoicePicker({ input, value, disabled, fitSeconds, onChange }: VoicePickerProps) {
  const [picked, setPicked] = useState<Picked | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);

  // Free the file's address in the browser when the file is replaced or the picker goes away.
  const pickedUrl = picked?.url;
  useEffect(() => {
    if (pickedUrl) return () => URL.revokeObjectURL(pickedUrl);
  }, [pickedUrl]);

  async function handlePick(file: File | undefined) {
    if (!file || disabled || uploading) return;
    onChange("");
    setPicked(null);
    setUploadError(null);

    if (!AUDIO_ENDINGS.test(file.name)) {
      setUploadError("Pick a WAV, MP3 or FLAC file.");
      return;
    }
    if (file.size > MAX_UPLOAD_MB * 1024 * 1024) {
      setUploadError(`This file is too big. The limit is ${MAX_UPLOAD_MB} MB.`);
      return;
    }

    setUploading(true);
    try {
      const response = await fetch("/api/upload-audio", {
        method: "POST",
        // The backend decides what the file is from its first bytes. Browsers name WAV files in
        // several ways, so the type is not sent.
        headers: { "Content-Type": "application/octet-stream" },
        body: file,
      });
      const body = await response.json().catch(() => null);
      if (!body) {
        setUploadError("Could not reach the backend. Make sure it is running, then try again.");
      } else if (!response.ok) {
        setUploadError(body.error ?? "The upload did not work. Please try again.");
      } else {
        setPicked({ name: body.name, fileName: file.name, seconds: body.seconds, url: URL.createObjectURL(file) });
        onChange(body.name);
      }
    } catch {
      setUploadError("Could not reach the backend. Make sure it is running, then try again.");
    } finally {
      setUploading(false);
    }
  }

  function handleDrop(event: DragEvent) {
    event.preventDefault();
    setDragging(false);
    handlePick(event.dataTransfer.files[0]);
  }

  function handleRemove() {
    onChange("");
    setPicked(null);
    setUploadError(null);
  }

  // value can also come from "Use again": then the file was not picked here, and only its name is known.
  const current = picked !== null && picked.name === value ? picked : null;
  const locked = disabled || uploading;

  return (
    <div className="mb-3.5">
      {value ? (
        <div className="flex flex-wrap items-center gap-3.5 rounded-(--radius-sm) border border-line bg-card p-3">
          <span className="grid size-[72px] shrink-0 place-items-center rounded-lg bg-frame text-ink-2">
            <Music size={24} />
          </span>
          <div className="min-w-0 flex-1 basis-48">
            <div className="font-medium">{input.label}</div>
            <div className="truncate text-[13px] text-ink-2" title={current?.fileName ?? value}>
              {current ? `${current.fileName} · ${current.seconds.toFixed(1)} s` : `${value} · from the earlier job`}
            </div>
            <audio className="mt-2 h-9 w-full" controls preload="metadata" src={current ? current.url : `/api/inputs/${encodeURIComponent(value)}`} />
          </div>
          <button type="button" className="icon-button" onClick={handleRemove} disabled={disabled} title="Remove the voice" aria-label="Remove the voice">
            <Trash2 size={19} />
          </button>
        </div>
      ) : (
        <label
          className={`flex items-center gap-3.5 rounded-(--radius-sm) border border-dashed bg-card p-3 ${
            dragging ? "border-accent" : "border-line hover:border-line-strong"
          } ${locked ? "cursor-not-allowed opacity-60" : "cursor-pointer"}`}
          onDragOver={(event) => {
            event.preventDefault();
            setDragging(!locked);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={handleDrop}
        >
          <input
            className="hidden"
            type="file"
            accept=".wav,.mp3,.flac"
            disabled={locked}
            onChange={(event) => {
              handlePick(event.target.files?.[0]);
              event.target.value = ""; // So the same file can be picked again.
            }}
          />
          <span className="grid size-[72px] shrink-0 place-items-center rounded-lg bg-frame text-ink-2">
            <Upload size={24} />
          </span>
          <span>
            <span className="font-medium">{input.label}</span>
            <br />
            {uploadError ? (
              <span className="text-[13px] text-danger">{uploadError}</span>
            ) : (
              <span className="text-[13px] text-ink-2">
                {uploading ? "Uploading..." : `Click or drop a WAV, MP3 or FLAC file (up to ${MAX_UPLOAD_MB} MB).`}
              </span>
            )}
          </span>
        </label>
      )}

      {current && fitSeconds !== null && current.seconds > fitSeconds && (
        // Rounded down, so it never says more of the voice is used than really is.
        <p className="message warning mt-2.5 mb-0">Only the first {(Math.floor(fitSeconds * 10) / 10).toFixed(1)} s is used.</p>
      )}
      <p className="preset-note">Use only photos and voices of people who agreed.</p>
    </div>
  );
}
