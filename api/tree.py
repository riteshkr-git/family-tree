"""
Whole-tree endpoints: fetch, new, undo/redo, auto-layout, photo upload, JSON import/export.
"""
import base64
import logging
import os
import uuid
from copy import deepcopy
from typing import Optional

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from fastapi.responses import JSONResponse

from models import FamilyTree, LayoutOptions
from services.layout_service import calculate_layout
from session import UPLOADS_DIR, TreeState, get_tree_state

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/tree", tags=["tree"])

MAX_PHOTO_BYTES = 5 * 1024 * 1024
MAX_PERSONS = 10_000

_MIME_BY_EXT = {"jpg": "image/jpeg", "png": "image/png", "gif": "image/gif", "webp": "image/webp"}


def _sniff_image(data: bytes) -> Optional[str]:
    """Return the extension for a supported image by magic bytes, else None."""
    if data[:3] == b"\xff\xd8\xff":
        return "jpg"
    if data[:8] == b"\x89PNG\r\n\x1a\n":
        return "png"
    if data[:6] in (b"GIF87a", b"GIF89a"):
        return "gif"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "webp"
    return None


def _store_photo(data: bytes, state: TreeState) -> str:
    """Validate, write under a random name, register with the session. Returns the relative path."""
    if len(data) > MAX_PHOTO_BYTES:
        raise HTTPException(status_code=413, detail="Photo must be 5 MB or smaller")
    ext = _sniff_image(data)
    if ext is None:
        raise HTTPException(status_code=400, detail="Only JPEG, PNG, GIF and WebP images are accepted")

    UPLOADS_DIR.mkdir(exist_ok=True)
    filename = f"{uuid.uuid4()}.{ext}"
    (UPLOADS_DIR / filename).write_bytes(data)
    state.register_photo(filename)
    return f"uploads/{filename}"


@router.get("")
async def get_tree(state: TreeState = Depends(get_tree_state)):
    return {
        "tree": state.tree.model_dump(exclude={"persons": {"__all__": {"photo_base64"}}}),
        "can_undo": state.can_undo(),
        "can_redo": state.can_redo(),
    }


@router.post("/new")
async def new_tree(state: TreeState = Depends(get_tree_state)):
    state.save_state("new_tree")
    state.tree = FamilyTree()
    return {"status": "created"}


@router.post("/undo")
async def undo(state: TreeState = Depends(get_tree_state)):
    if not state.undo():
        raise HTTPException(status_code=400, detail="Nothing to undo")
    return {"status": "undone", "can_undo": state.can_undo(), "can_redo": state.can_redo()}


@router.post("/redo")
async def redo(state: TreeState = Depends(get_tree_state)):
    if not state.redo():
        raise HTTPException(status_code=400, detail="Nothing to redo")
    return {"status": "redone", "can_undo": state.can_undo(), "can_redo": state.can_redo()}


@router.post("/layout")
async def auto_layout(options: LayoutOptions, state: TreeState = Depends(get_tree_state)):
    if options.root_person_id not in state.tree.persons:
        raise HTTPException(status_code=404, detail="Root person not found")

    state.save_state("auto_layout")
    positions = calculate_layout(state.tree, options)
    for person_id, pos in positions.items():
        person = state.tree.persons.get(person_id)
        if person is not None:
            person.x = pos["x"]
            person.y = pos["y"]
    return {"status": "layout_applied", "positions": positions}


@router.post("/upload-photo")
async def upload_photo(file: UploadFile = File(...), state: TreeState = Depends(get_tree_state)):
    data = await file.read(MAX_PHOTO_BYTES + 1)
    path = _store_photo(data, state)
    return {"status": "uploaded", "path": path, "filename": os.path.basename(path)}


@router.get("/export-json")
async def export_json(state: TreeState = Depends(get_tree_state)):
    """Tree as JSON with photos embedded as base64 data URLs, for client download."""
    export_data = deepcopy(state.tree.model_dump())
    for person in export_data["persons"].values():
        person["photo_base64"] = None
        if not person.get("photo_path"):
            continue
        photo_path = UPLOADS_DIR / os.path.basename(person["photo_path"])
        if not photo_path.is_file():
            person["photo_path"] = None
            continue
        ext = photo_path.suffix.lstrip(".").lower()
        mime = _MIME_BY_EXT.get("jpg" if ext == "jpeg" else ext, "image/jpeg")
        encoded = base64.b64encode(photo_path.read_bytes()).decode("ascii")
        person["photo_base64"] = f"data:{mime};base64,{encoded}"
    return JSONResponse(content=export_data)


@router.post("/import-json")
async def import_json(tree_data: FamilyTree, state: TreeState = Depends(get_tree_state)):
    """Replace the session's tree with an uploaded JSON file, restoring embedded photos."""
    if len(tree_data.persons) > MAX_PERSONS:
        raise HTTPException(status_code=413, detail=f"Trees are limited to {MAX_PERSONS} people")

    for person_id, person in tree_data.persons.items():
        person.id = person_id  # the dict key is authoritative
        restored = None
        if person.photo_base64:
            try:
                payload = person.photo_base64.split(",", 1)[1] if person.photo_base64.startswith("data:") else person.photo_base64
                restored = _store_photo(base64.b64decode(payload, validate=True), state)
            except (HTTPException, ValueError) as exc:
                logger.warning("Dropped photo for %s: %s", person.name, getattr(exc, "detail", exc))
        elif person.photo_path:
            # Re-importing a file exported in this same process: keep the photo if it still exists
            existing = UPLOADS_DIR / os.path.basename(person.photo_path)
            if existing.is_file():
                restored = f"uploads/{existing.name}"
        person.photo_path = restored
        person.photo_base64 = None

    # Drop relationships that reference people or marriages not in the file
    tree_data.marriages = {
        m_id: m for m_id, m in tree_data.marriages.items()
        if m.spouse1_id in tree_data.persons and m.spouse2_id in tree_data.persons and m.spouse1_id != m.spouse2_id
    }
    for m_id, m in tree_data.marriages.items():
        m.id = m_id
    tree_data.parent_child = [
        pc for pc in tree_data.parent_child
        if pc.parent_id in tree_data.persons and pc.child_id in tree_data.persons and pc.parent_id != pc.child_id
    ]
    for pc in tree_data.parent_child:
        if pc.marriage_id and pc.marriage_id not in tree_data.marriages:
            pc.marriage_id = None

    state.save_state("import_json")
    state.tree = tree_data
    return {"status": "imported", "persons": len(tree_data.persons)}
