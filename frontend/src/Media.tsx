import type { CSSProperties } from "react";
import { CubeIcon, DownloadIcon, MusicIcon } from "./Icons";

// A result can be a picture, a video, a sound or a 3D model (FRG-29).
export type OutputKind = "image" | "video" | "audio" | "3d";

// The kind of a finished job's file. The backend saves it as outputKind. Jobs from before
// FRG-29 do not have it, so it is worked out from the file ending, like the backend does.
export function outputKind(job: { outputKind?: string | null; imageUrl: string | null }): OutputKind {
  if (job.outputKind === "image" || job.outputKind === "video" || job.outputKind === "audio" || job.outputKind === "3d") {
    return job.outputKind;
  }
  const url = job.imageUrl ?? "";
  if (/\.(mp4|webm|mov)$/i.test(url)) return "video";
  if (/\.(mp3|wav|flac|ogg)$/i.test(url)) return "audio";
  if (/\.glb$/i.test(url)) return "3d";
  return "image";
}

type MediaProps = {
  url: string;
  kind: OutputKind;
  alt: string;
  style?: CSSProperties;
  // "full": a video plays with controls (result and detail view).
  // "thumbnail": a video shows its first frame, without sound or controls (gallery grid).
  mode: "full" | "thumbnail";
};

// Shows a picture with <img>, a video with <video>, and a sound or 3D model as a simple tile
// with an icon and the file name. The audio player (FRG-30) and 3D viewer (FRG-27) come later.
export default function Media({ url, kind, alt, style, mode }: MediaProps) {
  if (kind === "audio" || kind === "3d") {
    const fileName = url.split("/").pop() ?? url;
    return (
      <div className="file-tile" style={style} title={alt}>
        {kind === "audio" ? <MusicIcon size={mode === "full" ? 56 : 36} /> : <CubeIcon size={mode === "full" ? 56 : 36} />}
        <span className="file-tile-name">{fileName}</span>
        {/* A thumbnail sits inside a button, so it cannot hold a link. Its detail view has Download. */}
        {mode === "full" && (
          <a className="button" href={url} download>
            <DownloadIcon size={18} /> Download
          </a>
        )}
      </div>
    );
  }
  if (kind === "image") {
    return <img src={url} alt={alt} loading={mode === "thumbnail" ? "lazy" : undefined} style={style} />;
  }
  if (mode === "thumbnail") {
    // preload="metadata" loads only enough to show the first frame.
    return <video src={url} title={alt} muted playsInline preload="metadata" style={style} />;
  }
  return <video src={url} title={alt} controls autoPlay loop muted playsInline style={style} />;
}
