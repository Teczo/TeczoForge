import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import Media from "./Media";

// How often to ask the backend where the job is.
const PROGRESS_INTERVAL_MS = 500;

// The answer from GET /api/progress/<jobId> (see backend/src/progress.ts).
type Progress =
  | { state: "unknown" }
  | { state: "starting" }
  | { state: "waiting"; jobsAhead: number }
  | { state: "running"; step: number; steps: number }
  | { state: "finishing" };

// One preset from GET /api/presets (see backend/src/presets.ts).
type PresetInput = { key: string; label: string; kind: string; default?: number | string };
type Preset = { id: string; name: string; description: string; type: string; inputs: PresetInput[] };

// The form keeps every value as text, the way the input boxes give it.
type FormValues = Record<string, string>;

// Start values for a preset's form: its defaults, or empty.
function defaultValues(preset: Preset): FormValues {
  const values: FormValues = {};
  for (const input of preset.inputs) values[input.key] = input.default === undefined ? "" : String(input.default);
  return values;
}

// Turn the form values into the "inputs" the backend expects.
// Empty number and seed boxes are left out, so the backend uses the default or a random seed.
function toInputs(preset: Preset, values: FormValues): Record<string, string | number> {
  const inputs: Record<string, string | number> = {};
  for (const input of preset.inputs) {
    const value = values[input.key] ?? "";
    if (input.kind === "text") inputs[input.key] = value;
    else if (input.kind === "image" && value !== "") inputs[input.key] = value; // The uploaded file name.
    else if ((input.kind === "number" || input.kind === "seed") && value.trim() !== "") inputs[input.key] = Number(value);
  }
  return inputs;
}

// Values to start the form with, from "Use again" in the gallery.
export type StartValues = { presetId: string | null; inputs: Record<string, unknown> };

// The form for a preset, filled with the given values where the preset has that input.
function startFormValues(preset: Preset, start: StartValues): FormValues {
  const values = defaultValues(preset);
  for (const input of preset.inputs) {
    const value = start.inputs[input.key];
    if (value !== undefined && value !== null) values[input.key] = String(value);
  }
  return values;
}

type GenerateProps = {
  startValues?: StartValues | null;
  onStartValuesUsed?: () => void;
};

