"""Runtime configuration, read from environment variables (set them in Render)."""

from __future__ import annotations

import logging
import os
import secrets
from dataclasses import dataclass, field
from pathlib import Path

log = logging.getLogger("canard")

REPO_ROOT = Path(__file__).resolve().parents[2]

DEFAULT_ORIGINS = (
    "https://thomas-amann-ipaustralia.github.io,"
    "http://localhost:8000,http://127.0.0.1:8000"
)


def _env(name: str, default: str = "") -> str:
    return os.environ.get(name, default).strip()


@dataclass
class Settings:
    admin_password: str = ""
    tag_password: str = ""
    session_secret: str = ""
    session_hours: float = 12.0
    allowed_origins: list[str] = field(default_factory=list)
    store: str = "local"
    github_token: str = ""
    github_repo: str = ""
    github_branch: str = "main"
    data_dir: str = "data"
    local_root: Path = REPO_ROOT / "data"
    commit_name: str = "Canard"
    commit_email: str = "canard@users.noreply.github.com"

    @property
    def writable(self) -> bool:
        return bool(self.admin_password)

    @classmethod
    def from_env(cls) -> "Settings":
        token = _env("GITHUB_TOKEN")
        secret = _env("CANARD_SESSION_SECRET")
        if not secret:
            # Tokens then only survive until the next restart (Render's free tier sleeps
            # after 15 minutes), so set CANARD_SESSION_SECRET in production.
            secret = secrets.token_urlsafe(32)
            log.warning("CANARD_SESSION_SECRET is not set; tagging sessions end when the server restarts.")
        admin = _env("CANARD_ADMIN_PASSWORD")
        if not admin:
            log.warning("CANARD_ADMIN_PASSWORD is not set; uploads, deletions and tagging are disabled.")
        return cls(
            admin_password=admin,
            tag_password=_env("CANARD_TAG_PASSWORD") or admin,
            session_secret=secret,
            session_hours=float(_env("CANARD_SESSION_HOURS", "12") or 12),
            allowed_origins=[
                o.strip().rstrip("/") for o in _env("CANARD_ALLOWED_ORIGINS", DEFAULT_ORIGINS).split(",") if o.strip()
            ],
            store=_env("CANARD_STORE", "github" if token else "local"),
            github_token=token,
            github_repo=_env("GITHUB_REPO", "Thomas-Amann-IPAustralia/Canard"),
            github_branch=_env("GITHUB_BRANCH", "main"),
            data_dir=_env("CANARD_DATA_DIR", "data").strip("/"),
            local_root=Path(_env("CANARD_LOCAL_ROOT", str(REPO_ROOT / "data"))),
            commit_name=_env("CANARD_COMMIT_NAME", "Canard"),
            commit_email=_env("CANARD_COMMIT_EMAIL", "canard@users.noreply.github.com"),
        )
