import { useEffect, useState } from "react";
import { cssColour, fitBlock, isMark, PATCH_EXTRA, prepareBlocks } from "./translateOverlayFit";
import type { FittedBlock, Layout, Measure, PreparedBlock } from "./translateOverlayFit";

// The translation on the photo (FRG-105, plan: docs/translate-overlay.md section 11).
// The photo with an SVG layer on top. The SVG uses photo pixels (viewBox = photo size), so it grows and
// shrinks with the photo by itself. Each block: a patch in the paper colour, and the English in the ink colour.
// These colours come from the photo, so they are the same in light and dark mode (CLAUDE.md section 15, rule 3).

// The font weight of the English on the photo.
export const OVERLAY_FONT_WEIGHT = 500;

// The app font, from --font in theme.css.
export function overlayFontFamily(): string {
  return getComputedStyle(document.documentElement).getPropertyValue("--font").trim() || "sans-serif";
}

// Measuring with a canvas, in the font the SVG uses. The PNG download (FRG-106) can use the same.
export async function canvasMeasure(): Promise<Measure> {
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
async function loadPixels(imageUrl: string) {
  const image = new Image();
  image.src = imageUrl;
  await image.decode();
  const canvas = document.createElement("canvas");
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("This browser cannot read the photo.");
  context.drawImage(image, 0, 0);
  return context.getImageData(0, 0, canvas.width, canvas.height);
}

type Drawn = { width: number; height: number; blocks: { prepared: PreparedBlock; fitted: FittedBlock }[] };

// Everything the layer needs: the layout from the backend, the photo's pixels, and the fitted blocks.
async function makeOverlay(docId: string, imageUrl: string): Promise<Drawn> {
  const response = await fetch(`/api/translate/documents/${docId}/layout`);
  if (!response.ok) throw new Error("The translation on the photo could not be loaded.");
  const layout: Layout = await response.json();
  const [pixels, measure] = await Promise.all([loadPixels(imageUrl), canvasMeasure()]);
  const prepared = prepareBlocks(layout, pixels);
  return {
    width: pixels.width,
    height: pixels.height,
    blocks: prepared
      .map((block) => ({ prepared: block, fitted: fitBlock(block, measure) }))
      .filter(({ prepared: block, fitted }) => !isMark(block, fitted, measure)),
  };
}

export function TranslateOverlay({ docId, imageUrl, alt }: { docId: string; imageUrl: string; alt: string }) {
  const [drawn, setDrawn] = useState<Drawn | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setDrawn(null);
    setProblem(null);
    makeOverlay(docId, imageUrl)
      .then((result) => {
        if (!cancelled) setDrawn(result);
      })
      .catch((error: unknown) => {
        if (!cancelled) setProblem(error instanceof Error ? error.message : "The translation on the photo could not be drawn.");
      });
    return () => {
      cancelled = true;
    };
  }, [docId, imageUrl]);

  const family = overlayFontFamily();
  // SVG ids must be unique on the page.
  const idOf = (name: string) => `${docId}-${name}`;

  return (
    <div className="relative">
      <img src={imageUrl} alt={alt} className="block w-full" />
      {drawn && (
        <svg
          className="absolute inset-0 h-full w-full"
          viewBox={`0 0 ${drawn.width} ${drawn.height}`}
          preserveAspectRatio="none"
          aria-hidden="true"
        >
          <defs>
            {/* A soft edge of about 3 pixels around each patch. */}
            <filter id={idOf("soft")} x="-5%" y="-5%" width="110%" height="110%">
              <feGaussianBlur stdDeviation={1.5} />
            </filter>
            {drawn.blocks.map(({ prepared }) => (
              <linearGradient key={prepared.block} id={idOf(`paper-${prepared.block}`)} x1="0" x2="1" y1="0" y2="0">
                <stop offset="0" stopColor={cssColour(prepared.paperLeft)} />
                <stop offset="1" stopColor={cssColour(prepared.paperRight)} />
              </linearGradient>
            ))}
          </defs>
          {/* All patches first, then all texts, so a patch never hides the text of the block above it. */}
          {drawn.blocks.map(({ prepared, fitted }) => (
            <BlockPatch key={prepared.block} prepared={prepared} fitted={fitted} idOf={idOf} />
          ))}
          {/* The texts do not catch the mouse: hovering them shows the title of the patch below. */}
          <g pointerEvents="none">
            {drawn.blocks.map(({ prepared, fitted }) => (
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
  const [x1, y1, x2, y2] = fitted.inner;
  const pad = prepared.margin + PATCH_EXTRA;
  return (
    <rect
      x={x1 - pad}
      y={y1 - pad}
      width={x2 - x1 + pad * 2}
      height={y2 - y1 + pad * 2}
      fill={`url(#${idOf(`paper-${prepared.block}`)})`}
      filter={`url(#${idOf("soft")})`}
    >
      <title>{`Japanese: ${prepared.japanese}\nEnglish: ${prepared.english}`}</title>
    </rect>
  );
}

// The English of one block, on its patch.
function BlockText({ prepared, fitted, family }: { prepared: PreparedBlock; fitted: FittedBlock; family: string }) {
  const [x1, y1, x2, y2] = fitted.inner;
  const vertical = prepared.dir === "v";
  // The text is written in a box `height` high (fitBlock made the lines fit its width). A vertical block
  // is turned 90 degrees clockwise around its top right corner, so its text runs down the column.
  const height = vertical ? x2 - x1 : y2 - y1;
  const transform = vertical ? `translate(${x2} ${y1}) rotate(90)` : `translate(${x1} ${y1})`;
  // The lines sit in the middle of the box, from top to bottom.
  const top = Math.max(0, (height - fitted.lines.length * fitted.lineHeight) / 2);
  // The baseline of a line: the middle of the line, plus a bit, so the letters look centred.
  const baseline = (index: number) => top + index * fitted.lineHeight + fitted.lineHeight / 2 + fitted.fontSize * 0.35;

  return (
    <text transform={transform} fill={cssColour(prepared.ink)} fontFamily={family} fontWeight={OVERLAY_FONT_WEIGHT} fontSize={fitted.fontSize}>
      {fitted.lines.map((line, index) => (
        <tspan key={index} x={0} y={baseline(index)}>
          {line}
        </tspan>
      ))}
    </text>
  );
}
