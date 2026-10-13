"""
Family Tree Builder - FastAPI entry point.
"""
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from api import persons, relationships, tree
from session import BASE_DIR, UPLOADS_DIR, session_manager

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
logger = logging.getLogger(__name__)

STATIC_DIR = BASE_DIR / "static"
MAX_REQUEST_BYTES = 30 * 1024 * 1024  # JSON imports with embedded photos can be large


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Sessions do not survive a restart, so any photo left on disk is an orphan.
    UPLOADS_DIR.mkdir(exist_ok=True)
    removed = 0
    for path in UPLOADS_DIR.iterdir():
        if path.is_file():
            path.unlink(missing_ok=True)
            removed += 1
    if removed:
        logger.info("Removed %d orphaned upload(s)", removed)
    yield


app = FastAPI(
    title="Family Tree Builder",
    description="A web-based family tree creation and visualization tool",
    version="2.0.0",
    lifespan=lifespan,
)


@app.middleware("http")
async def limit_request_size(request: Request, call_next):
    length = request.headers.get("content-length")
    if length and length.isdigit() and int(length) > MAX_REQUEST_BYTES:
        return JSONResponse({"detail": "Request body too large"}, status_code=413)
    return await call_next(request)


app.include_router(persons.router)
app.include_router(relationships.router)
app.include_router(tree.router)

UPLOADS_DIR.mkdir(exist_ok=True)  # StaticFiles requires the directory at mount time
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")
app.mount("/uploads", StaticFiles(directory=UPLOADS_DIR), name="uploads")


@app.get("/", include_in_schema=False)
async def root():
    return FileResponse(STATIC_DIR / "index.html", headers={"Cache-Control": "no-cache"})


@app.get("/health")
async def health():
    return {"status": "healthy", "active_sessions": len(session_manager.sessions)}


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=8000)
