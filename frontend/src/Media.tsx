import type { CSSProperties } from "react";

// A result can be a picture or a video. We tell them apart by the file ending.
export function isVideo(url: string): boolean {
  return /\.(mp4|webm|mov)$/i.test(url);
}

type MediaProps = {
  url: string;
  alt: string;
  style?: CSSProperties;
  // "full": a video plays with controls (result and detail view).
  // "thumbnail": a video shows its first frame, without sound or controls (gallery grid).
  mode: "full" | "thumbnail";
};

// Shows a picture with <img>, or a video with <video>.
export default function Media({ url, alt, style, mode }: MediaProps) {
  if (!isVideo(url)) {
    return <img src={url} alt={alt} loading={mode === "thumbnail" ? "lazy" : undefined} style={style} />;
  }
  if (mode === "thumbnail") {
    // preload="metadata" loads only enough to show the first frame.
    return <video src={url} title={alt} muted playsInline preload="metadata" style={style} />;
  }
  return <video src={url} title={alt} controls autoPlay loop muted playsInline style={style} />;
}