export default function Generate({ startValues = null, onStartValuesUsed }: GenerateProps) {
  const [presets, setPresets] = useState<Preset[] | null>(null);
  const [presetsError, setPresetsError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [presetId, setPresetId] = useState("");
  const [values, setValues] = useState<FormValues>({});
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);

  // Load the presets once, when the page opens. A new preset folder shows up after a refresh.
  useEffect(() => {
    async function loadPresets() {
      try {
        const response = await fetch("/api/presets");
        const body = await response.json().catch(() => null);
        if (!body) {
          setPresetsError("Could not reach the backend. Make sure it is running, then refresh the page.");
        } else if (!response.ok) {
          setPresetsError(body.error ?? "Could not load the presets.");
        } else if (body.presets.length === 0) {
          setPresetsError("No presets found. Add a preset folder in presets/, then refresh the page.");
        } else {
          const list: Preset[] = body.presets;
          setPresets(list);
          // "Use again": start with that job's preset and values, if the preset still exists.
          const startPreset = startValues && list.find((p) => p.id === startValues.presetId);
          if (startValues && startPreset) {
            setPresetId(startPreset.id);
            setValues(startFormValues(startPreset, startValues));
            setNotice(`Filled in from the gallery. Press Generate to make it again.`);
          } else {
            setPresetId(list[0].id);
            setValues(defaultValues(list[0]));
            if (startValues) setNotice(`The preset "${startValues.presetId}" no longer exists, so nothing was filled in.`);
          }
          if (startValues) onStartValuesUsed?.();
        }
      } catch {
        setPresetsError("Could not reach the backend. Make sure it is running, then refresh the page.");
      }
    }
    loadPresets();
  }, []);

  const preset = presets?.find((p) => p.id === presetId) ?? null;

  function choosePreset(id: string) {
    const chosen = presets?.find((p) => p.id === id);
    if (!chosen) return;
    setPresetId(id);
    setValues(defaultValues(chosen));
    setNotice(null);
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (!preset) return;
    setRunning(true);
    setProgress(null);
    setError(null);
    setWarning(null);
    setImageUrl(null);

    // Give the job an id, so we can ask the backend about it while we wait.
    const jobId = crypto.randomUUID();
    let finished = false;
    const timer = setInterval(async () => {
      try {
        const response = await fetch(`/api/progress/${jobId}`);
        const answer: Progress = await response.json();
        if (response.ok && !finished) setProgress(answer);
      } catch {
        // Missing one update is fine. The next one comes soon.
      }
    }, PROGRESS_INTERVAL_MS);

    try {
      const response = await fetch("/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ presetId: preset.id, inputs: toInputs(preset, values), jobId }),
      });
      // The backend always answers with JSON. If not, the backend is not running.
      const body = await response.json().catch(() => null);

      if (!body) {
        setError("Could not reach the backend. Make sure it is running, then try again.");
      } else if (!response.ok) {
        setError(body.error ?? "Something went wrong. Please try again.");
      } else {
        setImageUrl(body.imageUrl);
      }
      // For example: the image was made, but the job history (MongoDB) is offline.
      if (body?.warning) setWarning(body.warning);
    } catch {
      setError("Could not reach the backend. Make sure it is running, then try again.");
    } finally {
      finished = true;
      clearInterval(timer);
      setProgress(null);
      setRunning(false);
    }
  }

  if (presetsError) return <p style={{ color: "red" }}>{presetsError}</p>;
  if (!presets || !preset) return <p>Loading presets...</p>;

  // Every text input (like the prompt) and every image must be filled in.
  const missingRequired = preset.inputs.some(
    (input) => (input.kind === "text" || input.kind === "image") && (values[input.key] ?? "").trim() === "",
  );
  const firstText = preset.inputs.find((input) => input.kind === "text");

  return (
    <section>
      <h2>Generate</h2>
      {notice && <p style={{ color: "steelblue" }}>{notice}</p>}
      <form onSubmit={handleSubmit} style={{ maxWidth: 600 }}>
        <label style={{ display: "block", marginBottom: 12 }}>
          <strong>Preset</strong>
          <select
            value={presetId}
            onChange={(event) => choosePreset(event.target.value)}
            disabled={running}
            style={{ display: "block", marginTop: 4 }}
          >
            {presets.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          {preset.description && <small>{preset.description}</small>}
        </label>

        {preset.inputs.map((input) => (
          <Field
            key={`${preset.id}/${input.key}`}
            input={input}
            value={values[input.key] ?? ""}
            disabled={running}
            // Use the latest values: an image upload can finish after the user typed something else.
            onChange={(value) => setValues((current) => ({ ...current, [input.key]: value }))}
          />
        ))}

        <button type="submit" disabled={running || missingRequired}>
          {running ? "Generating..." : "Generate"}
        </button>
      </form>

      {running && <ProgressView progress={progress} />}
      {error && <p style={{ color: "red" }}>{error}</p>}
      {warning && <p style={{ color: "darkorange" }}>Warning: {warning}</p>}
      {imageUrl && (
        <Media
          url={imageUrl}
          mode="full"
          alt={firstText ? values[firstText.key] : preset.name}
          style={{ display: "block", maxWidth: "100%", width: 600, marginTop: 16 }}
        />
      )}
    </section>
  );
}

