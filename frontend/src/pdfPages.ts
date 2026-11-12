// PDF files on the Translate page (FRG-95).
// The translation model reads pictures, not PDF files. So the browser turns each page of a PDF
// into a picture, here, and the page then uploads the pictures like photos.
// This is done by the pdfjs-dist package, inside the browser. The PDF never leaves this PC.

// The file that does the heavy work in the background. Vite gives us its address.
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";

// The most pages one PDF file may have. The backend has the same limit (MAX_PDF_PAGES).
export const MAX_PDF_PAGES = 30;
// A PDF page is measured in points: 72 points are one inch. We draw 200 dots per inch.
const DOTS_PER_POINT = 200 / 72;
// The longest side of a picture, in dots. A very big page is drawn smaller to stay under this.
const MAX_SIDE = 3000;
// The backend accepts uploads up to 20 MB. A PNG above this is sent as a JPEG instead.
const MAX_PNG_BYTES = 19 * 1024 * 1024;

function canvasToBlob(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("The page could not be drawn."))), type, quality);
  });
}

export function isPdf(file: File): boolean {
  return file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf");
}

// Turn each page of a PDF file into a picture. `onPage(picture, page, pages)` is called for
// each page, in order, and the next page is drawn only after it has finished.
// Throws an error with a plain-English message if the file cannot be read.
export async function forEachPdfPage(file: File, onPage: (picture: Blob, page: number, pages: number) => Promise<void>): Promise<void> {
  // Loaded only when a PDF is picked, so the page stays small for everyone else.
  const pdfjs = await import("pdfjs-dist");
  pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

  // The task that opens the file. It is closed at the end, to give the memory back.
  const task = pdfjs.getDocument({
    data: await file.arrayBuffer(),
    // Extra files that some PDFs need: decoders for scanned pages, and Japanese character maps.
    // They are copies from the pdfjs-dist package, in frontend/public/pdfjs.
    wasmUrl: "/pdfjs/wasm/",
    cMapUrl: "/pdfjs/cmaps/",
    cMapPacked: true,
  });
  let pdf;
  try {
    pdf = await task.promise;
  } catch (error) {
    await task.destroy();
    const needsPassword = error instanceof Error && error.name === "PasswordException";
    throw new Error(needsPassword ? "This PDF has a password. Remove the password first." : "This PDF file could not be read.");
  }

  try {
    const pages = pdf.numPages;
    if (pages > MAX_PDF_PAGES) {
      throw new Error(`This PDF has ${pages} pages. The limit is ${MAX_PDF_PAGES} pages. Split the file first.`);
    }
    for (let number = 1; number <= pages; number++) {
      const page = await pdf.getPage(number);
      const size = page.getViewport({ scale: 1 });
      const scale = Math.min(DOTS_PER_POINT, MAX_SIDE / Math.max(size.width, size.height));
      const viewport = page.getViewport({ scale });
      const canvas = document.createElement("canvas");
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      await page.render({ canvas, viewport }).promise;
      let picture = await canvasToBlob(canvas, "image/png");
      if (picture.size > MAX_PNG_BYTES) picture = await canvasToBlob(canvas, "image/jpeg", 0.92);
      // Give the memory of this page back before the next one.
      canvas.width = 0;
      canvas.height = 0;
      page.cleanup();
      await onPage(picture, number, pages);
    }
  } finally {
    await task.destroy();
  }
}
