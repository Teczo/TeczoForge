# UI inventory for the light mode redesign

This is the checklist for the branch `feat/light-mode-redesign`.
Every item is ticked when it uses the new theme (light by default, dark with the toggle).

All files are in `frontend/src/`.

## 1. Pages and routes

| Done | Page | Route | File |
|---|---|---|---|
| [ ] | Loading screen (before login is known) | any | `App.tsx` (`.loading-page`) |
| [ ] | Login | any, when logged out | `Login.tsx` |
| [ ] | Chat (home page) | `#/`, `#/chat`, `#/chat/<id>` | `Chat.tsx` |
| [ ] | Generate / Create | `#/generate` | `Generate.tsx` |
| [ ] | Avatar (Generate on the Avatar category) | `#/avatar` | `Generate.tsx`, `VoicePicker.tsx` |
| [ ] | Gallery grid | `#/gallery` | `Gallery.tsx` |
| [ ] | Gallery detail view | `#/gallery/<job id>` | `Gallery.tsx` (`Detail`), `ChainView.tsx` |
| [ ] | Board | `#/board` | `Board.tsx`, `BatchBar.tsx` |
| [ ] | Projects | `#/projects` | `ProjectsPage.tsx` |
| [ ] | Games list | `#/games` | `GamesPage.tsx` (`GamesList`) |
| [ ] | Game detail | `#/games/<id>` | `GamesPage.tsx` (`GameDetail`, `GameSteps`, `AssetReview`) |
| [ ] | Asset Packs list | `#/packs` | `PacksPage.tsx` (`PacksList`) |
| [ ] | Pack detail | `#/packs/<id>` | `PacksPage.tsx` (`PackDetail`, `ItemResults`) |
| [ ] | Translate | `#/translate` | `TranslatePage.tsx` |

Not present in the app (nothing to restyle): a Compare tool page, a model/storage page, a settings page.
The closest parts are listed below: the pick screen (compares results side by side), the model list
on the Generate page, and the user menu.

## 2. Frame around every page

| Done | Part | File |
|---|---|---|
| [ ] | Left sidebar: logo, New chat, page links, project picker, recent chats | `AppShell.tsx`, `RecentChats.tsx`, `Logo.tsx` |
| [ ] | Sidebar collapse button | `AppShell.tsx` (new) |
| [ ] | Top bar: page title, Backend / ComfyUI status | `AppShell.tsx` |
| [ ] | User menu (Log out) and theme toggle | `AppShell.tsx` |

## 3. Modals, dialogs, menus, full-screen views

| Done | Part | File |
|---|---|---|
| [ ] | Create project dialog | `ProjectsPage.tsx` (`CreateProjectDialog`) |
| [ ] | Project tile menu (Rename, Archive) | `ProjectsPage.tsx` |
| [ ] | Move to project dialog | `ProjectDialogs.tsx` (`MoveToProject`) |
| [ ] | Board card form (new / edit card) | `Board.tsx` (`CardForm`) |
| [ ] | Import game design preview | `GamesPage.tsx` (`ImportPreview`) |
| [ ] | Import pack file preview | `PacksPage.tsx` (`ImportPreview`) |
| [ ] | Make a pack from a document | `PacksPage.tsx` (`ConvertPreview`) |
| [ ] | Pick screen (full screen, compares results) | `PickScreen.tsx` |
| [ ] | "Send to" menu and Extend button | `SendToMenu.tsx` |
| [ ] | User menu popup | `AppShell.tsx` (`UserMenu`) |
| [ ] | Recent chat hover buttons (Rename, Move, Delete) | `RecentChats.tsx` |

Browser dialogs (`window.prompt`, `window.confirm`, `window.alert`) are drawn by the browser and cannot be styled.

## 4. Shared components

Existing:

| Done | Part | File |
|---|---|---|
| [ ] | Media (image, video, audio player, audio tile, file tile) | `Media.tsx` |
| [ ] | 3D viewer | `ModelViewer.tsx` |
| [ ] | Chat card (a board card shown in the chat) | `ChatCard.tsx` |
| [ ] | Preset badges (licence, Test) | `PresetBadges.tsx` |
| [ ] | Time estimate table | `Estimate.tsx` |
| [ ] | Time test | `TimeTest.tsx` |
| [ ] | Batch bar | `BatchBar.tsx` |
| [ ] | Chain view (joined clips) | `ChainView.tsx` |
| [ ] | Voice picker | `VoicePicker.tsx` |
| [ ] | Form fields, image box, progress view | `Generate.tsx` (`Field`, `ImageBox`, `ProgressView`) |
| [ ] | Logo | `Logo.tsx` |

New (made in this task, in `ui.tsx`):

| Done | Part |
|---|---|
| [ ] | Button (primary, secondary, ghost, danger; sizes) |
| [ ] | Input / Textarea |
| [ ] | Card |
| [ ] | Modal |
| [ ] | Tabs |
| [ ] | Badge |
| [ ] | Notice (error, warning, success, info messages) |
| [ ] | EmptyState |
| [ ] | PageHeader |
| [ ] | Sidebar and TopBar (in `AppShell.tsx`) |

## 5. States

| Done | State | Where |
|---|---|---|
| [ ] | Error messages | `.message.error` in `styles.css`; red boxes in `TranslatePage`, `GamesPage`, `PacksPage`; red text in `RecentChats`, `BatchBar`, `TimeTest`, `PickScreen` |
| [ ] | Warning messages | `.message.warning`; amber boxes in `TranslatePage`, `PacksPage`; amber notes in `Estimate`, `BatchBar`, `GamesPage` |
| [ ] | Info / success messages (the app has no toast; these are in-page notices) | `.message.info`; green text in `GamesPage`, `PacksPage`, `PickScreen`, `TimeTest` |
| [ ] | Empty states | `.empty`, `.stage-empty`, `.board-hint`; "No ... yet" lines in `ProjectsPage`, `GamesPage`, `PacksPage`, `TranslatePage`, `RecentChats`, `PickScreen` |
| [ ] | Loading states | `.loading-page`, `.spinner`, `.progress-bar`, `.stage-overlay`; "Loading..." lines on every page |
| [ ] | Status badges | `GamesPage` (`STATUS`), `PacksPage` (`STATUS`), `BatchBar`, `Board` (batch chip), `.licence-badge`, `.soon`, `.badge` |
| [ ] | Drag-and-drop highlight | `Chat.tsx`, `TranslatePage.tsx`, `VoicePicker.tsx`, `.upload`, `.board-column.drop-target` |
| [ ] | Keyboard focus ring | `:focus-visible` in `styles.css` |

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
| `Generate.tsx` line 198 | `hsl(...)` gradient made from the model name, for the model thumbnail | Kept. It is a picture, not a theme colour. |
| `Generate.tsx` lines 204-208 | Five hex gradients for the "quick prompt" cards | Kept. They are small sample pictures. |
| `GamesPage.tsx` line 394 | `backgroundColor: colour` for a game's palette swatches | Kept. The colour is data from the game design file. |
| `ModelViewer.tsx` | Three.js scene (lights) | Checked: the background comes from CSS. |

Other inline styles only set sizes (width, height, object-fit). They have no colours.

## 7. Result

Filled in at the end of the task.
