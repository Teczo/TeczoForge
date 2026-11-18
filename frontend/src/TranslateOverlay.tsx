import { useEffect, useState } from "react";
import { blockGeometry, cssColour, fitBlock, isMark, prepareBlocks } from "./translateOverlayFit";
import type { FittedBlock, Layout, Measure, PreparedBlock } from "./translateOverlayFit";

// The translation on the photo (FRG-105, plan: docs/translate-overlay.md section 11).
// The photo with an SVG layer on top. The SVG uses photo pixels (viewBox = photo size), so it grows and
// shrinks with the photo by itself. Each block: a patch in the paper colour, and the English in the ink colour.
// These colours come from the photo, so they are the same in light and dark mode (CLAUDE.md section 15, rule 3).

// The font weight of the English on the photo.
export const OVERLAY_FONT_WEIGHT = 500;
// The soft edge of a patch: the blur, in photo pixels. The PNG download uses the same.
export const SOFT_EDGE = 1.5;

// The app font, from --font in theme.css.
export function overlayFontFamily(): string {
  return getComputedStyle(document.documentElement).getPropertyValue("--font").trim() || "sans-serif";
}

// Measuring with a canvas, in the font the SVG uses.
async function canvasMeasure(): Promise<Measure> {
  const family = overlayFontFamily();
  // Wait for the font, or the sizes are measured in a fallback font.
  await document.fonts.load(`${OVERLAY_FONT_WEIGHT} 16px ${family}`).catch(() => undefined);
  const context = document.createElement("canvas").getContext("2d");
  if (!context) throw new Error("This browser cannot measure text.");
  return (text, fontSize) => {
    context.font = `${OVERLAY_FONT_WEIGHT} ${fontSize}px ${family}`;
    return context.measureText(text).width;
  };
}

// The photo at full size, and its pixels.
async function loadPhoto(imageUrl: string) {
  const image = new Image();
  image.src = imageUrl;
  await image.decode();
  const canvas = document.createElement("canvas");
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("This browser cannot read the photo.");
  context.drawImage(image, 0, 0);
  return { image, pixels: context.getImageData(0, 0, canvas.width, canvas.height) };
}

// Everything needed to draw the overlay: the photo itself, its size and the fitted blocks.
// The screen and the PNG download (FRG-106) both draw from this, so they look the same.
export type Overlay = {
  image: HTMLImageElement;
  width: number;
  height: number;
  blocks: { prepared: PreparedBlock; fitted: FittedBlock }[];
};

// Load the layout from the backend and the photo, then find the ink and fit the text.
async function makeOverlay(docId: string, imageUrl: string): Promise<Overlay> {
  const response = await fetch(`/api/translate/documents/${docId}/layout`);
  if (!response.ok) throw new Error("The translation on the photo could not be loaded.");
  const layout: Layout = await response.json();
  const [photo, measure] = await Promise.all([loadPhoto(imageUrl), canvasMeasure()]);
  const prepared = prepareBlocks(layout, photo.pixels);
  return {
    image: photo.image,
    width: photo.pixels.width,
    height: photo.pixels.height,
    blocks: prepared
      .map((block) => ({ prepared: block, fitted: fitBlock(block, measure) }))
      .filter(({ prepared: block, fitted }) => !isMark(block, fitted, measure)),
  };
}

// The overlay of one document, made once. `version` changes when the document is translated again;
// null means the document has no overlay, and nothing is loaded.
export function useOverlay(docId: string, imageUrl: string, version: string | null) {
  const [overlay, setOverlay] = useState<Overlay | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    setOverlay(null);
    setProblem(null);
    if (version === null) return;
    let cancelled = false;
    makeOverlay(docId, imageUrl)
      .then((result) => {
        if (!cancelled) setOverlay(result);
      })
      .catch((error: unknown) => {
        if (!cancelled) setProblem(error instanceof Error ? error.message : "The translation on the photo could not be drawn.");
      });
    return () => {
      cancelled = true;
    };
  }, [docId, imageUrl, version]);

  return { overlay, problem };
}

