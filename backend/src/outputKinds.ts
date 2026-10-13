import path from "node:path";
import { HttpError } from "./httpError.js";

// Output kinds (FRG-29). A job's result can be a picture, a video, a sound or a 3D model.
// Only the file endings below are accepted. Each ending has a kind and the content type
// that is sent when the file is served from /api/outputs.

export type OutputKind = "image" | "video" | "audio" | "3d";

// One output file, as ComfyUI describes it.
export type OutputFile = { filename: string; subfolder: string; type: string };

const FILE_TYPES: Record<string, { kind: OutputKind; contentType: string }> = {
  png: { kind: "image", contentType: "image/png" },
  jpg: { kind: "image", contentType: "image/jpeg" },
  jpeg: { kind: "image", contentType: "image/jpeg" },
  webp: { kind: "image", contentType: "image/webp" },
  gif: { kind: "image", contentType: "image/gif" },
  mp4: { kind: "video", contentType: "video/mp4" },
  webm: { kind: "video", contentType: "video/webm" },
  mov: { kind: "video", contentType: "video/quicktime" },
  mp3: { kind: "audio", contentType: "audio/mpeg" },
  wav: { kind: "audio", contentType: "audio/wav" },
  flac: { kind: "audio", contentType: "audio/flac" },
  ogg: { kind: "audio", contentType: "audio/ogg" },
  glb: { kind: "3d", contentType: "model/gltf-binary" },
};

// The endings of picture files, for example "png" (FRG-49: the cover of a project tile).
export const IMAGE_ENDINGS = Object.keys(FILE_TYPES).filter((ending) => FILE_TYPES[ending].kind === "image");

// The file ending without the dot, in lowercase, for example "png". Empty if there is none.
function endingOf(fileName: string): string {
  return path.extname(fileName).slice(1).toLowerCase();
}

// The kind of a file, from its ending, or null if the ending is not accepted.
export function kindOfFile(fileName: string): OutputKind | null {
  return FILE_TYPES[endingOf(fileName)]?.kind ?? null;
}

// The content type to send for a file, or null if the ending is not accepted.
export function contentTypeOf(fileName: string): string | null {
  return FILE_TYPES[endingOf(fileName)]?.contentType ?? null;
}

// Choose the one file a job keeps: the first with an accepted ending. For an audio or 3D
// preset, the first non-picture file wins (such a node may also make a preview picture).
// If no file has an accepted ending, the job fails with a message that names the ending.
export function pickOutputFile(files: OutputFile[], presetType: string): { file: OutputFile; kind: OutputKind } {
  const accepted = files
    .map((file) => ({ file, kind: kindOfFile(file.filename) }))
    .filter((item): item is { file: OutputFile; kind: OutputKind } => item.kind !== null);
  const preferred =
    presetType === "audio" || presetType === "3d" ? accepted.find((item) => item.kind !== "image") : undefined;
  const chosen = preferred ?? accepted[0];
  if (!chosen) {
    const endings = [...new Set(files.map((file) => (endingOf(file.filename) ? `.${endingOf(file.filename)}` : "(no ending)")))];
    throw new HttpError(
      502,
      `ComfyUI made a ${endings.join(", ")} file. TeczoForge cannot use this file type yet. ` +
        `Accepted: ${Object.keys(FILE_TYPES).join(", ")}.`,
    );
  }
  return chosen;
}
