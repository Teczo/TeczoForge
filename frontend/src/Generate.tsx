import { useEffect, useRef, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import Media, { isVideo } from "./Media";
import {
  ArrowRightIcon,
  BoltIcon,
  ChevronDownIcon,
  ChevronUpIcon,
  CubeIcon,
  DownloadIcon,
  ExpandIcon,
  GearIcon,
  ImageIcon,
  ImageToVideoIcon,
  LayersIcon,
  MonitorIcon,
  PaperclipIcon,
  PencilIcon,
  PlayIcon,
  PresetsIcon,
  ShuffleIcon,
  SparklesIcon,
  UploadIcon,
  UpscaleIcon,
  VideoIcon,
} from "./Icons";

// How often to ask the backend where the job is.
const PROGRESS_INTERVAL_MS = 1500;

// The prompt can be this long. Same limit as the backend (backend/src/presets.ts).
const MAX_TEXT_LENGTH = 2000;

// Where a job is now, from GET /api/jobs/<id> (see backend/src/jobs.ts).
type Progress =
  | { state: "waiting"; jobsAhead: number }
  | { state: "running"; step: number; steps: number }
  | { state: "finishing" };

// The answer from GET /api/jobs/<id>. Only the parts this page uses.
type JobAnswer = {
  status: "queued" | "running" | "done" | "failed" | "cancelled";
  inputs: Record<string, unknown>;
  imageUrl: string | null;
  error: string | null;
  progress: Progress | null;
  warning?: string;
};

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

function hasImageInput(preset: Preset): boolean {
  return preset.inputs.some((input) => input.kind === "image");
}

// The groups in the left menu. A preset goes into the first group it matches.
// A group with no presets is shown as "Soon". So a new preset folder with, for example,
// "type": "upscale" turns on the Upscale item by itself, with no code change.
type Category = { id: string; label: string; Icon: (p: { size?: number }) => ReactNode; matches: (p: Preset) => boolean };
const CATEGORIES: Category[] = [
  { id: "image", label: "Image", Icon: ImageIcon, matches: (p) => p.type === "image" },
  { id: "video", label: "Video", Icon: VideoIcon, matches: (p) => p.type === "video" && !hasImageInput(p) },
  { id: "image-to-video", label: "Image to Video", Icon: ImageToVideoIcon, matches: (p) => p.type === "video" && hasImageInput(p) },
  { id: "3d", label: "3D", Icon: CubeIcon, matches: (p) => p.type === "3d" },
  { id: "edit", label: "Edit / Inpaint", Icon: PencilIcon, matches: (p) => p.type === "edit" },
  { id: "upscale", label: "Upscale", Icon: UpscaleIcon, matches: (p) => p.type === "upscale" },
];
// Presets with a type none of the groups above know. Only shown when there are some.
const OTHER: Category = { id: "other", label: "Other", Icon: SparklesIcon, matches: () => true };

function categoryOf(preset: Preset): Category {
  return CATEGORIES.find((c) => c.matches(preset)) ?? OTHER;
}

// The preset a group starts with: one that needs no picture if there is one
// (so Image starts on Text to Image), else the first.
function firstPresetOf(category: Category, presets: Preset[]): Preset | undefined {
  const inGroup = presets.filter((p) => categoryOf(p) === category);
  return inGroup.find((p) => !hasImageInput(p)) ?? inGroup[0];
}

// The models in the left menu. Only for show: the preset decides which model really runs.
// A model is highlighted when it belongs to the chosen group. Models with no group are "Soon".
type Model = { name: string; note: string; colors: string; categories: string[] };
const MODELS: Model[] = [
  { name: "Z-Image-Turbo", note: "Fast & Detailed", colors: "#0f5f4a, #1c9d6b", categories: ["image"] },
  { name: "Wan 2.2", note: "Image to Video", colors: "#123a6b, #1e9bff", categories: ["image-to-video"] },
  { name: "Flux", note: "High Quality", colors: "#5b3a1a, #c98a3e", categories: [] },
  { name: "SDXL", note: "Versatile", colors: "#4a2a6b, #e0758a", categories: [] },
  { name: "Playground", note: "Creative", colors: "#2a1a6b, #8a5cff", categories: [] },
  { name: "Custom (ComfyUI)", note: "Your workflows", colors: "#1a3a4a, #4a8aa0", categories: [] },
];

// The Quick Prompts cards. Not working yet ("Soon").
const QUICK_PROMPTS = [
  { label: "Cinematic Landscape", colors: "#1e4d6b, #d9a35c" },
  { label: "Futuristic City", colors: "#3a1a6b, #1ec8ff" },
  { label: "Product Render", colors: "#1a1f26, #4a5a6a" },
  { label: "Anime Character", colors: "#6b1a5a, #b98cff" },
  { label: "Interior Design", colors: "#6b5a3a, #e8d8b8" },
];

// A finished result shown on the right: made just now, or from the job history.
type Result = { url: string; alt: string };

// How many recent results to show under the large picture.
const RECENT_COUNT = 10;

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
  const [submitting, setSubmitting] = useState(false);
  // My unfinished jobs, oldest first. The page follows the first one, then the next.
  const [jobIds, setJobIds] = useState<string[]>([]);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [shown, setShown] = useState<Result | null>(null);
  const [recent, setRecent] = useState<Result[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(true);
  const stageRef = useRef<HTMLDivElement>(null);

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
            // Start with the first Image preset, like the top item of the left menu.
            const first = firstPresetOf(CATEGORIES[0], list) ?? list[0];
            setPresetId(first.id);
            setValues(defaultValues(first));
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

  // Load the latest results for the row under the large picture. If the job history
  // (MongoDB) is offline, the row stays empty. Generating still works.
  useEffect(() => {
    async function loadRecent() {
      try {
        const response = await fetch(`/api/jobs?status=done&limit=${RECENT_COUNT}`);
        if (!response.ok) return;
        const body: { jobs: { imageUrl: string | null; inputs: Record<string, unknown> }[] } = await response.json();
        const results: Result[] = body.jobs
          .filter((job) => job.imageUrl)
          .map((job) => ({ url: job.imageUrl!, alt: String(job.inputs.prompt ?? "") }));
        setRecent(results);
        setShown((current) => current ?? results[0] ?? null);
      } catch {
        // No history to show. That is fine.
      }
    }
    loadRecent();
  }, []);

  // After a page refresh: find my jobs that are still waiting or running, and follow them.
  useEffect(() => {
    async function loadActiveJobs() {
      try {
        const response = await fetch("/api/jobs?status=active&mine=1");
        if (!response.ok) return;
        const body: { jobs: { id: string }[] } = await response.json();
        // The backend sends newest first. Follow the oldest first.
        const ids = body.jobs.map((job) => job.id).reverse();
        setJobIds((current) => [...ids.filter((id) => !current.includes(id)), ...current]);
      } catch {
        // Nothing to follow. That is fine.
      }
    }
    loadActiveJobs();
  }, []);

  // Follow the first unfinished job: ask the backend about it until it is done or failed.
  const currentJobId = jobIds[0] ?? null;
  useEffect(() => {
    if (!currentJobId) return;
    let stopped = false;

    function stopFollowing() {
      setJobIds((current) => current.filter((id) => id !== currentJobId));
      setProgress(null);
    }

    async function check() {
      try {
        const response = await fetch(`/api/jobs/${currentJobId}`);
        // No JSON: the backend is not answering right now. Try again next time.
        const body: JobAnswer | null = await response.json().catch(() => null);
        if (stopped || !body) return;

        if (!response.ok) {
          setError(body.error ?? "Could not follow the job.");
          stopFollowing();
          return;
        }
        // For example: the job was made, but the job history (MongoDB) is offline.
        if (body.warning) setWarning(body.warning);
        if (body.status === "cancelled") {
          setNotice("The job was cancelled.");
          stopFollowing();
        } else if (body.status === "done" && body.imageUrl) {
          const result = { url: body.imageUrl, alt: String(body.inputs.prompt ?? "") };
          setShown(result);
          setRecent((current) => [result, ...current.filter((r) => r.url !== result.url)].slice(0, RECENT_COUNT));
          stopFollowing();
        } else if (body.status === "done" || body.status === "failed") {
          setError(body.error ?? "The job failed.");
          stopFollowing();
        } else {
          setProgress(body.progress);
        }
      } catch {
        // Missing one update is fine. The next one comes soon.
      }
    }

    check();
    const timer = setInterval(check, PROGRESS_INTERVAL_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [currentJobId]);

  const running = submitting || jobIds.length > 0;

  // Cancel the job the page is following. A running job asks first, because its work is lost.
  async function handleCancel() {
    if (!currentJobId) return;
    if (progress?.state === "running" && !window.confirm("Stop this job? The work done so far is lost.")) return;
    setCancelling(true);
    try {
      const response = await fetch(`/api/jobs/${currentJobId}/cancel`, { method: "POST" });
      const body = await response.json().catch(() => null);
      if (!body) setError("Could not reach the backend. Make sure it is running, then try again.");
      else if (!response.ok) setError(body.error ?? "Could not cancel the job.");
      // If it worked, the next check sees "cancelled" and stops following the job.
    } catch {
      setError("Could not reach the backend. Make sure it is running, then try again.");
    } finally {
      setCancelling(false);
    }
  }

  const preset = presets?.find((p) => p.id === presetId) ?? null;

  function choosePreset(id: string) {
    const chosen = presets?.find((p) => p.id === id);
    if (!chosen) return;
    setPresetId(id);
    setValues(defaultValues(chosen));
    setNotice(null);
  }

  // Start the job. The backend answers at once with its id; the effect above follows it.
  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (!preset) return;
    setSubmitting(true);
    setProgress(null);
    setError(null);
    setWarning(null);

    try {
      const response = await fetch("/api/jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ presetId: preset.id, inputs: toInputs(preset, values) }),
      });
      // The backend always answers with JSON. If not, the backend is not running.
      const body = await response.json().catch(() => null);

      if (!body) {
        setError("Could not reach the backend. Make sure it is running, then try again.");
      } else if (!response.ok) {
        setError(body.error ?? "Something went wrong. Please try again.");
      } else {
        setJobIds((current) => [...current, body.jobId]);
      }
      // For example: the job was started, but the job history (MongoDB) is offline.
      if (body?.warning) setWarning(body.warning);
    } catch {
      setError("Could not reach the backend. Make sure it is running, then try again.");
    } finally {
      setSubmitting(false);
    }
  }

  if (presetsError) {
    return (
      <div className="page">
        <p className="message error">{presetsError}</p>
      </div>
    );
  }
  if (!presets || !preset) return <div className="page empty">Loading presets...</div>;

  const category = categoryOf(preset);
  const categoryPresets = presets.filter((p) => categoryOf(p) === category);
  const hasOther = presets.some((p) => categoryOf(p) === OTHER);

  // Switch group: start with its first preset.
  function chooseCategory(next: Category) {
    const first = firstPresetOf(next, presets!);
    if (first && next !== category) choosePreset(first.id);
  }

  // The paperclip: pick a picture. If this preset takes no picture, switch to one
  // in the same group that does (for example from Text to Image to Image to Image).
  const imageInput = preset.inputs.find((input) => input.kind === "image");
  const presetWithImage = categoryPresets.find(hasImageInput);
  function attachImage() {
    if (imageInput) document.getElementById(`upload-${imageInput.key}`)?.click();
    else if (presetWithImage) choosePreset(presetWithImage.id);
  }

  const textInputs = preset.inputs.filter((input) => input.kind === "text");
  const imageInputs = preset.inputs.filter((input) => input.kind === "image");
  // Advanced Settings, in the mockup's order: size (and other numbers), then Steps, then the seed.
  const seedInputs = preset.inputs.filter((input) => input.kind === "seed");
  const numberInputs = preset.inputs.filter((input) => !["text", "image", "seed"].includes(input.kind));
  const prompt = textInputs[0];
  const promptLength = prompt ? (values[prompt.key] ?? "").length : 0;

  // Every text input (like the prompt) and every image must be filled in.
  const missingRequired = preset.inputs.some(
    (input) => (input.kind === "text" || input.kind === "image") && (values[input.key] ?? "").trim() === "",
  );
  const tooLong = textInputs.some((input) => (values[input.key] ?? "").length > MAX_TEXT_LENGTH);

  // Use the latest values: an image upload can finish after the user typed something else.
  const setValue = (key: string) => (value: string) => setValues((current) => ({ ...current, [key]: value }));

  const shownIsVideo = shown ? isVideo(shown.url) : preset.type === "video";

  return (
    <div className="studio">
      <aside className="sidebar">
        <h3>Create</h3>
        <div className="side-list">
          {[...CATEGORIES, ...(hasOther ? [OTHER] : [])].map((c) => {
            const available = presets.some((p) => categoryOf(p) === c);
            return (
              <button
                key={c.id}
                className={`side-item ${c === category ? "active" : ""}`}
                onClick={() => chooseCategory(c)}
                disabled={!available || running}
                title={available ? undefined : "Coming soon"}
              >
                <c.Icon size={22} />
                {c.label}
                {!available && <span className="soon">Soon</span>}
              </button>
            );
          })}
        </div>
        <hr />
        <div className="models">
          <h3>Models</h3>
          {MODELS.map((model) => {
            const soon = model.categories.length === 0;
            const active = model.categories.includes(category.id);
            return (
              <div key={model.name} className={`model ${active ? "active" : ""} ${soon ? "disabled" : ""}`}>
                <div className="model-thumb" style={{ background: `linear-gradient(135deg, ${model.colors})` }}>
                  <SparklesIcon size={22} />
                </div>
                <div className="model-text">
                  <div className="model-name">{model.name}</div>
                  <div className="model-note">{model.note}</div>
                </div>
                {active && <span className="badge">In use</span>}
                {soon && <span className="soon">Soon</span>}
              </div>
            );
          })}
        </div>
      </aside>

      <form className="create panel" onSubmit={handleSubmit}>
        <div className="create-section">
          <div className="section-head">
            <SparklesIcon size={24} />
            <h2>Describe your imagination...</h2>
            <div className="right">
              <button type="button" className="ghost-button" disabled title="Coming soon">
                <PresetsIcon size={18} /> Presets <span className="soon">Soon</span>
              </button>
            </div>
          </div>

          {notice && <p className="message info">{notice}</p>}

          {imageInputs.map((input) => (
            <ImageBox
              key={`${preset.id}/${input.key}`}
              input={input}
              value={values[input.key] ?? ""}
              disabled={running}
              onChange={setValue(input.key)}
            />
          ))}

          {textInputs.map((input, index) => (
            <textarea
              key={`${preset.id}/${input.key}`}
              className="prompt-box"
              aria-label={input.label}
              value={values[input.key] ?? ""}
              onChange={(event) => setValue(input.key)(event.target.value)}
              placeholder={
                index > 0
                  ? input.label
                  : preset.type === "video"
                    ? "Describe the motion, for example: the camera slowly zooms in while leaves blow past"
                    : "Describe the image, for example: a red car by the sea at sunset"
              }
              disabled={running}
              style={index > 0 ? { marginTop: 12, minHeight: 80 } : undefined}
            />
          ))}

          <div className="prompt-tools">
            <button
              type="button"
              className="icon-button"
              onClick={attachImage}
              disabled={running || (!imageInput && !presetWithImage)}
              title={imageInput || presetWithImage ? "Add a picture" : "No preset in this group takes a picture"}
            >
              <PaperclipIcon size={19} />
            </button>
            <div className="select-wrap">
              {preset.type === "video" ? <VideoIcon size={18} /> : <ImageIcon size={18} />}
              <select
                className="select"
                value={presetId}
                onChange={(event) => choosePreset(event.target.value)}
                disabled={running}
                aria-label="Preset"
              >
                {categoryPresets.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
              <ChevronDownIcon size={18} />
            </div>
            {prompt && (
              <span className={`char-count ${promptLength > MAX_TEXT_LENGTH ? "over" : ""}`}>
                {promptLength}/{MAX_TEXT_LENGTH}
              </span>
            )}
          </div>
          {preset.description && <p className="preset-note">{preset.description}</p>}
        </div>

        <div className="create-section">
          <div className="section-head">
            <BoltIcon size={22} />
            <h3>Quick Prompts</h3>
            <span className="soon" style={{ marginLeft: 0 }}>
              Soon
            </span>
            <div className="right">
              <button type="button" className="ghost-button" disabled title="Coming soon">
                View more <ArrowRightIcon size={16} />
              </button>
            </div>
          </div>
          <div className="quick-grid">
            {QUICK_PROMPTS.map((q) => (
              <button key={q.label} type="button" className="quick-card" disabled title="Coming soon">
                <div className="quick-art" style={{ background: `linear-gradient(135deg, ${q.colors})` }}>
                  <ImageIcon size={22} />
                </div>
                <span>{q.label}</span>
              </button>
            ))}
          </div>
        </div>

        <div className="create-section">
          <button
            type="button"
            className="collapse-head"
            onClick={() => setShowSettings(!showSettings)}
            aria-expanded={showSettings}
          >
            <GearIcon size={22} />
            <h3>Advanced Settings</h3>
            {showSettings ? <ChevronUpIcon size={20} /> : <ChevronDownIcon size={20} />}
          </button>
          {showSettings && (
            <div className="settings-grid">
              {numberInputs.map((input) => (
                <Field
                  key={`${preset.id}/${input.key}`}
                  input={input}
                  value={values[input.key] ?? ""}
                  disabled={running}
                  onChange={setValue(input.key)}
                />
              ))}
              <div>
                <span className="field-label">
                  Steps <span className="soon">Soon</span>
                </span>
                <div className="field-row">
                  <LayersIcon size={22} />
                  <div className="select-wrap" style={{ flex: 1 }}>
                    <select className="select" disabled style={{ width: "100%", paddingLeft: 12 }} title="Coming soon">
                      <option>Set by the preset</option>
                    </select>
                    <ChevronDownIcon size={18} />
                  </div>
                </div>
              </div>
              {seedInputs.map((input) => (
                <Field
                  key={`${preset.id}/${input.key}`}
                  input={input}
                  value={values[input.key] ?? ""}
                  disabled={running}
                  onChange={setValue(input.key)}
                />
              ))}
            </div>
          )}
        </div>

        <div className="generate-wrap">
          {error && <p className="message error">{error}</p>}
          {warning && <p className="message warning">Warning: {warning}</p>}
          <button type="submit" className="generate-button" disabled={running || missingRequired || tooLong}>
            <SparklesIcon size={26} />
            {running ? "Generating..." : "Generate"}
          </button>
        </div>
      </form>

      <section className="result panel">
        <div className="section-head">
          {shownIsVideo ? <VideoIcon size={22} /> : <ImageIcon size={22} />}
          <h2>{shownIsVideo ? "Generated Video" : "Generated Image"}</h2>
          <div className="right">
            {shown && (
              <a className="icon-button" href={shown.url} download title="Download">
                <DownloadIcon size={19} />
              </a>
            )}
            <button
              type="button"
              className="icon-button"
              onClick={() => stageRef.current?.requestFullscreen()}
              disabled={!shown}
              title="Full screen"
            >
              <ExpandIcon size={19} />
            </button>
          </div>
        </div>

        <div className="stage" ref={stageRef}>
          {shown ? (
            <Media key={shown.url} url={shown.url} mode="full" alt={shown.alt} />
          ) : (
            <div className="stage-empty">
              <ImageIcon size={56} />
              <div>Your result will show up here.</div>
            </div>
          )}
          {running && (
            <div className="stage-overlay">
              <ProgressView
                progress={progress}
                onCancel={currentJobId ? handleCancel : null}
                cancelling={cancelling}
              />
            </div>
          )}
        </div>

        {recent.length > 0 && (
          <div className="strip">
            {recent.map((result) => (
              <button
                key={result.url}
                className={shown?.url === result.url ? "active" : ""}
                onClick={() => setShown(result)}
                title={result.alt}
              >
                <Media url={result.url} mode="thumbnail" alt={result.alt} />
                {isVideo(result.url) && (
                  <span className="video-tag">
                    <PlayIcon size={10} /> Video
                  </span>
                )}
              </button>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

// One number or seed input in Advanced Settings. Which box it is depends on "kind" in preset.json.
function Field(props: { input: PresetInput; value: string; disabled: boolean; onChange: (value: string) => void }) {
  const { input, value, disabled, onChange } = props;

  let box;
  if (input.kind === "seed") {
    box = (
      <div className="field-row">
        <CubeIcon size={22} />
        <div className="input-with-button">
          <input
            className="input"
            type="number"
            step={1}
            min={0}
            value={value}
            onChange={(event) => onChange(event.target.value)}
            placeholder="Random"
            disabled={disabled}
          />
          {/* Empty the box: the backend then picks a random seed. */}
          <button type="button" onClick={() => onChange("")} disabled={disabled} title="Use a random seed">
            <ShuffleIcon size={18} />
          </button>
        </div>
      </div>
    );
  } else if (input.kind === "number") {
    box = (
      <div className="field-row">
        <MonitorIcon size={22} />
        <input
          className="input"
          type="number"
          step={1}
          min={1}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          disabled={disabled}
        />
      </div>
    );
  } else {
    // A kind this page does not know yet.
    box = <small className="upload-hint">This input type ("{input.kind}") is not supported yet.</small>;
  }

  return (
    <label>
      <span className="field-label">{input.label}</span>
      {box}
    </label>
  );
}

// Same limits as the backend (backend/src/upload.ts).
const IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp"];
const MAX_UPLOAD_MB = 20;

// An image input: pick a picture, upload it straight away, show a small preview.
// The value is the file name the backend gives back. It stays empty until the upload is done.
function ImageBox(props: { input: PresetInput; value: string; disabled: boolean; onChange: (value: string) => void }) {
  const { input, value, disabled, onChange } = props;
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

  let hint;
  if (uploadError) hint = <span className="upload-hint error">{uploadError}</span>;
  else if (uploading) hint = <span className="upload-hint">Uploading...</span>;
  // From "Use again": the picture is already uploaded, so there is no preview here.
  else if (value && !preview) hint = <span className="upload-hint">Using the picture from the gallery job ({value}). Click to change it.</span>;
  else if (value) hint = <span className="upload-hint">Ready. Click to pick another picture.</span>;
  else hint = <span className="upload-hint">Click to pick a PNG, JPEG or WebP picture (up to {MAX_UPLOAD_MB} MB).</span>;

  return (
    <label className={`upload ${disabled || uploading ? "disabled" : ""}`}>
      <input
        id={`upload-${input.key}`}
        type="file"
        accept={IMAGE_TYPES.join(",")}
        disabled={disabled || uploading}
        onChange={(event) => handlePick(event.target.files?.[0])}
      />
      {preview ? (
        <img className="upload-thumb" src={preview} alt="Chosen picture" />
      ) : (
        <span className="upload-thumb">
          <UploadIcon size={24} />
        </span>
      )}
      <span>
        <span className="upload-label">{input.label}</span>
        <br />
        {hint}
      </span>
    </label>
  );
}

// Shows where the job is: waiting in the queue, a progress bar, or saving.
// Cancel is shown once the job has an id, and not while the result is being saved.
type ProgressViewProps = { progress: Progress | null; onCancel: (() => void) | null; cancelling: boolean };
function ProgressView({ progress, onCancel, cancelling }: ProgressViewProps) {
  let text = "Sending your job to ComfyUI...";
  let percent: number | null = null;
  if (progress?.state === "waiting") {
    const ahead = progress.jobsAhead === 1 ? "1 job" : `${progress.jobsAhead} jobs`;
    text = `Waiting in the queue: ${ahead} ahead of yours.`;
  } else if (progress?.state === "running" && progress.steps > 0) {
    text = `Step ${progress.step} of ${progress.steps}`;
    percent = (progress.step / progress.steps) * 100;
  } else if (progress?.state === "running") {
    // Running, but no steps yet: ComfyUI is loading the model (slow only the first time).
    text = "Starting...";
  } else if (progress?.state === "finishing") {
    text = "Saving the result...";
    percent = 100;
  }

  return (
    <div className="progress-card">
      {percent === null ? (
        <div className="spinner" />
      ) : (
        <div className="progress-bar">
          <div style={{ width: `${percent}%` }} />
        </div>
      )}
      <p>{text}</p>
      {onCancel && progress?.state !== "finishing" && (
        <button type="button" className="button" onClick={onCancel} disabled={cancelling}>
          {cancelling ? "Cancelling..." : "Cancel"}
        </button>
      )}
    </div>
  );
}