export function TranslateOverlay({
  docId,
  imageUrl,
  alt,
  overlay,
  problem,
}: {
  docId: string;
  imageUrl: string;
  alt: string;
  overlay: Overlay | null;
  problem: string | null;
}) {
  const family = overlayFontFamily();
  // SVG ids must be unique on the page.
  const idOf = (name: string) => `${docId}-${name}`;

  return (
    <div className="relative">
      <img src={imageUrl} alt={alt} className="block w-full" />
      {overlay && (
        <svg
          className="absolute inset-0 h-full w-full"
          viewBox={`0 0 ${overlay.width} ${overlay.height}`}
          preserveAspectRatio="none"
          aria-hidden="true"
        >
          <defs>
            {/* A soft edge of about 3 pixels around each patch. */}
            <filter id={idOf("soft")} x="-5%" y="-5%" width="110%" height="110%">
              <feGaussianBlur stdDeviation={SOFT_EDGE} />
            </filter>
            {overlay.blocks.map(({ prepared }) => (
              <linearGradient key={prepared.block} id={idOf(`paper-${prepared.block}`)} x1="0" x2="1" y1="0" y2="0">
                <stop offset="0" stopColor={cssColour(prepared.paperLeft)} />
                <stop offset="1" stopColor={cssColour(prepared.paperRight)} />
              </linearGradient>
            ))}
          </defs>
          {/* All patches first, then all texts, so a patch never hides the text of the block above it. */}
          {overlay.blocks.map(({ prepared, fitted }) => (
            <BlockPatch key={prepared.block} prepared={prepared} fitted={fitted} idOf={idOf} />
          ))}
          {/* The texts do not catch the mouse: hovering them shows the title of the patch below. */}
          <g pointerEvents="none">
            {overlay.blocks.map(({ prepared, fitted }) => (
              <BlockText key={prepared.block} prepared={prepared} fitted={fitted} family={family} />
            ))}
          </g>
        </svg>
      )}
      {problem && (
        <p className="absolute top-2 left-2 m-0 rounded-lg bg-card px-3 py-1.5 text-xs text-danger shadow-soft">{problem}</p>
      )}
    </div>
  );
}

// The patch of one block: it covers the Japanese. Hover shows the Japanese and the English.
function BlockPatch({ prepared, fitted, idOf }: { prepared: PreparedBlock; fitted: FittedBlock; idOf: (name: string) => string }) {
  const { patch } = blockGeometry(prepared, fitted);
  return (
    <rect
      x={patch.x}
      y={patch.y}
      width={patch.width}
      height={patch.height}
      fill={`url(#${idOf(`paper-${prepared.block}`)})`}
      filter={`url(#${idOf("soft")})`}
    >
      <title>{`Japanese: ${prepared.japanese}\nEnglish: ${prepared.english}`}</title>
    </rect>
  );
}

// The English of one block, on its patch.
function BlockText({ prepared, fitted, family }: { prepared: PreparedBlock; fitted: FittedBlock; family: string }) {
  const { origin, vertical, baselines } = blockGeometry(prepared, fitted);
  const transform = `translate(${origin[0]} ${origin[1]})${vertical ? " rotate(90)" : ""}`;
  return (
    <text transform={transform} fill={cssColour(prepared.ink)} fontFamily={family} fontWeight={OVERLAY_FONT_WEIGHT} fontSize={fitted.fontSize}>
      {fitted.lines.map((line, index) => (
        <tspan key={index} x={0} y={baselines[index]}>
          {line}
        </tspan>
      ))}
    </text>
  );
}

// The translated photo as a PNG file (FRG-106, spec 12). Made in the browser from the same overlay as the
// screen: nothing is sent to the backend. All patches first, then all texts, like on screen.
export async function overlayPng(overlay: Overlay): Promise<Blob> {
  const family = overlayFontFamily();
  const canvas = document.createElement("canvas");
  canvas.width = overlay.width;
  canvas.height = overlay.height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("This browser cannot make the image.");
  context.drawImage(overlay.image, 0, 0);

  for (const { prepared, fitted } of overlay.blocks) {
    const { patch } = blockGeometry(prepared, fitted);
    const gradient = context.createLinearGradient(patch.x, 0, patch.x + patch.width, 0);
    gradient.addColorStop(0, cssColour(prepared.paperLeft));
    gradient.addColorStop(1, cssColour(prepared.paperRight));
    context.save();
    context.filter = `blur(${SOFT_EDGE}px)`;
    context.fillStyle = gradient;
    context.fillRect(patch.x, patch.y, patch.width, patch.height);
    context.restore();
  }

  for (const { prepared, fitted } of overlay.blocks) {
    const { origin, vertical, baselines } = blockGeometry(prepared, fitted);
    context.save();
    context.translate(origin[0], origin[1]);
    if (vertical) context.rotate(Math.PI / 2);
    context.font = `${OVERLAY_FONT_WEIGHT} ${fitted.fontSize}px ${family}`;
    context.fillStyle = cssColour(prepared.ink);
    context.textBaseline = "alphabetic";
    fitted.lines.forEach((line, index) => context.fillText(line, 0, baselines[index]));
    context.restore();
  }

  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("The image could not be made."))), "image/png");
  });
}
