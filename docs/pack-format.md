## Appendix B — Pack file format (`teczoforge-pack/1`)

All tickets refer to this. FRG-77 copies it into `docs/pack-format.md`.

### B1. The file

- A normal Markdown file. Free text is allowed and ignored by the checker.
- It must contain **exactly one** ` ```json ` block whose object has `"schema": "teczoforge-pack/1"`.
  (The same finder as the game file in `gameFile.ts`.)

### B2. The JSON block

```json
{
  "schema": "teczoforge-pack/1",
  "pack": {
    "code": "AQT",
    "name": "AquaTwin Unreal",
    "engine": "unreal",
    "style": "",
    "defaults": { "pictures": 3, "model_presets": ["trellis2"], "model_seeds": 1 }
  },
  "items": [
    {
      "id": "VEG-01",
      "name": "CoconutPalm",
      "group": "Vegetation",
      "kind": "model",
      "prompt": "Clean real-time 3D render of one tall coconut palm tree, ...",
      "size": [768, 1344],
      "pictures": 4,
      "model_presets": ["trellis2", "pixal3d"],
      "model_seeds": 2,
      "real_size": { "height_m": 12 },
      "notes": "Middle and far distance only."
    },
    {
      "id": "VEG-02",
      "name": "CoconutPalmLeaning",
      "group": "Vegetation",
      "kind": "model",
      "edit_from": "VEG-01",
      "edit_prompt": "Make the trunk lean strongly to the right in one long smooth curve. Keep the fronds, ...",
      "real_size": { "height_m": 10 }
    },
    {
      "id": "REF-08",
      "name": "PumpStation",
      "group": "Reference",
      "kind": "picture",
      "prompt": "Clean real-time 3D render of one single-storey water pump station building in Malaysia, ...",
      "size": [1344, 768],
      "pictures": 6
    },
    {
      "id": "PIP-01",
      "name": "PipeParts",
      "group": "Pipework",
      "kind": "skip",
      "notes": "Built in Unreal with Modeling Tools. Diameters from world.json."
    }
  ]
}
```

### B3. Fields

| Field | Required | Rule |
|---|---|---|
| `pack.code` | yes | 2 to 5 capital letters, e.g. `AQT`. Unique among packs |
| `pack.name` | yes | 1–60 characters. Also the project name |
| `pack.engine` | yes | `"unreal"` or `"none"`. Decides the export kit (FRG-82) |
| `pack.style` | no | up to 300 characters. If not empty, added to the **start** of every `prompt` as `"{style}, {prompt}"`. Default empty: prompts are used word for word |
| `pack.defaults` | no | default `pictures`, `model_presets`, `model_seeds` for items that do not set them |
| `item.id` | yes | regex `^[A-Z]{2,5}-[0-9]{2,3}[A-Z]?$`, e.g. `VEG-01`, `REF-09A`. Unique. Max 10 characters |
| `item.name` | yes | PascalCase, letters and digits, 1–40 characters, e.g. `CoconutPalm` |
| `item.group` | yes | PascalCase, letters and digits, 1–30 characters. Becomes the export folder |
| `item.kind` | yes | `"model"` (picture, then 3D), `"picture"` (picture only), `"skip"` (made outside TeczoForge, shown as a note) |
| `item.prompt` | model and picture, unless `edit_from` | up to 2000 characters. Used word for word (plus `pack.style` if set) |
| `item.edit_from` | no | id of an **earlier** item of kind `model` or `picture` that is not itself an edit. Uses the Edit Image preset on that item's picked picture |
| `item.edit_prompt` | with `edit_from` only | up to 1000 characters. The edit instruction. `prompt` and `size` are not allowed with `edit_from` |
| `item.size` | no | `[width, height]`, whole numbers 512–2048 that divide by 16. Default `[1024, 1024]` |
| `item.pictures` | no | how many pictures to make (each with its own random seed), 1–6. Default from `pack.defaults`, else 1 |
| `item.model_presets` | no | `model` only. Any of `"trellis2"`, `"pixal3d"` (no repeats). Default from `pack.defaults`, else `["trellis2"]` |
| `item.model_seeds` | no | `model` only. 3D runs per preset, 1–4. Default from `pack.defaults`, else 1 |
| `item.real_size` | no | any of `height_m`, `length_m`, `width_m`, each a number above 0 and at most 1000 |
| `item.notes` | no | up to 500 characters. Shown on the item and written to the manifest |
| limits | — | 1 to 300 items per file |

Preset ids: `trellis2` = `image-to-3d-trellis2`, `pixal3d` = `image-to-3d-pixal3d`.
Pictures use `text-to-image-basic`. Edits use `image-edit-klein`.

### B4. How many jobs an item makes

| Kind | Jobs |
|---|---|
| `picture` | `pictures` × text-to-image (or × edit, with `edit_from`) |
| `model` | the picture jobs above, then `model_presets.length` × `model_seeds` 3D jobs on the **picked** picture |
| `skip` | none |

### B5. Export file names

`{id}_{name}.{ending}`, e.g. `VEG-01_CoconutPalm.glb`, inside the folder `{group}/`.
