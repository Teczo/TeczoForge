import { useEffect, useRef, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import Media, { outputKind } from "./Media";
import type { OutputKind } from "./Media";
import SendToMenu, { ExtendButton } from "./SendToMenu";
import PresetBadges, { confirmResearchOnly, formatSeconds } from "./PresetBadges";
import type { Project } from "./App";
import { ArrowRight, Box, ChevronDown, ChevronUp, Download, Film, Folder, Image, Layers, Maximize, Monitor, Music, Paperclip, Pencil, Play, Scaling, Settings, Shuffle, Sparkles, Tag, Upload, Video, Zap } from "lucide-react";

// How often to ask the backend where the job is.
const PROGRESS_INTERVAL_MS = 1500;

// The prompt can be this long. Same limit as the backend (backend/src/presets.ts).
const MAX_TEXT_LENGTH = 2000;

// Where a job is now, from GET /api/jobs/<id> (see backend/src/jobs.ts).
export type Progress =
  | { state: "waiting"; jobsAhead: number }
  // stage of stages: the sampler pass (FRG-32). percent: the whole job, never goes down.
  | { state: "running"; step: number; steps: number; stage: number; stages: number; percent: number }
  | { state: "finishing" }
  | { state: "joining"; frame: number; frames: number; percent: number }; // "Join all" (FRG-55)

// The answer from GET /api/jobs/<id>. Only the parts this page uses.
type JobAnswer = {
  presetId: string | null;
  status: "draft" | "queued" | "running" | "done" | "failed" | "cancelled";
  inputs: Record<string, unknown>;
  imageUrl: string | null;
  outputKind?: string; // image, video, audio or 3d (FRG-29).
  error: string | null;
  progress: Progress | null;
  warning?: string;
};

// One preset from GET /api/presets (see backend/src/presets.ts).
// The board (Board.tsx) uses these too.
export type InputOption = { value: string | number; label: string };
export type PresetInput = {
  key: string;
  label: string;
  kind: string;
  default?: number | string;
  min?: number; // min, max and step: only on number inputs (FRG-32).
  max?: number;
  step?: number;
  options?: InputOption[]; // The allowed values, on number or text inputs (FRG-32).
  unit?: "seconds"; // A video length in seconds; the backend turns it into frames (FRG-52).
  note?: string; // One short line shown under the input (FRG-52).
};
export type Preset = {
  id: string;
  name: string;
  description: string;
  type: string;
  inputs: PresetInput[];
  sendToLabel?: string; // Name in the "Send to" menu (FRG-26). Empty: the preset name.
  // From preset.json (FRG-32). Empty or null when preset.json does not say.
  model: string;
  licence: string;
  clientWork: "yes" | "no" | "conditions" | null;
  licenceNote: string;
  experimental: boolean;
  stages: number;
  estimatedSeconds: number | null;
};

// The form keeps every value as text, the way the input boxes give it.
export type FormValues = Record<string, string>;

// Start values for a preset's form: its defaults, or empty.
export function defaultValues(preset: Preset): FormValues {
  const values: FormValues = {};
  for (const input of preset.inputs) values[input.key] = input.default === undefined ? "" : String(input.default);
  return values;
}

// Turn the form values into the "inputs" the backend expects.
// Empty number and seed boxes are left out, so the backend uses the default or a random seed.
export function toInputs(preset: Preset, values: FormValues): Record<string, string | number> {
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
// From "Send to" (FRG-26) it also has the job whose result is the start image.
// From "Extend" (FRG-54) it has the clip that the new clip continues.
export type StartValues = { presetId: string | null; inputs: Record<string, unknown>; sourceJobId?: string; parentJobId?: string };

// The note shown when the form was filled in by "Send to".
const SEND_TO_NOTICE = "Filled in from Send to, with the picture as the start image. Write the prompt, then press Generate.";
// The note shown when the form was filled in by "Extend" (FRG-54).
const EXTEND_NOTICE =
  "Filled in from Extend: the last frame of the clip is the start image, with the same prompt and a new seed. Change the prompt if you like, then press Generate.";

// "Extend" (FRG-54): the clip to continue, the preset, and the last frame in the image input.
// The new job remembers the clip only while that last frame is still the start image.
type Parent = { jobId: string; presetId: string; imageKey: string; image: string };
function parentOf(preset: Preset, start: StartValues): Parent | null {
  const imageInput = preset.inputs.find((input) => input.kind === "image");
  const image = imageInput && start.inputs[imageInput.key];
  if (!start.parentJobId || !imageInput || typeof image !== "string") return null;
  return { jobId: start.parentJobId, presetId: preset.id, imageKey: imageInput.key, image };
}

// The form for a preset, filled with the given values where the preset has that input.
export function startFormValues(preset: Preset, start: StartValues): FormValues {
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

// The usual run time, scaled by the chosen video length (FRG-52). estimatedSeconds is for the
// default length, so 7 s on a preset that takes 37 s for 5 s shows about 52 s.
function estimatedTime(preset: Preset, values: FormValues): number | null {
  if (!preset.estimatedSeconds) return null;
  const duration = preset.inputs.find((input) => input.unit === "seconds");
  const chosen = Number(values[duration?.key ?? ""]);
  if (!duration || typeof duration.default !== "number" || !chosen) return preset.estimatedSeconds;
  return Math.round((preset.estimatedSeconds * chosen) / duration.default);
}

// The groups in the left menu. A preset goes into the first group it matches.
// A group with no presets is shown as "Soon". So a new preset folder with, for example,
// "type": "upscale" turns on the Upscale item by itself, with no code change.
type Category = { id: string; label: string; Icon: (p: { size?: number }) => ReactNode; matches: (p: Preset) => boolean };
const CATEGORIES: Category[] = [
  { id: "image", label: "Image", Icon: Image, matches: (p) => p.type === "image" },
  { id: "video", label: "Video", Icon: Video, matches: (p) => p.type === "video" && !hasImageInput(p) },
  { id: "image-to-video", label: "Image to Video", Icon: Film, matches: (p) => p.type === "video" && hasImageInput(p) },
  { id: "music", label: "Music", Icon: Music, matches: (p) => p.type === "audio" }, // FRG-30
  { id: "3d", label: "3D", Icon: Box, matches: (p) => p.type === "3d" },
  { id: "edit", label: "Edit / Inpaint", Icon: Pencil, matches: (p) => p.type === "edit" },
  { id: "upscale", label: "Upscale", Icon: Scaling, matches: (p) => p.type === "upscale" },
];
// Presets with a type none of the groups above know. Only shown when there are some.
const OTHER: Category = { id: "other", label: "Other", Icon: Sparkles, matches: () => true };

function categoryOf(preset: Preset): Category {
  return CATEGORIES.find((c) => c.matches(preset)) ?? OTHER;
}

// The preset a group starts with: one that needs no picture if there is one
// (so Image starts on Text to Image), else the first.
function firstPresetOf(category: Category, presets: Preset[]): Preset | undefined {
  const inGroup = presets.filter((p) => categoryOf(p) === category);
  return inGroup.find((p) => !hasImageInput(p)) ?? inGroup[0];
}

// The models in the left menu, from the "model" field of the presets (FRG-32). Only for show:
// the preset decides which model really runs. A new model folder shows up here by itself.
// note: the groups its presets are in. colors: picked from the name, so they stay the same.
type Model = { name: string; note: string; colors: string };
function modelsOf(presets: Preset[]): Model[] {
  const names = [...new Set(presets.map((p) => p.model).filter((name) => name !== ""))];
  return names.map((name) => {
    const groups = [...new Set(presets.filter((p) => p.model === name).map((p) => categoryOf(p).label))];
    let hue = 0;
    for (const char of name) hue = (hue * 31 + char.charCodeAt(0)) % 360;
    return { name, note: groups.join(", "), colors: `hsl(${hue} 60% 22%), hsl(${(hue + 30) % 360} 65% 45%)` };
  });
}

// The Quick Prompts cards. Not working yet ("Soon").
const QUICK_PROMPTS = [
  { label: "Cinematic Landscape", colors: "#1e4d6b, #d9a35c" },
  { label: "Futuristic City", colors: "#3a1a6b, #1ec8ff" },
  { label: "Product Render", colors: "#1a1f26, #4a5a6a" },
  { label: "Anime Character", colors: "#6b1a5a, #b98cff" },
  { label: "Interior Design", colors: "#6b5a3a, #e8d8b8" },
];

// A finished result shown on the right: made just now, or from the job history.
// jobId: for "Send to" (FRG-26). kind: image, video, audio or 3d (FRG-29).
type Result = { url: string; kind: OutputKind; alt: string; jobId?: string; presetId?: string | null };

// The result panel's title for each kind of result.
const RESULT_TITLES: Record<OutputKind, string> = {
  image: "Generated Image",
  video: "Generated Video",
  audio: "Generated Audio",
  "3d": "Generated 3D Model",
};

// How many recent results to show under the large picture.
const RECENT_COUNT = 10;

type GenerateProps = {
  startValues?: StartValues | null;
  onStartValuesUsed?: () => void;
  // The project chosen in the header (FRG-41). New jobs go into it.
  // undefined while loading, null if the projects could not be loaded: then the backend uses "Unsorted".
  project?: Project | null;
};

export default function Generate({ startValues = null, onStartValuesUsed, project }: GenerateProps) {
  const [presets, setPresets] = useState<Preset[] | null>(null);
  const [presetsError, setPresetsError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // "Send to" (FRG-26): the job the start image came from, and the values it filled in.
  // The new job remembers it only while those values are still in the form.
  const [source, setSource] = useState<{ jobId: string; presetId: string; inputs: Record<string, unknown> } | null>(null);
  const [parent, setParent] = useState<Parent | null>(null);
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
            setParent(parentOf(startPreset, startValues));
            if (startValues.parentJobId) {
              setNotice(EXTEND_NOTICE);
            } else if (startValues.sourceJobId) {
              setSource({ jobId: startValues.sourceJobId, presetId: startPreset.id, inputs: startValues.inputs });
              setNotice(SEND_TO_NOTICE);
            } else {
              setNotice(`Filled in from the gallery. Press Generate to make it again.`);
            }
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
        const body: {
          jobs: { id?: string; presetId: string | null; imageUrl: string | null; outputKind?: string; inputs: Record<string, unknown> }[];
        } = await response.json();
        const results: Result[] = body.jobs
          .filter((job) => job.imageUrl)
          .map((job) => ({ url: job.imageUrl!, kind: outputKind(job), alt: String(job.inputs.prompt ?? ""), jobId: job.id, presetId: job.presetId }));
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
          const result = {
            url: body.imageUrl,
            kind: outputKind(body),
            alt: String(body.inputs.prompt ?? ""),
            jobId: currentJobId,
            presetId: body.presetId,
          };
          setShown(result);
          setRecent((current) => [result, ...current.filter((r) => r.url !== result.url)].slice(0, RECENT_COUNT));
          stopFollowing();
        } else if (body.status === "done" || body.status === "failed" || body.status === "draft") {
          // "draft": a board card whose job did not finish. It went back to the Ready column.
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

  // "Send to -> Open in Generate" or "Extend" from the result panel: fill the form.
  function openFromSendTo(start: StartValues) {
    const target = presets?.find((p) => p.id === start.presetId);
    if (!target) return;
    setPresetId(target.id);
    setValues(startFormValues(target, start));
    if (start.sourceJobId) setSource({ jobId: start.sourceJobId, presetId: target.id, inputs: start.inputs });
    setParent(parentOf(target, start));
    setNotice(start.parentJobId ? EXTEND_NOTICE : SEND_TO_NOTICE);
    setError(null);
    window.scrollTo({ top: 0 });
  }

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
    if (!preset || !confirmResearchOnly(preset)) return;
    setSubmitting(true);
    setProgress(null);
    setError(null);
    setWarning(null);

    // Made with "Send to": remember the source job while its values are still in the form.
    const fromSource =
      source !== null &&
      source.presetId === preset.id &&
      Object.entries(source.inputs).every(([key, value]) => values[key] === String(value));
    // Made with "Extend" (FRG-54): remember the clip while its last frame is still the start image.
    const fromParent = parent !== null && parent.presetId === preset.id && values[parent.imageKey] === parent.image;

    try {
      const response = await fetch("/api/jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          presetId: preset.id,
          inputs: toInputs(preset, values),
          ...(fromSource ? { sourceJobId: source!.jobId } : {}),
          ...(fromParent ? { parentJobId: parent!.jobId } : {}),
          ...(project ? { projectId: project.id } : {}),
        }),
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

  // Text inputs with a list of choices show as buttons or a dropdown, not as a text box (FRG-32).
  const textInputs = preset.inputs.filter((input) => input.kind === "text" && !input.options);
  // A video length (FRG-52) shows with these too, not in Advanced Settings.
  const choiceInputs = preset.inputs.filter((input) => (input.kind === "text" && input.options) || input.unit === "seconds");
  const imageInputs = preset.inputs.filter((input) => input.kind === "image");
  // Advanced Settings, in the mockup's order: size (and other numbers), then Steps, then the seed.
  const seedInputs = preset.inputs.filter((input) => input.kind === "seed");
  const numberInputs = preset.inputs.filter((input) => !["text", "image", "seed"].includes(input.kind) && input.unit !== "seconds");
  const estimate = estimatedTime(preset, values);
  const prompt = textInputs[0];
  const promptLength = prompt ? (values[prompt.key] ?? "").length : 0;

  // Every text input (like the prompt) and every image must be filled in.
  const missingRequired = preset.inputs.some(
    (input) => (input.kind === "text" || input.kind === "image") && (values[input.key] ?? "").trim() === "",
  );
  const tooLong = textInputs.some((input) => (values[input.key] ?? "").length > MAX_TEXT_LENGTH);

  // Use the latest values: an image upload can finish after the user typed something else.
  const setValue = (key: string) => (value: string) => setValues((current) => ({ ...current, [key]: value }));

  // What the result panel shows: the shown result's kind, or what this preset makes.
  const shownKind: OutputKind = shown ? shown.kind : outputKind({ outputKind: preset.type, imageUrl: null });

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
          {modelsOf(presets).map((model) => {
            const active = model.name === preset.model;
            return (
              <div key={model.name} className={`model ${active ? "active" : ""}`}>
                <div className="model-thumb" style={{ background: `linear-gradient(135deg, ${model.colors})` }}>
                  <Sparkles size={22} />
                </div>
                <div className="model-text">
                  <div className="model-name">{model.name}</div>
                  <div className="model-note">{model.note}</div>
                </div>
                {active && <span className="badge">In use</span>}
              </div>
            );
          })}
        </div>
      </aside>

      <form className="create panel" onSubmit={handleSubmit}>
        <div className="create-section">
          <div className="section-head">
            <Sparkles size={24} />
            <h2>Describe your imagination...</h2>
            <div className="right">
              <button type="button" className="ghost-button" disabled title="Coming soon">
                <Tag size={18} /> Presets <span className="soon">Soon</span>
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
                    : preset.type === "audio"
                      ? "Describe the music, for example: calm lo-fi piano with soft rain, 80 bpm"
                      : "Describe the image, for example: a red car by the sea at sunset"
              }
              disabled={running}
              style={index > 0 ? { marginTop: 12, minHeight: 80 } : undefined}
            />
          ))}

          {choiceInputs.map((input) => (
            <Field
              key={`${preset.id}/${input.key}`}
              input={input}
              value={values[input.key] ?? ""}
              disabled={running}
              onChange={setValue(input.key)}
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
              <Paperclip size={19} />
            </button>
            <div className="select-wrap">
              {preset.type === "video" ? <Video size={18} /> : preset.type === "audio" ? <Music size={18} /> : <Image size={18} />}
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
              <ChevronDown size={18} />
            </div>
            {prompt && (
              <span className={`char-count ${promptLength > MAX_TEXT_LENGTH ? "over" : ""}`}>
                {promptLength}/{MAX_TEXT_LENGTH}
              </span>
            )}
          </div>
          {preset.description && <p className="preset-note">{preset.description}</p>}
          {(preset.clientWork || preset.experimental || estimate) && (
            <div className="preset-facts">
              <PresetBadges preset={preset} />
              {estimate && <span>Usually takes {formatSeconds(estimate)}.</span>}
            </div>
          )}
        </div>

        <div className="create-section">
          <div className="section-head">
            <Zap size={22} />
            <h3>Quick Prompts</h3>
            <span className="soon" style={{ marginLeft: 0 }}>
              Soon
            </span>
            <div className="right">
              <button type="button" className="ghost-button" disabled title="Coming soon">
                View more <ArrowRight size={16} />
              </button>
            </div>
          </div>
          <div className="quick-grid">
            {QUICK_PROMPTS.map((q) => (
              <button key={q.label} type="button" className="quick-card" disabled title="Coming soon">
                <div className="quick-art" style={{ background: `linear-gradient(135deg, ${q.colors})` }}>
                  <Image size={22} />
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
            <Settings size={22} />
            <h3>Advanced Settings</h3>
            {showSettings ? <ChevronUp size={20} /> : <ChevronDown size={20} />}
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
                  <Layers size={22} />
                  <div className="select-wrap" style={{ flex: 1 }}>
                    <select className="select" disabled style={{ width: "100%", paddingLeft: 12 }} title="Coming soon">
                      <option>Set by the preset</option>
                    </select>
                    <ChevronDown size={18} />
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
            <Sparkles size={26} />
            {running ? "Generating..." : "Generate"}
          </button>
          {project && (
            <p className="project-note">
              <Folder size={16} /> New files go to the project <strong>{project.name}</strong>
            </p>
          )}
        </div>
      </form>

      <section className="result panel">
        <div className="section-head">
          {shownKind === "video" ? (
            <Video size={22} />
          ) : shownKind === "audio" ? (
            <Music size={22} />
          ) : shownKind === "3d" ? (
            <Box size={22} />
          ) : (
            <Image size={22} />
          )}
          <h2>{RESULT_TITLES[shownKind]}</h2>
          <div className="right">
            {shown?.jobId && shown.kind === "image" && (
              <SendToMenu jobId={shown.jobId} onOpenInGenerate={openFromSendTo} align="right" />
            )}
            {shown?.jobId && shown.kind === "video" && (
              <ExtendButton jobId={shown.jobId} presetId={shown.presetId} onOpenInGenerate={openFromSendTo} />
            )}
            {shown && (
              <a className="icon-button" href={shown.url} download title="Download">
                <Download size={19} />
              </a>
            )}
            <button
              type="button"
              className="icon-button"
              onClick={() => stageRef.current?.requestFullscreen()}
              disabled={!shown}
              title="Full screen"
            >
              <Maximize size={19} />
            </button>
          </div>
        </div>

        <div className="stage" ref={stageRef}>
          {shown ? (
            <Media key={shown.url} url={shown.url} kind={shown.kind} mode="full" alt={shown.alt} />
          ) : (
            <div className="stage-empty">
              <Image size={56} />
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
                <Media url={result.url} kind={result.kind} mode="thumbnail" alt={result.alt} />
                {result.kind === "video" && (
                  <span className="video-tag">
                    <Play size={10} className="fill-current" /> Video
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

// Up to this many choices show as buttons. More show as a dropdown (FRG-32).
const MAX_CHOICE_BUTTONS = 4;

// One number or seed input in Advanced Settings, or an input with choices.
// Which box it is depends on "kind" and "options" in preset.json.
export function Field(props: { input: PresetInput; value: string; disabled: boolean; onChange: (value: string) => void }) {
  const { input, value, disabled, onChange } = props;

  let box;
  if (input.options) {
    // A list of allowed values (FRG-32). The form keeps them as text, like the other boxes.
    const options = input.options;
    if (options.length <= MAX_CHOICE_BUTTONS) {
      box = (
        <div className="choice-buttons" role="group" aria-label={input.label}>
          {options.map((option) => (
            <button
              key={String(option.value)}
              type="button"
              className={`button ${value === String(option.value) ? "active" : ""}`}
              aria-pressed={value === String(option.value)}
              onClick={() => onChange(String(option.value))}
              disabled={disabled}
            >
              {option.label}
            </button>
          ))}
        </div>
      );
    } else {
      box = (
        <div className="select-wrap">
          <select className="select" value={value} onChange={(event) => onChange(event.target.value)} disabled={disabled} style={{ width: "100%", paddingLeft: 12 }}>
            {value === "" && <option value="">Pick one</option>}
            {options.map((option) => (
              <option key={String(option.value)} value={String(option.value)}>
                {option.label}
              </option>
            ))}
          </select>
          <ChevronDown size={18} />
        </div>
      );
    }
    // A label around buttons would click the first one, so a div is used here.
    return (
      <div>
        <span className="field-label">{input.label}</span>
        {box}
        {input.note && <p className="preset-note">{input.note}</p>}
      </div>
    );
  } else if (input.kind === "seed") {
    box = (
      <div className="field-row">
        <Box size={22} />
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
            <Shuffle size={18} />
          </button>
        </div>
      </div>
    );
  } else if (input.kind === "number") {
    box = (
      <div className="field-row">
        <Monitor size={22} />
        <input
          className="input"
          type="number"
          step={input.step ?? 1}
          min={input.min ?? 1}
          max={input.max ?? 4096}
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
export function ImageBox(props: { input: PresetInput; value: string; disabled: boolean; onChange: (value: string) => void }) {
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
          <Upload size={24} />
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
export function ProgressView({ progress, onCancel, cancelling }: ProgressViewProps) {
  let text = "Sending your job to ComfyUI...";
  let percent: number | null = null;
  if (progress?.state === "waiting") {
    const ahead = progress.jobsAhead === 1 ? "1 job" : `${progress.jobsAhead} jobs`;
    text = `Waiting in the queue: ${ahead} ahead of yours.`;
  } else if (progress?.state === "running" && progress.steps > 0) {
    // Several sampler passes (FRG-32): say which one. The bar is for the whole job.
    const pass = progress.stages > 1 ? `Pass ${progress.stage} of ${progress.stages} · ` : "";
    text = `${pass}Step ${progress.step} of ${progress.steps}`;
    percent = progress.percent;
  } else if (progress?.state === "running" && progress.percent > 0) {
    // Between two passes: keep the bar where it was.
    text = `Pass ${progress.stage} of ${progress.stages}`;
    percent = progress.percent;
  } else if (progress?.state === "running") {
    // Running, but no steps yet: ComfyUI is loading the model (slow only the first time).
    text = "Starting...";
  } else if (progress?.state === "finishing") {
    text = "Saving the result...";
    percent = 100;
  } else if (progress?.state === "joining") {
    text = `Joining the clips: frame ${progress.frame} of ${progress.frames}`;
    percent = progress.percent;
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
