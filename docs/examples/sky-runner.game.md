# Sky Runner

A small example of a game design file in the `teczoforge-game/1` format
(see `docs/game-design-format.md`). TeczoForge reads only the json block below.
Everything else in this file is free prose for Claude Code.

## The game

Sky Runner is a short 2D side-scrolling runner. A small fox pilot runs across floating
islands above the clouds, jumps between them and collects crystals. One level, one
music track, three minutes of play.

## Notes for Claude Code

- Unity 6, Universal Render Pipeline (URP), 2D.
- The player is a sprite with a run cycle. Crystals are collected on touch.
- The crystal model is used on the title screen only, turning slowly.
- The jump sound comes from our own sound library, not from TeczoForge.

## Assets

```json
{
  "schema": "teczoforge-game/1",
  "game": {
    "code": "SKR",
    "name": "Sky Runner",
    "dimension": "2D",
    "pipeline": "URP",
    "style": "bright hand-painted cartoon style, soft outlines, warm morning light",
    "palette": ["#87CEEB", "#FFD166", "#EF476F", "#06D6A0", "#FFFFFF"]
  },
  "assets": [
    {
      "id": "SKR_MDL_Pickups_Crystal",
      "type": "model",
      "category": "Pickups",
      "prompt": "a glowing blue crystal with six sharp faces",
      "use": "Turning crystal on the title screen",
      "target_height_m": 0.5
    },
    {
      "id": "SKR_TEX_Ground_Grass",
      "type": "texture",
      "category": "Ground",
      "prompt": "short bright green grass seen from above, small yellow flowers",
      "use": "Top surface of every floating island",
      "size": [1024, 1024],
      "needs": ["tiling"]
    },
    {
      "id": "SKR_SPR_Player_Fox",
      "type": "sprite",
      "category": "Player",
      "prompt": "a small orange fox wearing pilot goggles and a red scarf, running, side view",
      "use": "The player character",
      "size": [1024, 1024],
      "needs": ["transparent_bg", "animation"]
    },
    {
      "id": "SKR_SPR_Player_Fox_Jump",
      "type": "sprite",
      "category": "Player",
      "prompt": "a small orange fox wearing pilot goggles and a red scarf, jumping, side view",
      "use": "The player character in the air",
      "size": [1024, 1024],
      "needs": ["transparent_bg"]
    },
    {
      "id": "SKR_BG_Levels_Sky",
      "type": "background",
      "category": "Levels",
      "prompt": "wide sky full of soft clouds, floating grassy islands far away",
      "use": "Far background of the level, scrolls slowly",
      "size": [1344, 768]
    },
    {
      "id": "SKR_UI_Menus_PlayButton",
      "type": "ui",
      "category": "Menus",
      "prompt": "a round wooden button with a white play arrow",
      "use": "Play button on the title screen",
      "size": [512, 512],
      "needs": ["transparent_bg"]
    },
    {
      "id": "SKR_ICO_Pickups_Crystal",
      "type": "icon",
      "category": "Pickups",
      "prompt": "a small blue crystal icon, simple shape",
      "use": "Crystal counter in the top corner",
      "size": [512, 512],
      "needs": ["transparent_bg"]
    },
    {
      "id": "SKR_MUS_Levels_Theme",
      "type": "music",
      "category": "Levels",
      "prompt": "happy upbeat chiptune, light flute, bouncy bass, instrumental",
      "use": "Level music, loops",
      "duration_s": 30
    },
    {
      "id": "SKR_SFX_Player_Jump",
      "type": "sfx",
      "category": "Player",
      "prompt": "short soft whoosh with a small spring sound",
      "use": "Plays when the fox jumps",
      "source": "external"
    }
  ]
}
```
