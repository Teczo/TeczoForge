import { useState } from "react";
import type { FormEvent } from "react";

// The only preset for now. Picking a preset is ticket FRG-10.
const PRESET_ID = "text-to-image-basic";

export default function Generate() {
  const [prompt, setPrompt] = useState("");
  const [running, setRunning] = useState(false);
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setRunning(true);
    setError(null);
    setWarning(null);
    setImageUrl(null);

    try {
      const response = await fetch("/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ presetId: PRESET_ID, inputs: { prompt } }),
      });
      // The backend always answers with JSON. If not, the backend is not running.
      const body = await response.json().catch(() => null);

      if (!body) {
        setError("Could not reach the backend. Make sure it is running, then try again.");
      } else if (!response.ok) {
        setError(body.error ?? "Something went wrong. Please try again.");
      } else {
        setImageUrl(body.imageUrl);
      }
      // For example: the image was made, but the job history (MongoDB) is offline.
      if (body?.warning) setWarning(body.warning);
    } catch {
      setError("Could not reach the backend. Make sure it is running, then try again.");
    } finally {
      setRunning(false);
    }
  }

  return (
    <section>
      <h2>Generate an image</h2>
      <form onSubmit={handleSubmit}>
        <textarea
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          placeholder="Describe the image, for example: a red car by the sea at sunset"
          rows={4}
          disabled={running}
          style={{ width: "100%", maxWidth: 600, display: "block", marginBottom: 8 }}
        />
        <button type="submit" disabled={running || prompt.trim() === ""}>
          {running ? "Generating..." : "Generate"}
        </button>
      </form>

      {running && <p>Making your image. This usually takes a few seconds.</p>}
      {error && <p style={{ color: "red" }}>{error}</p>}
      {warning && <p style={{ color: "darkorange" }}>Warning: {warning}</p>}
      {imageUrl && (
        <img src={imageUrl} alt={prompt} style={{ display: "block", maxWidth: "100%", width: 600, marginTop: 16 }} />
      )}
    </section>
  );
}
