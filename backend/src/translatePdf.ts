import { existsSync } from "node:fs";
import PDFDocument from "pdfkit";
import { splitIntoBlocks } from "./translateTables.js";

// The PDF download of a translation (FRG-95).
// One page of the source document becomes one part of the PDF, starting on a new sheet.
// Plain text is written as text. A table is drawn as a real table with lines.
// The PDF is made on this PC by the pdfkit package. Nothing is sent anywhere.

// The font must have Japanese characters, because a translation keeps Japanese names in brackets.
// Yu Gothic is part of Windows. A .ttc file holds several fonts, so the name says which one.
function fontSettings() {
  const env = process.env;
  return {
    path: (env.TRANSLATE_PDF_FONT_PATH ?? "").trim() || "C:\\Windows\\Fonts\\YuGothR.ttc",
    name: (env.TRANSLATE_PDF_FONT_NAME ?? "").trim() || "YuGothic-Regular",
  };
}

// Can a PDF be made? If not, the answer says why, in plain English.
export function pdfFontProblem(): string | null {
  const font = fontSettings();
  if (existsSync(font.path)) return null;
  return `The font for the PDF is missing: ${font.path}. Set TRANSLATE_PDF_FONT_PATH in backend/.env to a font file with Japanese characters.`;
}

// One page of the source document. `text` is null when that page has no translation yet.
export type PdfPart = { title: string; text: string | null };

const TEXT_SIZE = 10.5;
const TITLE_SIZE = 9;
const MARGIN = 50;
// A table with more columns than this gets a sheet that lies on its side, so the columns have room.
const MAX_COLUMNS_UPRIGHT = 6;

// Make the PDF and give it back as bytes.
export function makeTranslationPdf(parts: PdfPart[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const font = fontSettings();
    const pdf = new PDFDocument({ size: "A4", margin: MARGIN, autoFirstPage: false });
    const chunks: Buffer[] = [];
    pdf.on("data", (chunk: Buffer) => chunks.push(chunk));
    pdf.on("end", () => resolve(Buffer.concat(chunks)));
    pdf.on("error", reject);

    try {
      for (const part of parts) {
        const blocks = part.text === null ? [] : splitIntoBlocks(part.text);
        const wide = blocks.some((block) => block.kind === "table" && block.rows[0].length > MAX_COLUMNS_UPRIGHT);
        pdf.addPage({ size: "A4", margin: MARGIN, layout: wide ? "landscape" : "portrait" });
        // A .ttc file needs the font name. Other font files have only one font.
        if (font.path.toLowerCase().endsWith(".ttc")) pdf.font(font.path, font.name);
        else pdf.font(font.path);

        // The small grey line at the top: the file name and the page number.
        pdf.fontSize(TITLE_SIZE).fillColor("#666666").text(part.title);
        pdf.moveDown(1);
        pdf.fontSize(TEXT_SIZE).fillColor("#000000");

        if (part.text === null) {
          pdf.text("This page is not translated yet.");
          continue;
        }
        for (const block of blocks) {
          if (block.kind === "text") {
            pdf.text(block.text, { lineGap: 3 });
          } else {
            pdf.table({
              defaultStyle: { border: 0.5, borderColor: "#444444", padding: 4 },
              // The header row gets a light grey background.
              rowStyles: (row) => (block.header && row === 0 ? { backgroundColor: "#eeeeee" } : undefined),
              data: block.rows,
            });
            // After a table, the next text starts at the left edge again.
            pdf.x = pdf.page.margins.left;
          }
          pdf.moveDown(0.8);
        }
      }
      pdf.end();
    } catch (error) {
      reject(error);
    }
  });
}
