"""Storage back ends for the data directory.

GitHubStore commits straight to the repository through the Git Data API, so each
change is a single atomic commit. LocalStore writes to a folder and is used for
local development and the tests.

Writes run as transactions: the operation reads the current state, returns the files
to change, and the store commits them. If someone else moved the branch in between,
the transaction re-runs on the new state.
"""

from __future__ import annotations

import asyncio
import base64
import logging
import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Awaitable, Callable

import httpx

from .errors import ApiError

log = logging.getLogger("canard")


@dataclass
class Change:
    """Files to write (bytes) or delete (None), keyed by path inside the data directory."""

    files: dict[str, bytes | None] = field(default_factory=dict)
    message: str = ""


class Reader:
    """Reads files at one snapshot of the store, caching within a transaction."""

    def __init__(self, fetch: Callable[[str], Awaitable[bytes | None]], lister: Callable[[str], Awaitable[list[str]]]):
        self._fetch = fetch
        self._lister = lister
        self._cache: dict[str, bytes | None] = {}

    async def read(self, path: str) -> bytes | None:
        if path not in self._cache:
            self._cache[path] = await self._fetch(path)
        return self._cache[path]

    async def list(self, prefix: str) -> list[str]:
        return await self._lister(prefix)


class RefConflict(Exception):
    pass


Operation = Callable[[Reader], Awaitable[tuple[Change, object]]]


class LocalStore:
    kind = "local"

    def __init__(self, root: Path):
        self.root = root
        self.lock = asyncio.Lock()
        self.root.mkdir(parents=True, exist_ok=True)

    def _path(self, path: str) -> Path:
        full = (self.root / path).resolve()
        if self.root.resolve() not in full.parents and full != self.root.resolve():
            raise ValueError(f"path escapes the data directory: {path}")
        return full

    async def read(self, path: str) -> bytes | None:
        p = self._path(path)
        return p.read_bytes() if p.is_file() else None

    async def list(self, prefix: str) -> list[str]:
        base = self._path(prefix)
        if not base.exists():
            return []
        return sorted(str(p.relative_to(self.root)).replace(os.sep, "/") for p in base.rglob("*") if p.is_file())

    async def transaction(self, operation: Operation):
        async with self.lock:
            change, result = await operation(Reader(self.read, self.list))
            for path, content in change.files.items():
                p = self._path(path)
                if content is None:
                    if p.exists():
                        p.unlink()
                    parent = p.parent
                    while parent != self.root.resolve() and parent.exists() and not any(parent.iterdir()):
                        parent.rmdir()
                        parent = parent.parent
                else:
                    p.parent.mkdir(parents=True, exist_ok=True)
                    tmp = p.with_name(p.name + ".tmp")
                    tmp.write_bytes(content)
                    tmp.replace(p)
            return result

    async def close(self) -> None:
        return None


