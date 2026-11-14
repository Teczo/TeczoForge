// Pictures of 3D models, for the grids (gallery, board, packs, games).
// A live 3D view uses a lot of graphics memory, and a browser allows only a few at once. So a grid
// shows a saved picture of the model instead. The browser draws the picture once and sends it to
// the backend, which keeps it in data/thumbnails (see backend/src/thumbnails.ts).
// This file does not use "three". The drawing is in ModelViewer.tsx, loaded only when needed.

// The side of the square picture, in pixels.
export const THUMBNAIL_SIZE = 512;

function fileNameOf(modelUrl: string): string {
  return modelUrl.split("/").pop() ?? modelUrl;
}

// The address of a model's picture: "/api/outputs/<name>.glb" -> "/api/thumbnails/<name>.glb.png".
export function thumbnailUrl(modelUrl: string): string {
  return `/api/thumbnails/${encodeURIComponent(fileNameOf(modelUrl))}.png`;
}

// Send a picture to the backend. True if the model has a picture now (409: it already had one).
async function upload(modelUrl: string, picture: Blob): Promise<boolean> {
  const response = await fetch(`/api/thumbnails/${encodeURIComponent(fileNameOf(modelUrl))}`, {
    method: "POST",
    headers: { "Content-Type": "image/png" },
    body: picture,
  });
  return response.ok || response.status === 409;
}

// The models whose picture is being made or was tried, so each is made only once per page load.
const tried = new Map<string, Promise<boolean>>();
// Pictures are made one after the other, so only one model is in graphics memory at a time.
let queue: Promise<unknown> = Promise.resolve();

// Make and save the picture of a model that has none. Answers true when the picture can be shown.
export function makeThumbnail(modelUrl: string): Promise<boolean> {
  let job = tried.get(modelUrl);
  if (!job) {
    job = queue
      .then(async () => {
        const { renderThumbnail } = await import("./ModelViewer");
        return upload(modelUrl, await renderThumbnail(modelUrl));
      })
      .catch((error) => {
        console.error("Could not make the picture of a 3D model:", error);
        return false;
      });
    queue = job;
    tried.set(modelUrl, job);
  }
  return job;
}

// The 3D viewer has just drawn a model: keep its picture, if the model has none yet.
// This way a new model gets its picture without loading the file a second time.
export async function keepThumbnail(modelUrl: string, picture: Promise<Blob | null>): Promise<void> {
  if (tried.has(modelUrl)) return;
  const job = (async () => {
    const check = await fetch(thumbnailUrl(modelUrl), { method: "HEAD" });
    if (check.ok) return true;
    const blob = await picture;
    return blob ? upload(modelUrl, blob) : false;
  })().catch(() => false);
  tried.set(modelUrl, job);
  await job;
}
