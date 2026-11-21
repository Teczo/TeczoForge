import "dotenv/config";
import { localModelUsers, releaseLocalModel, takeLocalModel } from "./localModel.js";
import { isTranslateServerRunning, translationHoldsGpu } from "./translateServer.js";

// Test for the shared local model (FRG-114). Run it with:  npm run local-model-test
// It takes the model as "chat", then as "translate", then releases "translate" (llama-server must
// still run), then releases "chat" (llama-server must stop). It prints each step.
// Uses about 22 GB of GPU memory while it runs. It stops if ComfyUI has a job.
// Run it while the backend is NOT translating: the backend is a different program and has its own owner.

let failed = false;

async function show(step: string, expectRunning: boolean) {
  const running = await isTranslateServerRunning();
  const users = localModelUsers();
  const ok = running === expectRunning;
  if (!ok) failed = true;
  console.log(
    `${ok ? "OK  " : "FAIL"} ${step}: llama-server ${running ? "runs" : "is stopped"}` +
      ` (expected: ${expectRunning ? "runs" : "stopped"}). Users: ${users.length ? users.join(", ") : "none"}.` +
      ` GPU held: ${translationHoldsGpu() ? "yes" : "no"}.`,
  );
}

async function main() {
  const startedAt = Date.now();
  console.log("1. Take the model as chat. Loading can take a minute.");
  if ((await takeLocalModel("chat")) === "busy") {
    console.log("ComfyUI has a job. Wait until it is finished, then run the test again.");
    process.exitCode = 1;
    return;
  }
  console.log(`   The model was ready after ${Math.round((Date.now() - startedAt) / 1000)} seconds.`);
  await show("After take chat", true);

  try {
    console.log("2. Take the model as translate.");
    await takeLocalModel("translate");
    await show("After take translate", true);

    console.log("3. Release translate.");
    await releaseLocalModel("translate");
    await show("After release translate", true);
  } finally {
    console.log("4. Release chat.");
    await releaseLocalModel("chat");
  }
  await show("After release chat", false);

  console.log(failed ? "The test FAILED." : "The test passed.");
  if (failed) process.exitCode = 1;
}

main().catch((error) => {
  console.error(`The test failed: ${error instanceof Error ? error.message : error}`);
  process.exitCode = 1;
});
