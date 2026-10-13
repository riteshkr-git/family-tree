# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

Family Tree Builder: a FastAPI backend serving a vanilla-JS single-page app (`static/`) for building and
visualizing family trees. No database, no build step, no bundler, no test suite, no linter config.
Runtime dependencies are only FastAPI, uvicorn, pydantic and python-multipart; there are no compiled
or system-library dependencies, and that is a deliberate constraint (keep the Docker image slim).

## Commands

```bash
# Setup (venv/ is gitignored; a local one already exists)
python3 -m venv venv && source venv/bin/activate
pip install -r requirements.txt

# Run dev server with reload -> http://localhost:8000
uvicorn main:app --reload

# Docker (what Render.com uses via render.yaml)
docker build -t family-tree . && docker run -p 8000:8000 family-tree

# Health check
curl localhost:8000/health
```

There are no automated tests. The practical check is to run the server and exercise the API with curl
or drive the UI in a headless browser.

## Architecture

### Stateless, per-session, in-memory state

There is no server-side persistence. `session.py` holds a `SessionManager` keyed by the
`family_tree_session` cookie; each session owns a `TreeState` (a `FamilyTree` Pydantic model plus
undo/redo stacks of deep copies, capped at 50) and the set of photo filenames it uploaded. Sessions are
evicted after 7 days idle or when the 100-session cap is hit, and eviction deletes their photos. On
startup every file in `uploads/` is removed, since no session can reference it. Persistence is the
user's job via File → Save as JSON / Open JSON (`/api/tree/export-json` embeds photos as base64 data
URLs; `/api/tree/import-json` decodes them back into `uploads/` under fresh UUID names).

Rules when editing:
- Any mutating endpoint must call `state.save_state("<action>")` **before** mutating so undo works.
  The batch position update deliberately skips this (drags would flood the history).
- Photo files are only ever written by `_store_photo()` in `api/tree.py`, which validates magic bytes,
  enforces the 5 MB cap and names the file with a UUID. Never trust a client-supplied filename or id
  when touching the filesystem.
- `uploads/` is ephemeral and gitignored. `data/` and `exports/` are leftovers from an earlier
  stateful design and are unused.

### Request plumbing

Handlers take `state: TreeState = Depends(get_tree_state)` from `session.py`; the dependency resolves
the cookie, creates a session if needed and re-sets the cookie (with `secure` when the request arrived
over HTTPS). A middleware in `main.py` rejects bodies over 30 MB by `Content-Length`.

### Data model (`models.py`)

`FamilyTree` = `persons: dict[id, Person]`, `marriages: dict[id, Marriage]`, `parent_child: list[ParentChild]`.
A `ParentChild` may carry a `marriage_id` grouping the child under a specific couple. Deleting a person
cascades to their marriages and parent-child rows and clears `marriage_id` on orphaned rows; deleting a
marriage only clears `marriage_id`. `add_child` rejects cycles; `create_marriage` rejects self and
duplicate pairs. `gender` is coerced to `unknown` for unrecognised values so old JSON files still import.
Person `x`/`y` are canvas coordinates (the centre of the card) stored server-side.

### Auto-arrange (`services/layout_service.py`)

Generations are assigned by BFS over the whole connected component of the chosen root (parents −1,
spouses equal), then a DFS from the founders (people with no parents) assigns x positions, centring
couples over their descendants and descendants under their couple. Other components are appended to
the right. `left-right` simply swaps x and y at the end. The frontend passes spacing derived from the
current card size.

### Frontend (`static/`)

Four plain scripts loaded in order, sharing globals:
- `js/app.js`: `AppState`, the `API` fetch wrapper, DOM helpers (`el`, `icon`, `avatarEl`), the
  `Modal` stack and `confirmDialog()`, theme and appearance settings (persisted in `localStorage`),
  toolbar, keyboard shortcuts, context menu, side panel, and `loadTreeData()` which refetches `/api/tree`
  and re-renders.
- `js/tree-renderer.js`: `TreeRenderer`. Owns node geometry (card centred on `x,y`, avatar circle
  straddling the top edge; sizes derive from `nodeWidth` and `avatarSize`), pan/zoom/pinch via Pointer
  Events, drag with rAF-throttled in-place updates (`moveNodes`) rather than full re-renders, and
  `fitToContent()`.
- `js/forms.js`: `Forms`. All modals for people, spouses, children, marriages and arrange. Photos are
  downscaled with `resizeImage()` before upload. Positions for new spouses/children are computed
  client-side; the spouse flow creates the person and marriage first and shifts neighbours last so
  undo restores unshifted positions.
- `js/export.js`: `Exporter`. Clones the SVG layers into a standalone SVG with resolved theme colours,
  inlined photo data URLs and (best effort) the embedded Google font, rasterises via `<img>` + canvas,
  and wraps PDFs with jsPDF loaded on demand from cdnjs. Canvas area is capped to avoid OOM on mobile.

Never insert user text with `innerHTML`; build DOM with `el()` / `textContent`. The pattern for any
UI change is: mutate via `API` → `loadTreeData()` → `TreeRenderer.render()`. Styles live in a single
`css/styles.css` with design tokens on `:root` and a `[data-theme="dark"]` override; SVG nodes are
styled through those same tokens so the theme toggle needs no re-render.
