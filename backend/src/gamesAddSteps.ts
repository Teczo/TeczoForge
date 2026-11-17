import "dotenv/config";
import { closeDatabase, getGameAssetsCollection, getGamesCollection, safeMessage } from "./db.js";
import type { GameAssetStep } from "./db.js";
import { needPresets } from "./gameFile.js";
import { loadPreset } from "./presets.js";

// Add the need steps (FRG-96) to games imported before them.
//   cd backend
//   npm run games-add-steps
// For every picture asset, the steps it should have now are: its picture, then one step per need
// whose preset is installed (gameFile.ts, needPresets). A missing step is added only to assets that
// are still "planned" (nothing made yet). Assets that are already started or approved are listed
// and not changed. Every change is printed. Running it again changes nothing.

// The name of a step in the messages, for example "Remove background" (sendToLabel in preset.json).
async function stepName(presetId: string): Promise<string> {
  try {
    const { preset } = await loadPreset(presetId);
    return preset.sendToLabel || preset.name;
  } catch {
    return presetId;
  }
}

async function main() {
  const games = await (await getGamesCollection()).find({}, { projection: { _id: 0 } }).sort({ code: 1 }).toArray();
  const assets = await getGameAssetsCollection();
  let added = 0;
  let skipped = 0;

  for (const game of games) {
    console.log(`\n${game.code} (${game.name})`);
    let changes = 0;
    const list = await assets.find({ gameId: game.id, removed: false, source: "forge" }, { projection: { _id: 0 } }).sort({ order: 1 }).toArray();

    for (const asset of list) {
      const first = asset.steps[0];
      if (!first) continue;
      const wanted = needPresets(asset.type, asset.needs);
      const have = new Set(asset.steps.map((step) => step.presetId));
      const missing = wanted.filter((presetId) => !have.has(presetId));
      if (missing.length === 0) continue;
      const names = (await Promise.all(missing.map(stepName))).join(", ");
      changes += 1;

      if (asset.status !== "planned") {
        console.log(`  ${asset.assetId}: NOT changed, it is already ${asset.status}. Missing step: ${names}`);
        skipped += 1;
        continue;
      }

      // The picture first, then the need steps in their order. Steps already there are kept as they are.
      const old = asset.steps.slice(1);
      const steps: GameAssetStep[] = [
        first,
        ...wanted.map((presetId) => old.find((step) => step.presetId === presetId) ?? { presetId, jobIds: [], approvedJobId: null }),
        ...old.filter((step) => !wanted.includes(step.presetId)),
      ];
      // Only while it is still planned, in case someone starts it at the same moment.
      const result = await assets.updateOne({ id: asset.id, status: "planned" }, { $set: { steps } });
      if (result.modifiedCount === 1) {
        console.log(`  ${asset.assetId}: added step ${names}`);
        added += 1;
      } else {
        console.log(`  ${asset.assetId}: NOT changed, it was started just now. Run this again.`);
        skipped += 1;
      }
    }
    if (changes === 0) console.log("  Nothing to change.");
  }

  console.log(`\nDone. ${added} asset(s) got new steps. ${skipped} asset(s) were not changed because they are already started or approved.`);
}

main()
  .catch((error) => {
    console.error(`Error: ${safeMessage(error)}`);
    process.exitCode = 1;
  })
  .finally(() => closeDatabase());
