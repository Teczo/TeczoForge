import { useRef, useState } from "react";
import type { CSSProperties, KeyboardEvent, MouseEvent } from "react";
import { CubeIcon, DownloadIcon, MusicIcon, PauseIcon, PlayIcon } from "./Icons";

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

// Only one sound plays at a time (FRG-30): when any audio on the page starts, pause the others.
// "play" does not bubble, so it is caught on the way down (the last argument, true).
document.addEventListener(
  "play",
  (event) => {
    if (!(event.target instanceof HTMLAudioElement)) return;
    for (const audio of document.querySelectorAll("audio")) {
      if (audio !== event.target) audio.pause();
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
};

// Shows a picture with <img>, a video with <video>, a sound with the browser's audio player
// (FRG-30), and a 3D model as a simple tile with an icon and the file name (viewer: FRG-27).
export default function Media({ url, kind, alt, style, mode }: MediaProps) {
  const fileName = url.split("/").pop() ?? url;
  if (kind === "audio") {
    return mode === "full" ? (
      <AudioPlayer url={url} fileName={fileName} alt={alt} style={style} />
    ) : (
      <AudioTile url={url} fileName={fileName} alt={alt} style={style} />
    );
  }
  if (kind === "3d") {
    return (
      <div className="file-tile" style={style} title={alt}>
        <CubeIcon size={mode === "full" ? 56 : 36} />
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

// The large view of a sound: the browser's player (play, seek, volume), the file name, its
// length and Download. It does not start by itself.
function AudioPlayer({ url, fileName, alt, style }: { url: string; fileName: string; alt: string; style?: CSSProperties }) {
  const [seconds, setSeconds] = useState<number | null>(null);
  return (
    <div className="file-tile audio-player" style={style} title={alt}>
      <MusicIcon size={56} />
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
        <DownloadIcon size={18} /> Download
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
      <MusicIcon size={36} />
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
        {playing ? <PauseIcon size={16} /> : <PlayIcon size={16} />}
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
