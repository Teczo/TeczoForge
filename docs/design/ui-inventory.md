# UI inventory for the light mode redesign

This is the checklist for the branch `feat/light-mode-redesign`.
Every item is ticked when it uses the new theme (light by default, dark with the toggle).

All files are in `frontend/src/`.

## 1. Pages and routes

| Done | Page | Route | File |
|---|---|---|---|
| [x] | Loading screen (before login is known) | any | `App.tsx` (`.loading-page`) |
| [x] | Login | any, when logged out | `Login.tsx` |
| [x] | Chat (home page) | `#/`, `#/chat`, `#/chat/<id>` | `Chat.tsx` |
| [x] | Generate / Create (Avatar is a category on it) | `#/generate` | `Generate.tsx`, `VoicePicker.tsx` |
| [x] | Gallery grid | `#/gallery` | `Gallery.tsx` |
| [x] | Gallery detail view | `#/gallery/<job id>` | `Gallery.tsx` (`Detail`), `ChainView.tsx` |
| [x] | Board | `#/board` | `Board.tsx`, `BatchBar.tsx` |
| [x] | Projects | `#/projects` | `ProjectsPage.tsx` |
| [x] | Games list | `#/games` | `GamesPage.tsx` (`GamesList`) |
| [x] | Game detail | `#/games/<id>` | `GamesPage.tsx` (`GameDetail`, `GameSteps`, `AssetReview`) |
| [x] | Asset Packs list | `#/packs` | `PacksPage.tsx` (`PacksList`) |
| [x] | Pack detail | `#/packs/<id>` | `PacksPage.tsx` (`PackDetail`, `ItemResults`) |
| [x] | Translate | `#/translate` | `TranslatePage.tsx` |

Not present in the app (nothing to restyle): a Compare tool page, a model/storage page, a settings page.
The closest parts are listed below: the pick screen (compares results side by side) and the user menu.

## 2. Frame around every page

| Done | Part | File |
|---|---|---|
| [x] | Left sidebar: logo, New chat, page links, project picker, recent chats | `AppShell.tsx`, `RecentChats.tsx`, `Logo.tsx` |
| [x] | Sidebar collapse button | `AppShell.tsx` (new) |
| [x] | Top bar: page title, Backend / ComfyUI status | `AppShell.tsx` |
| [x] | User menu (Log out) and theme toggle | `AppShell.tsx` |

## 3. Modals, dialogs, menus, full-screen views

| Done | Part | File |
|---|---|---|
| [x] | Create project dialog | `ProjectsPage.tsx` (`CreateProjectDialog`) |
| [x] | Project tile menu (Rename, Archive) | `ProjectsPage.tsx` |
| [x] | Move to project dialog | `ProjectDialogs.tsx` (`MoveToProject`) |
| [x] | Board card form (new / edit card) | `Board.tsx` (`CardForm`) |
| [x] | Import game design preview | `GamesPage.tsx` (`ImportPreview`) |
| [x] | Import pack file preview | `PacksPage.tsx` (`ImportPreview`) |
| [x] | Make a pack from a document | `PacksPage.tsx` (`ConvertPreview`) |
| [x] | Pick screen (full screen, compares results) | `PickScreen.tsx` |
| [x] | "Send to" menu and Extend button | `SendToMenu.tsx` |
| [x] | User menu popup | `AppShell.tsx` (`UserMenu`) |
| [x] | Recent chat hover buttons (Rename, Move, Delete) | `RecentChats.tsx` |

Browser dialogs (`window.prompt`, `window.confirm`, `window.alert`) are drawn by the browser and cannot be styled.

## 4. Shared components

Existing:

| Done | Part | File |
|---|---|---|
| [x] | Media (image, video, audio player, audio tile, file tile) | `Media.tsx` |
| [x] | 3D viewer | `ModelViewer.tsx` |
| [x] | Chat card (a board card shown in the chat) | `ChatCard.tsx` |
| [x] | Preset badges (licence, Test) | `PresetBadges.tsx` |
| [x] | Time estimate table | `Estimate.tsx` |
| [x] | Time test | `TimeTest.tsx` |
| [x] | Batch bar | `BatchBar.tsx` |
| [x] | Chain view (joined clips) | `ChainView.tsx` |
| [x] | Voice picker | `VoicePicker.tsx` |
| [x] | Form fields, image box, progress view | `Generate.tsx` (`Field`, `ImageBox`, `ProgressView`) |
| [x] | Logo | `Logo.tsx` |

New (made in this task, in `ui.tsx`):

| Done | Part |
|---|---|
| [x] | Button (primary, secondary, ghost, danger; sizes) |
| [x] | Input / Textarea |
| [x] | Card |
| [x] | Modal |
| [x] | Tabs |
| [x] | Badge |
| [x] | Notice (error, warning, success, info messages) |
| [x] | EmptyState |
| [x] | PageHeader |
| [x] | Sidebar and TopBar (in `AppShell.tsx`) |

## 5. States

