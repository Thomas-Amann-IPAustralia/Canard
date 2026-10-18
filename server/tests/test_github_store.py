"""GitHubStore against an in-memory imitation of the GitHub Git Data API."""

import asyncio
import base64
import hashlib
import json

import httpx
import pytest

from app import operations as ops
from app.store import Change, GitHubStore

from .test_api import layout, make_csv, unit_vector


class FakeGitHub:
    """Just enough of the GitHub REST API for GitHubStore: refs, commits, trees, blobs, contents."""

    def __init__(self):
        self.blobs: dict[str, bytes] = {}
        self.trees: dict[str, dict[str, str]] = {}  # tree sha -> {path: blob sha}
        self.commits: dict[str, dict] = {}
        self.calls: list[str] = []
        self.conflicts_to_inject = 0
        root = self._tree({"README.md": self._blob(b"hello")})
        self.head = self._commit(root, [], "initial")

    def _sha(self, data: bytes) -> str:
        return hashlib.sha1(data).hexdigest()

    def _blob(self, content: bytes) -> str:
        sha = self._sha(b"blob" + content)
        self.blobs[sha] = content
        return sha

    def _tree(self, files: dict[str, str]) -> str:
        sha = self._sha(json.dumps(files, sort_keys=True).encode())
        self.trees[sha] = dict(files)
        return sha

    def _commit(self, tree: str, parents: list[str], message: str) -> str:
        sha = self._sha(f"{tree}{parents}{message}{len(self.commits)}".encode())
        self.commits[sha] = {"tree": tree, "parents": parents, "message": message}
        return sha

    def files_at_head(self) -> dict[str, bytes]:
        tree = self.trees[self.commits[self.head]["tree"]]
        return {path: self.blobs[sha] for path, sha in tree.items()}

    def handler(self, request: httpx.Request) -> httpx.Response:
        path = request.url.path
        self.calls.append(f"{request.method} {path}")
        repo = "/repos/o/r"
        assert request.headers["authorization"] == "Bearer tok"
        if request.method == "GET" and path == f"{repo}/git/ref/heads/main":
            return httpx.Response(200, json={"object": {"sha": self.head}})
        if request.method == "GET" and path.startswith(f"{repo}/git/commits/"):
            return httpx.Response(200, json={"tree": {"sha": self.commits[path.rsplit("/", 1)[1]]["tree"]}})
        if request.method == "GET" and path.startswith(f"{repo}/git/trees/"):
            tree = self.trees[path.rsplit("/", 1)[1]]
            return httpx.Response(200, json={"tree": [{"path": p, "type": "blob"} for p in tree]})
        if request.method == "GET" and path.startswith(f"{repo}/contents/"):
            file_path = path[len(f"{repo}/contents/"):]
            ref = request.url.params["ref"]
            commit = self.head if ref == "main" else ref
            tree = self.trees[self.commits[commit]["tree"]]
            if file_path not in tree:
                return httpx.Response(404, json={"message": "Not Found"})
            assert request.headers["accept"] == "application/vnd.github.raw+json"
            return httpx.Response(200, content=self.blobs[tree[file_path]])
        if request.method == "POST" and path == f"{repo}/git/blobs":
            body = json.loads(request.content)
            return httpx.Response(201, json={"sha": self._blob(base64.b64decode(body["content"]))})
        if request.method == "POST" and path == f"{repo}/git/trees":
            body = json.loads(request.content)
            files = dict(self.trees[body["base_tree"]])
            for entry in body["tree"]:
                if entry["sha"] is None:
                    files.pop(entry["path"], None)
                else:
                    files[entry["path"]] = entry["sha"]
            return httpx.Response(201, json={"sha": self._tree(files)})
        if request.method == "POST" and path == f"{repo}/git/commits":
            body = json.loads(request.content)
            assert body["author"]["name"] == "Canard"
            return httpx.Response(201, json={"sha": self._commit(body["tree"], body["parents"], body["message"])})
        if request.method == "PATCH" and path == f"{repo}/git/refs/heads/main":
            body = json.loads(request.content)
            if self.conflicts_to_inject:
                # Someone else pushed in between: move the branch on and refuse the update.
                self.conflicts_to_inject -= 1
                tree = dict(self.trees[self.commits[self.head]["tree"]])
                tree["other.txt"] = self._blob(b"concurrent change")
                self.head = self._commit(self._tree(tree), [self.head], "concurrent")
                return httpx.Response(422, json={"message": "Update is not a fast forward"})
            assert self.commits[body["sha"]]["parents"] == [self.head]
            self.head = body["sha"]
            return httpx.Response(200, json={"object": {"sha": self.head}})
        return httpx.Response(500, json={"message": f"unexpected {request.method} {path}"})


