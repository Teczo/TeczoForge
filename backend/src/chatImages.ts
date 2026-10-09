import { HttpError } from "./httpError.js";
import { imageInfo, readKeptInput } from "./inputs.js";
import { IMAGE_NAME_PATTERN } from "./presets.js";

// Pictures in chat (FRG-25). A picture is uploaded with POST /api/upload, like on the Generate page,
// and kept in data/inputs. Its file name is its id: the chat sends it to Claude with that id, and the
// card tools accept the id as a start image. The conversation stores the path, never the bytes.
//
// Limits from the Claude API docs (Vision, "Request limits", read 2026-10-10):
// - PNG, JPEG, GIF or WebP. We accept PNG, JPEG and WebP, like the upload route.
// - At most 10 MB per image, base64-encoded, on the Claude API.
// - At most 8000 x 8000 pixels per image.
// - More than 20 images in one request: every image must then be at most 2000 x 2000 pixels.
//   We never send more than 20 images in one request, so this stricter rule never applies.
// - At most 32 MB per request in total. We send at most 24 MB of images, to leave room for the text.

export const MAX_IMAGE_BASE64_BYTES = 10_000_000;
export const MAX_IMAGE_SIDE = 8000;
export const MAX_IMAGES_PER_MESSAGE = 20;
const MAX_IMAGES_PER_REQUEST = 20;
const MAX_REQUEST_IMAGE_BYTES = 24_000_000;

export type ChatImage = { id: string; path: string };
export type LoadedImage = ChatImage & { mediaType: "image/png" | "image/jpeg" | "image/webp"; data: string };

// Load one attached picture for Claude, or throw a clear message. No API call is made with a bad picture.
export async function loadChatImage(id: unknown): Promise<LoadedImage> {
  if (typeof id !== "string" || !IMAGE_NAME_PATTERN.test(id)) throw new HttpError(400, "A picture id is not valid.");
  const bytes = await readKeptInput(id);
  if (!bytes) throw new HttpError(400, `The picture ${id} was not found. Attach it again.`);
  const info = imageInfo(bytes);
  if (!info) throw new HttpError(400, `The picture ${id} is not a PNG, JPEG or WebP image.`);

  const base64Bytes = Math.ceil(bytes.length / 3) * 4;
  if (base64Bytes > MAX_IMAGE_BASE64_BYTES) {
    const mb = (bytes.length / 1_000_000).toFixed(1);
    throw new HttpError(
      400,
      `The picture ${id} is too large for Claude (${mb} MB). Claude accepts pictures up to about 7.5 MB. Make it smaller and attach it again.`,
    );
  }
  if (info.width > MAX_IMAGE_SIDE || info.height > MAX_IMAGE_SIDE) {
    throw new HttpError(
      400,
      `The picture ${id} is ${info.width} x ${info.height} pixels. Claude accepts at most ${MAX_IMAGE_SIDE} x ${MAX_IMAGE_SIDE}. Make it smaller and attach it again.`,
    );
  }
  return { id, path: `data/inputs/${id}`, mediaType: info.mediaType as LoadedImage["mediaType"], data: bytes.toString("base64") };
}

// Check the pictures of a new message, before it is saved or sent.
export async function checkMessageImages(ids: unknown): Promise<ChatImage[]> {
  if (ids === undefined) return [];
  if (!Array.isArray(ids)) throw new HttpError(400, "images must be a list of picture ids.");
  if (ids.length > MAX_IMAGES_PER_MESSAGE) {
    throw new HttpError(400, `You can attach at most ${MAX_IMAGES_PER_MESSAGE} pictures to one message.`);
  }
  const images: ChatImage[] = [];
  for (const id of ids) {
    const loaded = await loadChatImage(id);
    images.push({ id: loaded.id, path: loaded.path });
  }
  return images;
}

// Which pictures of the conversation are sent again with this request: the newest first, up to
// 20 pictures and 24 MB. Older ones are named in the text, so Claude still knows their ids.
export async function picturesToSend(ids: string[]): Promise<Map<string, LoadedImage>> {
  const chosen = new Map<string, LoadedImage>();
  let total = 0;
  for (const id of [...ids].reverse()) {
    if (chosen.size >= MAX_IMAGES_PER_REQUEST) break;
    try {
      const image = await loadChatImage(id);
      if (total + image.data.length > MAX_REQUEST_IMAGE_BYTES) break;
      total += image.data.length;
      chosen.set(id, image);
    } catch {
      // A picture that is gone or too large now is described in the text instead.
    }
  }
  return chosen;
}