// One input of the form. Which box it is depends on "kind" in preset.json.
function Field(props: { input: PresetInput; value: string; disabled: boolean; onChange: (value: string) => void }) {
  const { input, value, disabled, onChange } = props;
  const boxStyle = { display: "block", width: "100%", marginTop: 4 };

  let box;
  if (input.kind === "text") {
    box = (
      <textarea
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder="Describe the image, for example: a red car by the sea at sunset"
        rows={4}
        disabled={disabled}
        style={boxStyle}
      />
    );
  } else if (input.kind === "number" || input.kind === "seed") {
    box = (
      <input
        type="number"
        step={1}
        min={input.kind === "seed" ? 0 : 1}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={input.kind === "seed" ? "Empty = random" : ""}
        disabled={disabled}
        style={{ ...boxStyle, width: 200 }}
      />
    );
  } else if (input.kind === "image") {
    box = <ImageBox value={value} disabled={disabled} onChange={onChange} />;
  } else {
    // A kind this page does not know yet.
    box = <small style={{ display: "block", color: "gray" }}>This input type ("{input.kind}") is not supported yet.</small>;
  }

  return (
    <label style={{ display: "block", marginBottom: 12 }}>
      <strong>{input.label}</strong>
      {box}
    </label>
  );
}

// Same limits as the backend (backend/src/upload.ts).
const IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp"];
const MAX_UPLOAD_MB = 20;

// An image input: pick a picture, upload it straight away, show a small preview.
// The value is the file name the backend gives back. It stays empty until the upload is done.
function ImageBox(props: { value: string; disabled: boolean; onChange: (value: string) => void }) {
  const { value, disabled, onChange } = props;
  const [preview, setPreview] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);

  async function handlePick(file: File | undefined) {
    if (!file) return;
    onChange("");
    setUploadError(null);
    setPreview(URL.createObjectURL(file)); // Shown from this PC; nothing is uploaded for the preview.

    if (!IMAGE_TYPES.includes(file.type)) {
      setUploadError("Pick a PNG, JPEG or WebP image.");
      return;
    }
    if (file.size > MAX_UPLOAD_MB * 1024 * 1024) {
      setUploadError(`This file is too big. The limit is ${MAX_UPLOAD_MB} MB.`);
      return;
    }

    setUploading(true);
    try {
      const response = await fetch("/api/upload", {
        method: "POST",
        headers: { "Content-Type": file.type },
        body: file,
      });
      const body = await response.json().catch(() => null);
      if (!body) setUploadError("Could not reach the backend. Make sure it is running, then try again.");
      else if (!response.ok) setUploadError(body.error ?? "The upload did not work. Please try again.");
      else onChange(body.name);
    } catch {
      setUploadError("Could not reach the backend. Make sure it is running, then try again.");
    } finally {
      setUploading(false);
    }
  }

  return (
    <span style={{ display: "block", marginTop: 4 }}>
      <input
        type="file"
        accept={IMAGE_TYPES.join(",")}
        disabled={disabled || uploading}
        onChange={(event) => handlePick(event.target.files?.[0])}
      />
      {uploading && <small style={{ display: "block" }}>Uploading...</small>}
      {uploadError && <small style={{ display: "block", color: "red" }}>{uploadError}</small>}
      {preview && <img src={preview} alt="Chosen picture" style={{ display: "block", maxWidth: 200, marginTop: 4 }} />}
      {/* From "Use again": the picture is already uploaded, so there is no preview here. */}
      {!preview && value && <small style={{ display: "block" }}>Using the picture from the gallery job ({value}).</small>}
    </span>
  );
}

// Shows where the job is: waiting in the queue, a progress bar, or saving.
function ProgressView({ progress }: { progress: Progress | null }) {
  if (progress?.state === "waiting") {
    const ahead = progress.jobsAhead === 1 ? "1 job" : `${progress.jobsAhead} jobs`;
    return <p>Waiting in the queue: {ahead} ahead of yours.</p>;
  }
  if (progress?.state === "running" && progress.steps > 0) {
    return (
      <p>
        <progress value={progress.step} max={progress.steps} style={{ width: 300, verticalAlign: "middle" }} /> Step{" "}
        {progress.step} of {progress.steps}
      </p>
    );
  }
  // Running, but no steps yet: ComfyUI is loading the model (slow only the first time).
  if (progress?.state === "running") return <p>Starting...</p>;
  if (progress?.state === "finishing") return <p>Saving the result...</p>;
  return <p>Sending your job to ComfyUI...</p>;
}