| Done | State | Where |
|---|---|---|
| [x] | Error messages | `.message.error` in `styles.css`; red boxes in `TranslatePage`, `GamesPage`, `PacksPage`; red text in `RecentChats`, `BatchBar`, `TimeTest`, `PickScreen` |
| [x] | Warning messages | `.message.warning`; amber boxes in `TranslatePage`, `PacksPage`; amber notes in `Estimate`, `BatchBar`, `GamesPage` |
| [x] | Info / success messages (the app has no toast; these are in-page notices) | `.message.info`; green text in `GamesPage`, `PacksPage`, `PickScreen`, `TimeTest` |
| [x] | Empty states | `.empty`, `.stage-empty`, `.board-hint`; "No ... yet" lines in `ProjectsPage`, `GamesPage`, `PacksPage`, `TranslatePage`, `RecentChats`, `PickScreen` |
| [x] | Loading states | `.loading-page`, `.spinner`, `.progress-bar`, `.stage-overlay`; "Loading..." lines on every page |
| [x] | Status badges | `GamesPage` (`STATUS`), `PacksPage` (`STATUS`), `BatchBar`, `Board` (batch chip), `.licence-badge`, `.soon`, `.badge` |
| [x] | Drag-and-drop highlight | `Chat.tsx`, `TranslatePage.tsx`, `VoicePicker.tsx`, `.upload`, `.board-column.drop-target` |
| [x] | Keyboard focus ring | `:focus-visible` in `styles.css` |

## 6. Where colours are hard-coded (before this task)

### `styles.css` (old pages)

- The `:root` block: 14 dark colour variables (slate greys and teal) and `color-scheme: dark`.
- About 45 colours written directly in rules, not through a variable:
  `rgba(255, 255, 255, ...)` hover fills, `rgba(20, 184, 166, ...)` teal fills and glows,
  `#04201d` text on teal, `#ffc857` / `#ffb3b3` / `#ffd699` / `#b9dcff` message text,
  `rgba(255, 107, 107, ...)`, `rgba(255, 180, 76, ...)`, `rgba(108, 184, 255, ...)` message boxes,
  `#000` behind media, `#1e293b` / `#0f172a` / `#283548` stage and 3D viewer gradients,
  `rgba(15, 23, 42, 0.72)` overlays, `rgba(0, 0, 0, ...)` shadows and tags, the logo gradient
  `#22a6f0` / `#19d3c5`, the login page background glows.

### Tailwind colour classes in components (count of lines with a colour class)

| File | Lines |
|---|---|
| `PacksPage.tsx` | 99 |
| `GamesPage.tsx` | 72 |
| `TranslatePage.tsx` | 51 |
| `PickScreen.tsx` | 36 |
| `AppShell.tsx` | 32 |
| `ProjectsPage.tsx` | 24 |
| `Chat.tsx` | 16 |
| `BatchBar.tsx` | 14 |
| `RecentChats.tsx` | 9 |
| `Estimate.tsx` | 8 |
| `ChainView.tsx` | 5 |
| `TimeTest.tsx` | 3 |
| `Board.tsx` | 1 |

The classes are Tailwind's `slate-*` (backgrounds, borders, text), `teal-*` (buttons, active
items, focus), `emerald-*`, `amber-*`, `red-*`, `sky-*`, `violet-*` (status), `white`, `black/60`.

### Old theme variables used inside Tailwind classes

- `VoicePicker.tsx`: `bg-(--field)`, `bg-(--panel-2)`, `border-(--border-strong)`, `border-(--accent)`, `text-(--text-dim)`, `text-(--red)`.

### Colours in code (inline styles and data)

| Where | What | Plan |
|---|---|---|
| `GamesPage.tsx` line 394 | `backgroundColor: colour` for a game's palette swatches | Kept. The colour is data from the game design file. |
| `ModelViewer.tsx` | Three.js scene (lights) | Checked: the background comes from CSS. |

Other inline styles only set sizes (width, height, object-fit). They have no colours.

## 7. Result

Every item above is ticked.

- All colours are in `frontend/src/theme.css`. A search for hex, `rgb(`, `hsl(` and Tailwind colour
  names (`slate`, `teal`, `red`, ...) in `frontend/src` finds nothing outside that file.
- Newer pages (Chat, Projects, Games, Packs, Pick screen, Translate, the sidebar and top bar) use the
  shared parts in `ui.tsx` and Tailwind theme classes (`bg-card`, `text-ink`, `border-line`, ...).
- Older pages (Login, Generate, Gallery, Board) still use the classes in `styles.css`
  (`.button`, `.input`, `.panel`, `.message`, ...). Those classes were restyled and read the same
  theme variables, so they look the same as the shared parts.
- The one colour that stays in code: the palette swatches of a game (`GamesPage.tsx`), because the
  colour is data from the game design file.

How it was checked: every page and dialog was opened in a browser in light and in dark mode, with
sample data from a small stand-in API (the real backend, MongoDB and ComfyUI were not used).
Not checked: a real generation run, real pictures, video, sound and 3D models, and the import
previews on the Games and Packs pages (they need a file chosen by hand).