class GitHubStore:
    kind = "github"

    def __init__(self, token: str, repo: str, branch: str, data_dir: str, author: dict,
                 transport: httpx.AsyncBaseTransport | None = None):
        self.repo = repo
        self.branch = branch
        self.data_dir = data_dir.strip("/")
        self.author = author
        self.lock = asyncio.Lock()
        self.client = httpx.AsyncClient(
            base_url="https://api.github.com",
            headers={
                "Authorization": f"Bearer {token}",
                "Accept": "application/vnd.github+json",
                "X-GitHub-Api-Version": "2022-11-28",
                "User-Agent": "canard-api",
            },
            timeout=httpx.Timeout(30.0, connect=10.0),
            transport=transport,
        )

    def _full(self, path: str) -> str:
        return f"{self.data_dir}/{path}" if self.data_dir else path

    async def _request(self, method: str, url: str, **kwargs) -> httpx.Response:
        for attempt in range(3):
            try:
                resp = await self.client.request(method, url, **kwargs)
            except httpx.TransportError as exc:
                if attempt == 2:
                    raise ApiError(502, "GITHUB_UNREACHABLE", "Could not reach GitHub. Please try again.") from exc
                await asyncio.sleep(0.5 * (attempt + 1))
                continue
            if resp.status_code >= 500 and attempt < 2:
                await asyncio.sleep(0.5 * (attempt + 1))
                continue
            return resp
        return resp  # pragma: no cover

    def _fail(self, resp: httpx.Response, action: str) -> ApiError:
        log.error("GitHub %s failed: %s %s", action, resp.status_code, resp.text[:500])
        if resp.status_code in (401, 403):
            return ApiError(502, "GITHUB_AUTH", "The server's GitHub token was rejected. Check GITHUB_TOKEN in Render.")
        return ApiError(502, "GITHUB_ERROR", f"GitHub returned an error while trying to {action}.")

    async def head(self) -> tuple[str, str]:
        resp = await self._request("GET", f"/repos/{self.repo}/git/ref/heads/{self.branch}")
        if resp.status_code != 200:
            raise self._fail(resp, "read the branch")
        commit = resp.json()["object"]["sha"]
        resp = await self._request("GET", f"/repos/{self.repo}/git/commits/{commit}")
        if resp.status_code != 200:
            raise self._fail(resp, "read the latest commit")
        return commit, resp.json()["tree"]["sha"]

    async def read_at(self, path: str, ref: str) -> bytes | None:
        resp = await self._request(
            "GET", f"/repos/{self.repo}/contents/{self._full(path)}",
            params={"ref": ref}, headers={"Accept": "application/vnd.github.raw+json"},
        )
        if resp.status_code == 404:
            return None
        if resp.status_code != 200:
            raise self._fail(resp, f"read {path}")
        return resp.content

    async def read(self, path: str) -> bytes | None:
        return await self.read_at(path, self.branch)

    async def list_at(self, prefix: str, tree: str) -> list[str]:
        resp = await self._request("GET", f"/repos/{self.repo}/git/trees/{tree}", params={"recursive": "1"})
        if resp.status_code != 200:
            raise self._fail(resp, "list files")
        full_prefix = self._full(prefix).rstrip("/") + "/"
        strip = len(self.data_dir) + 1 if self.data_dir else 0
        return sorted(
            item["path"][strip:] for item in resp.json().get("tree", [])
            if item.get("type") == "blob" and item["path"].startswith(full_prefix)
        )

    async def _commit(self, base_commit: str, base_tree: str, change: Change) -> str:
        entries = []
        for path, content in change.files.items():
            entry = {"path": self._full(path), "mode": "100644", "type": "blob"}
            if content is None:
                entry["sha"] = None
            else:
                resp = await self._request("POST", f"/repos/{self.repo}/git/blobs", json={
                    "content": base64.b64encode(content).decode("ascii"), "encoding": "base64"})
                if resp.status_code != 201:
                    raise self._fail(resp, "upload a file")
                entry["sha"] = resp.json()["sha"]
            entries.append(entry)
        resp = await self._request("POST", f"/repos/{self.repo}/git/trees", json={"base_tree": base_tree, "tree": entries})
        if resp.status_code != 201:
            raise self._fail(resp, "build the commit")
        tree = resp.json()["sha"]
        resp = await self._request("POST", f"/repos/{self.repo}/git/commits", json={
            "message": change.message, "tree": tree, "parents": [base_commit], "author": self.author})
        if resp.status_code != 201:
            raise self._fail(resp, "create the commit")
        commit = resp.json()["sha"]
        resp = await self._request("PATCH", f"/repos/{self.repo}/git/refs/heads/{self.branch}",
                                   json={"sha": commit, "force": False})
        if resp.status_code == 422:
            raise RefConflict()
        if resp.status_code != 200:
            raise self._fail(resp, "update the branch")
        return commit

    async def transaction(self, operation: Operation):
        async with self.lock:
            for attempt in range(4):
                commit, tree = await self.head()
                reader = Reader(lambda p, c=commit: self.read_at(p, c), lambda p, t=tree: self.list_at(p, t))
                change, result = await operation(reader)
                if not change.files:
                    return result
                try:
                    await self._commit(commit, tree, change)
                    return result
                except RefConflict:
                    log.info("Branch moved during commit; retrying (attempt %s)", attempt + 1)
                    await asyncio.sleep(0.4 * (attempt + 1))
            raise ApiError(503, "BUSY", "The repository changed several times while saving. Please try again.")

    async def close(self) -> None:
        await self.client.aclose()