def make_store(fake):
    return GitHubStore("tok", "o/r", "main", "data", {"name": "Canard", "email": "c@example.com"},
                       transport=httpx.MockTransport(fake.handler))


def run(coro):
    return asyncio.run(coro)


def upload_op(n=3, base_ids=(), plot_id=None):
    from app.validation import validate_csv_text
    rows = validate_csv_text(make_csv(n))["rows"]
    sheet = {"rows": rows, "vectors": [unit_vector(i) for i in range(n)], "filename": "a.csv",
             "csv_text": make_csv(n), "kind": "spreadsheet"}
    return ops.upload(sheets=[sheet], coords=layout(len(base_ids) + n), base_ids=list(base_ids), plot_id=plot_id,
                      new_plot=None if plot_id else {"name": "My plot"}, embedding={}, layout_params={})


def test_upload_makes_a_single_commit():
    fake = FakeGitHub()
    store = make_store(fake)
    out = run(store.transaction(upload_op()))
    files = fake.files_at_head()
    pid, sid = out["plot"]["id"], out["sheet"]
    assert set(files) == {
        "README.md", "data/index.json", f"data/plots/{pid}/plot.json", f"data/plots/{pid}/points.json",
        f"data/plots/{pid}/sheets/{sid}/source.csv", f"data/plots/{pid}/sheets/{sid}/vectors.json",
    }
    assert fake.commits[fake.head]["message"] == 'Add 3 entries from a.csv to plot "My plot"'
    assert len(fake.commits) == 2
    assert json.loads(files["data/index.json"])["plots"][0]["points"] == 3


def test_transaction_retries_when_the_branch_moves():
    fake = FakeGitHub()
    store = make_store(fake)
    fake.conflicts_to_inject = 1
    out = run(store.transaction(upload_op()))
    files = fake.files_at_head()
    # The retry is based on the concurrent commit, so both changes survive.
    assert "other.txt" in files
    assert f"data/plots/{out['plot']['id']}/plot.json" in files


def test_delete_removes_listed_files_and_reads_are_fresh():
    fake = FakeGitHub()
    store = make_store(fake)
    out = run(store.transaction(upload_op()))
    pid = out["plot"]["id"]
    assert json.loads(run(store.read("index.json")))["plots"][0]["id"] == pid
    run(store.transaction(ops.delete_plot(pid)))
    files = fake.files_at_head()
    assert not any(p.startswith(f"data/plots/{pid}/") for p in files)
    assert json.loads(files["data/index.json"])["plots"] == []
    assert run(store.read(f"plots/{pid}/plot.json")) is None


def test_no_commit_when_nothing_changes():
    fake = FakeGitHub()
    store = make_store(fake)

    async def noop(reader):
        return Change(), {"ok": True}

    assert run(store.transaction(noop)) == {"ok": True}
    assert len(fake.commits) == 1


def test_github_auth_failure_is_reported():
    def handler(request):
        return httpx.Response(401, json={"message": "Bad credentials"})

    store = GitHubStore("tok", "o/r", "main", "data", {}, transport=httpx.MockTransport(handler))
    with pytest.raises(Exception) as exc:
        run(store.transaction(upload_op()))
    assert getattr(exc.value, "code", "") == "GITHUB_AUTH"
