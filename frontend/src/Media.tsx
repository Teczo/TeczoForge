import { lazy, Suspense, useEffect, useRef, useState } from "react";
import type { CSSProperties, KeyboardEvent, MouseEvent } from "react";
import { Box, Download, Music, Pause, Play } from "lucide-react";
import { loadPresets } from "./SendToMenu";
import { makeThumbnail, thumbnailUrl } from "./modelThumbnail";
import { btn } from "./ui";

// The 3D viewer (FRG-27) uses the large "three" package. It is loaded only the first time a
// model is shown in full, so pages without a 3D result stay small.
const ModelViewer = lazy(() => import("./ModelViewer"));

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

// Tells which jobs are avatar videos, which have sound (FRG-87): the preset type is "avatar", or the
// job has a fitted voice. The second way also works if the preset folder is gone.
export function useAvatarCheck(): (job: { presetId?: string | null; audioUsed?: string }) => boolean {
  const [avatarIds, setAvatarIds] = useState<string[]>([]);
  useEffect(() => {
    loadPresets().then((list) => setAvatarIds(list.filter((p) => p.type === "avatar").map((p) => p.id)));
  }, []);
  return (job) => Boolean(job.audioUsed) || avatarIds.includes(job.presetId ?? "");
}

// Only one sound plays at a time (FRG-30): when any audio, or a video with sound (FRG-87), starts,
// pause the others. Muted videos are left alone.
// "play" does not bubble, so it is caught on the way down (the last argument, true).
document.addEventListener(
  "play",
  (event) => {
    if (!(event.target instanceof HTMLMediaElement) || event.target.muted) return;
    for (const media of document.querySelectorAll<HTMLMediaElement>("audio, video")) {
      if (media !== event.target && !media.muted) media.pause();
    }
  },
  true,
);

type MediaProps = {
  url: string;
  kind: OutputKind;
  alt: string;
  style?: CSSProperties;
  // "full": a video plays with controls, a sound shows the player (result and detail view).
  // "thumbnail": a video shows its first frame, a sound a tile with a small play button (grids).
  mode: "full" | "thumbnail";
  // An avatar video (FRG-87): in "full" it has sound on, and does not start or loop by itself.
  sound?: boolean;
};

// Shows a picture with <img>, a video with <video>, a sound with the browser's audio player
// (FRG-30), and a 3D model in the 3D viewer (FRG-27). In grids a 3D model is a saved picture
// of the model (ModelThumb).
export default function Media({ url, kind, alt, style, mode, sound = false }: MediaProps) {
  const fileName = url.split("/").pop() ?? url;
  if (kind === "audio") {
    return mode === "full" ? (
      <AudioPlayer url={url} fileName={fileName} alt={alt} style={style} />
    ) : (
      <AudioTile url={url} fileName={fileName} alt={alt} style={style} />
    );
  }
  if (kind === "3d") {
    if (mode === "full") {
      const loading = (
        <div className="file-tile" style={style} title={alt}>
          <Box size={56} />
          <span>Loading 3D viewer...</span>
        </div>
      );
      return (
        <Suspense fallback={loading}>
          <ModelViewer url={url} alt={alt} style={style} />
        </Suspense>
      );
    }
    return <ModelThumb key={url} url={url} fileName={fileName} alt={alt} style={style} />;
  }
  if (kind === "image") {
    return <img src={url} alt={alt} loading={mode === "thumbnail" ? "lazy" : undefined} style={style} />;
  }
  if (mode === "thumbnail") {
    // preload="metadata" loads only enough to show the first frame.
    return <video src={url} title={alt} muted playsInline preload="metadata" style={style} />;
  }
  // The key makes a new player if "sound" is only known after the presets load, so a video that
  // already started muted does not carry on playing out loud.
  if (sound) return <video key="sound" src={url} title={alt} controls playsInline preload="metadata" style={style} />;
  return <video key="muted" src={url} title={alt} controls autoPlay loop muted playsInline style={style} />;
}

