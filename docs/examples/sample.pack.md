# Sample pack: Workshop Props

A small example of a TeczoForge pack file (`teczoforge-pack/1`, see `docs/pack-format.md`).
The text around the json block is free. The checker reads only the block.

What is in it:

- Models: a wooden chair (4 pictures, then 3D with TRELLIS.2 and Pixal3D, 2 runs each), a desk lamp,
  a wooden crate, and a broken crate made from the crate's picked picture with Edit Image.
- Pictures only: a workshop reference sheet and a floor tile picture.
- Made outside TeczoForge: the workbench (skip).

```json
{
  "schema": "teczoforge-pack/1",
  "pack": {
    "code": "WSP",
    "name": "Workshop Props",
    "engine": "unreal",
    "style": "Clean real-time 3D render, game asset, soft even studio light",
    "defaults": { "pictures": 2, "model_presets": ["trellis2"], "model_seeds": 1 }
  },
  "items": [
    {
      "id": "FUR-01",
      "name": "WoodenChair",
      "group": "Furniture",
      "kind": "model",
      "prompt": "one simple wooden chair with four straight legs and a slatted back, three-quarter view, plain white background",
      "size": [1024, 1024],
      "pictures": 4,
      "model_presets": ["trellis2", "pixal3d"],
      "model_seeds": 2,
      "real_size": { "height_m": 0.9, "width_m": 0.45 },
      "notes": "Used around the workbench."
    },
    {
      "id": "FUR-02",
      "name": "DeskLamp",
      "group": "Furniture",
      "kind": "model",
      "prompt": "one metal desk lamp with a round base and an adjustable arm, three-quarter view, plain white background",
      "real_size": { "height_m": 0.5 }
    },
    {
      "id": "PRP-01",
      "name": "WoodenCrate",
      "group": "Props",
      "kind": "model",
      "prompt": "one square wooden storage crate made of planks with metal corners, three-quarter view, plain white background",
      "real_size": { "height_m": 0.6, "length_m": 0.6, "width_m": 0.6 }
    },
    {
      "id": "PRP-02",
      "name": "WoodenCrateBroken",
      "group": "Props",
      "kind": "model",
      "edit_from": "PRP-01",
      "edit_prompt": "Break two planks on the front of the crate and leave a gap. Keep the size, the wood colour and the metal corners.",
      "pictures": 1,
      "real_size": { "height_m": 0.6 }
    },
    {
      "id": "PRP-03",
      "name": "OilCan",
      "group": "Props",
      "kind": "model",
      "prompt": "one small red metal oil can with a long thin spout, side view, plain white background",
      "pictures": 3,
      "model_presets": ["pixal3d"],
      "real_size": { "height_m": 0.25 }
    },
    {
      "id": "REF-01",
      "name": "WorkshopOverview",
      "group": "Reference",
      "kind": "picture",
      "prompt": "a small wooden workshop room with a workbench, a chair, a desk lamp and crates, wide view",
      "size": [1344, 768],
      "pictures": 3
    },
    {
      "id": "TEX-01",
      "name": "FloorPlanks",
      "group": "Textures",
      "kind": "picture",
      "prompt": "top-down view of worn wooden floor planks, flat even light, no shadows",
      "pictures": 1
    },
    {
      "id": "FUR-03",
      "name": "Workbench",
      "group": "Furniture",
      "kind": "skip",
      "notes": "Built in Unreal with Modeling Tools, so it fits the room size exactly."
    }
  ]
}
```
