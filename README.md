# Family Tree Builder

A lightweight, web-based tool for creating, visualising and sharing family trees. FastAPI on the
back end, plain HTML/CSS/JS on the front end, no database and no build step.

## Features

- **Interactive canvas**: drag people, pan and zoom, pinch on touch screens, multi-select and move
  whole branches together.
- **Relationships**: spouses with marriage dates, children linked to a specific marriage, auto-arrange
  by generation (top-down or left-right).
- **Photos**: resized in the browser before upload; shown as circular avatars with initials as fallback.
- **Undo / redo** for every edit.
- **Light and dark themes**, adjustable card size, photo size, font and gender colours.
- **Export**: PNG, JPG or PDF rendered in the browser exactly as shown on screen (photos, colours and
  fonts included). Save and reopen trees as JSON with photos embedded.

## Run locally

```bash
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
uvicorn main:app --reload
```

Open <http://localhost:8000>.

## Deploy

The app is stateless: each browser session keeps its tree in server memory for up to seven days of
inactivity, and nothing survives a restart. Use **File → Save as JSON** to keep your work and
**File → Open JSON** to restore it.

### Docker

```bash
docker build -t family-tree .
docker run -p 8000:8000 family-tree
```

The image is a single `python:3.12-slim` stage with four Python packages and no system libraries.
It honours a `PORT` environment variable and runs as a non-root user.

### Render.com

Push to GitHub, create a Web Service from the repo and Render will pick up `render.yaml`.

## Project layout

- `main.py`: app factory, static mounts, request size limit, startup cleanup of orphaned uploads.
- `session.py`: per-cookie in-memory sessions with undo/redo history and photo tracking.
- `models.py`: Pydantic models.
- `api/`: routers for persons, relationships (marriages, parent-child) and whole-tree operations.
- `services/layout_service.py`: generation-aware auto-arrange.
- `static/`: the front end (`js/app.js` shell and state, `js/tree-renderer.js` SVG canvas,
  `js/forms.js` modals, `js/export.js` browser-side image/PDF export).

## License

MIT, see [LICENSE](LICENSE).
