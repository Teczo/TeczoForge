import "dotenv/config";
import { startTranslateServer, stopTranslateServer, translateServerUrl } from "./translateServer.js";

// Test for the translation engine (FRG-90). Run it with:  npm run translate-test
// It starts llama-server, sends the text "Say OK", prints the answer, and stops llama-server.
// Watch the GPU memory in Task Manager: it goes up while the model is loaded, and back down at the end.

async function main() {
  const startedAt = Date.now();
  await startTranslateServer();
  console.log(`The model was ready after ${Math.round((Date.now() - startedAt) / 1000)} seconds.`);

  try {
    const response = await fetch(`${translateServerUrl()}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        temperature: 0,
        max_tokens: 50,
        messages: [{ role: "user", content: "Say OK" }],
      }),
    });
    if (!response.ok) throw new Error(`llama-server answered HTTP ${response.status}.`);
    const body = await response.json();
    console.log(`Answer from the model: ${body?.choices?.[0]?.message?.content ?? "(no text)"}`);
  } finally {
    await stopTranslateServer();
  }
}

main().catch((error) => {
  console.error(`The test failed: ${error instanceof Error ? error.message : error}`);
  process.exitCode = 1;
});