// The small view of a 3D model in a grid: a saved picture of the model (see modelThumbnail.ts).
// A model without a picture shows the icon tile while its picture is made, then the picture.
// A thumbnail sits inside a button, so it cannot hold a link. Its detail view has Download.
function ModelThumb({ url, fileName, alt, style }: { url: string; fileName: string; alt: string; style?: CSSProperties }) {
  // "saved": show the picture from the backend. "making": it was missing, so it is being made.
  // "made": show the new picture. "none": it could not be made, so the icon tile stays.
  const [state, setState] = useState<"saved" | "making" | "made" | "none">("saved");

  // loading="lazy": the browser asks for the picture only when the tile is near the screen, so
  // pictures are only made for models the user really scrolls to.
  function pictureMissing() {
    if (state !== "saved") return setState("none");
    setState("making");
    makeThumbnail(url).then((ok) => setState(ok ? "made" : "none"));
  }

  if (state === "saved" || state === "made") {
    // "?made": a new address, so the browser does not reuse its "not found" answer.
    return <img src={thumbnailUrl(url) + (state === "made" ? "?made" : "")} alt={alt} title={alt} loading="lazy" style={style} onError={pictureMissing} />;
  }
  return (
    <div className="file-tile" style={style} title={alt}>
      <Box size={36} />
      <span className="file-tile-name">{state === "making" ? "Making the picture..." : fileName}</span>
    </div>
  );
}

// A 3D model as its picture, with a "View 3D" button that swaps in the live 3D viewer.
// For pages that can show many models at once (chat, games): a browser can only keep a few live
// 3D views, and each one holds the whole model in graphics memory.
type ModelPreviewProps = { url: string; alt: string; open: boolean; onToggle: () => void; style?: CSSProperties };
export function ModelPreview({ url, alt, open, onToggle, style }: ModelPreviewProps) {
  return (
    <div className="relative" style={style}>
      <Media url={url} kind="3d" mode={open ? "full" : "thumbnail"} alt={alt} style={style && { width: "100%", height: "100%", objectFit: "cover" }} />
      <button type="button" className={`${btn("secondary", "xs")} absolute left-2 top-2`} onClick={onToggle}>
        {open ? "Close 3D" : "View 3D"}
      </button>
    </div>
  );
}

// The large view of a sound: the browser's player (play, seek, volume), the file name, its
// length and Download. It does not start by itself.
function AudioPlayer({ url, fileName, alt, style }: { url: string; fileName: string; alt: string; style?: CSSProperties }) {
  const [seconds, setSeconds] = useState<number | null>(null);
  return (
    <div className="file-tile audio-player" style={style} title={alt}>
      <Music size={56} />
      <span className="file-tile-name">{fileName}</span>
      {seconds !== null && <span className="audio-length">{seconds.toFixed(1)} seconds</span>}
      <audio
        src={url}
        controls
        preload="metadata"
        onLoadedMetadata={(event) => {
          const duration = event.currentTarget.duration;
          if (Number.isFinite(duration)) setSeconds(duration);
        }}
      />
      <a className="button" href={url} download>
        <Download size={18} /> Download
      </a>
    </div>
  );
}

// The small view of a sound in a grid: a music icon, the file name and a play / pause button.
// The tile is often inside a button (it opens the detail view), so the play control is a
// span with role="button" that stops the click from also opening the detail view.
function AudioTile({ url, fileName, alt, style }: { url: string; fileName: string; alt: string; style?: CSSProperties }) {
  const audio = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);

  function toggle(event: MouseEvent | KeyboardEvent) {
    event.stopPropagation();
    event.preventDefault();
    const player = audio.current;
    if (!player) return;
    if (player.paused) player.play().catch(() => setPlaying(false));
    else player.pause();
  }

  return (
    <div className="file-tile audio-tile" style={style} title={alt}>
      <Music size={36} />
      <span className="file-tile-name">{fileName}</span>
      <span
        role="button"
        tabIndex={0}
        className="audio-play"
        aria-label={playing ? "Pause" : "Play"}
        onClick={toggle}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") toggle(event);
        }}
      >
        {playing ? <Pause size={16} className="fill-current" /> : <Play size={16} className="fill-current" />}
      </span>
      <audio
        ref={audio}
        src={url}
        preload="none"
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => setPlaying(false)}
      />
    </div>
  );
}
