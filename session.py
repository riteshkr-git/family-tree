"""
In-memory, per-cookie session state.

The app is deliberately stateless across restarts: every browser session owns one
FamilyTree with undo/redo history, kept only in process memory. Photos uploaded in a
session are tracked so they can be removed from disk when the session is evicted.
"""
import logging
import time
import uuid
from copy import deepcopy
from pathlib import Path
from typing import Dict, Optional, Set, Tuple

from fastapi import Request, Response

from models import FamilyTree

logger = logging.getLogger(__name__)

BASE_DIR = Path(__file__).resolve().parent
UPLOADS_DIR = BASE_DIR / "uploads"

SESSION_COOKIE_NAME = "family_tree_session"
SESSION_MAX_AGE = 86400 * 7        # seconds of inactivity before a session is dropped
MAX_SESSIONS = 100                 # memory protection
SESSION_CLEANUP_INTERVAL = 3600    # how often to sweep idle sessions
MAX_HISTORY = 50


class TreeState:
    """One user's tree plus undo/redo stacks and the photos it owns on disk."""

    def __init__(self) -> None:
        self.tree = FamilyTree()
        self.undo_stack: list[Tuple[str, FamilyTree]] = []
        self.redo_stack: list[Tuple[str, FamilyTree]] = []
        self.photos: Set[str] = set()
        self.last_accessed = time.time()

    def touch(self) -> None:
        self.last_accessed = time.time()

    def save_state(self, action: str) -> None:
        """Snapshot the tree before a mutation so it can be undone."""
        self.undo_stack.append((action, deepcopy(self.tree)))
        if len(self.undo_stack) > MAX_HISTORY:
            self.undo_stack.pop(0)
        self.redo_stack.clear()
        self.touch()

    def undo(self) -> bool:
        if not self.undo_stack:
            return False
        action, state = self.undo_stack.pop()
        self.redo_stack.append((action, self.tree))
        self.tree = state
        self.touch()
        return True

    def redo(self) -> bool:
        if not self.redo_stack:
            return False
        action, state = self.redo_stack.pop()
        self.undo_stack.append((action, self.tree))
        self.tree = state
        self.touch()
        return True

    def can_undo(self) -> bool:
        return bool(self.undo_stack)

    def can_redo(self) -> bool:
        return bool(self.redo_stack)

    def register_photo(self, filename: str) -> None:
        self.photos.add(filename)


def _delete_photos(filenames: Set[str]) -> None:
    for name in filenames:
        try:
            (UPLOADS_DIR / name).unlink(missing_ok=True)
        except OSError as exc:
            logger.warning("Could not delete photo %s: %s", name, exc)


class SessionManager:
    def __init__(self) -> None:
        self.sessions: Dict[str, TreeState] = {}
        self.last_cleanup = time.time()

    def get_or_create_session(self, session_id: Optional[str]) -> Tuple[str, TreeState]:
        self._cleanup_old_sessions()

        if session_id and session_id in self.sessions:
            state = self.sessions[session_id]
            state.touch()
            return session_id, state

        if len(self.sessions) >= MAX_SESSIONS:
            oldest_id = min(self.sessions, key=lambda k: self.sessions[k].last_accessed)
            self._evict(oldest_id, "capacity")

        new_id = str(uuid.uuid4())
        self.sessions[new_id] = TreeState()
        logger.info("Created session %s", new_id[:8])
        return new_id, self.sessions[new_id]

    def _evict(self, session_id: str, reason: str) -> None:
        state = self.sessions.pop(session_id, None)
        if state is None:
            return
        _delete_photos(state.photos)
        logger.info("Evicted session %s (%s)", session_id[:8], reason)

    def _cleanup_old_sessions(self) -> None:
        now = time.time()
        if now - self.last_cleanup < SESSION_CLEANUP_INTERVAL:
            return
        self.last_cleanup = now
        expired = [sid for sid, s in self.sessions.items() if now - s.last_accessed > SESSION_MAX_AGE]
        for sid in expired:
            self._evict(sid, "expired")


session_manager = SessionManager()


def get_tree_state(request: Request, response: Response) -> TreeState:
    """FastAPI dependency: resolve (or create) the caller's session and refresh its cookie."""
    incoming = request.cookies.get(SESSION_COOKIE_NAME)
    session_id, state = session_manager.get_or_create_session(incoming)

    secure = request.url.scheme == "https" or request.headers.get("x-forwarded-proto") == "https"
    response.set_cookie(
        key=SESSION_COOKIE_NAME,
        value=session_id,
        max_age=SESSION_MAX_AGE,
        httponly=True,
        samesite="lax",
        secure=secure,
    )
    return state
