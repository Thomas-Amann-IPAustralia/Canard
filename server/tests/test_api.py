import json
import math
import random

import pytest
from fastapi.testclient import TestClient

from app.config import Settings
from app.main import create_app
from app.schema import EMBEDDING, METHOD_KEYS
from app.store import LocalStore

HEADER = "Title,Summary,Source link,Publication Date,Source type\n"
ORIGIN = "http://localhost:8000"


def make_csv(n, start=0, source_type="Report"):
    rows = [f"Entry {i},Summary for entry {i}.,https://example.com/{i},2024-01-{(i % 28) + 1:02d},{source_type}"
            for i in range(start, start + n)]
    return HEADER + "\n".join(rows) + "\n"


def unit_vector(seed):
    rng = random.Random(seed)
    v = [rng.uniform(-1, 1) for _ in range(EMBEDDING["dim"])]
    norm = math.sqrt(sum(x * x for x in v))
    return [x / norm for x in v]


def layout(count, seed=0):
    rng = random.Random(seed)
    return {k: [round(rng.uniform(-1, 1), 4) for _ in range(2 * count)] for k in METHOD_KEYS}


def upload_body(n, *, base_ids=(), plot_id=None, name="Test plot", password="admin-pw", csv=None, start=0):
    body = {
        "password": password,
        "filename": "sheet.csv",
        "csv": csv if csv is not None else make_csv(n, start),
        "vectors": [unit_vector(start + i) for i in range(n)],
        "baseIds": list(base_ids),
        "coords": layout(len(base_ids) + n),
        "layoutParams": {"tsne": {"perplexity": 5}},
        "embedding": {k: EMBEDDING[k] for k in ("model", "dtype", "pooling", "normalize", "dim")},
    }
    if plot_id:
        body["plotId"] = plot_id
    else:
        body["newPlot"] = {"name": name, "description": "A description"}
    return body


@pytest.fixture
def data_dir(tmp_path):
    return tmp_path / "data"


@pytest.fixture
def client(data_dir):
    settings = Settings(admin_password="admin-pw", tag_password="tag-pw", session_secret="s3cret",
                        allowed_origins=[ORIGIN], local_root=data_dir)
    app = create_app(settings, store=LocalStore(data_dir))
    with TestClient(app) as c:
        yield c


def read(data_dir, rel):
    return json.loads((data_dir / rel).read_text())


def test_health(client):
    r = client.get("/api/health", headers={"Origin": ORIGIN})
    assert r.status_code == 200
    assert r.json()["writable"] is True
    assert r.headers["access-control-allow-origin"] == ORIGIN


def test_cors_blocks_other_origins(client):
    r = client.options("/api/upload", headers={"Origin": "https://evil.example",
                                               "Access-Control-Request-Method": "POST"})
    assert "access-control-allow-origin" not in r.headers


def test_password_checks_and_rate_limit(client):
    assert client.post("/api/auth/check", json={"password": "admin-pw"}).status_code == 200
    assert client.post("/api/auth/check", json={"password": "tag-pw"}).status_code == 401
    for _ in range(9):
        assert client.post("/api/auth/check", json={"password": "nope"}).status_code == 401
    r = client.post("/api/auth/check", json={"password": "nope"})
    assert r.status_code == 429
    assert "Retry-After" in r.headers
    # Even the right password is refused while locked out.
    assert client.post("/api/auth/check", json={"password": "admin-pw"}).status_code == 429


def test_upload_creates_plot_and_files(client, data_dir):
    r = client.post("/api/upload", json=upload_body(5))
    assert r.status_code == 200, r.text
    out = r.json()
    pid, sid = out["plot"]["id"], out["sheet"]
    assert pid.startswith("test-plot-")
    assert out["plot"]["version"] == 1
    assert [p["id"] for p in out["points"]["points"]] == [f"{sid}-{i}" for i in range(2, 7)]
    index = read(data_dir, "index.json")
    assert index["plots"][0] == {**index["plots"][0], "id": pid, "points": 5, "sheets": 1, "version": 1}
    points = read(data_dir, f"plots/{pid}/points.json")
    assert len(points["coords"]["umap"]) == 10
    assert points["points"][0]["tags"] == []
    vectors = read(data_dir, f"plots/{pid}/sheets/{sid}/vectors.json")
    assert len(vectors["vectors"]) == 5 and len(vectors["vectors"][0]) == EMBEDDING["dim"]
    assert (data_dir / f"plots/{pid}/sheets/{sid}/source.csv").read_text().startswith("Title,Summary")
    # Points are stored one per line for readable diffs.
    assert (data_dir / f"plots/{pid}/points.json").read_text().count("\n") > 8


def test_upload_to_existing_plot_and_conflict(client):
    first = client.post("/api/upload", json=upload_body(3)).json()
    pid = first["plot"]["id"]
    ids = [p["id"] for p in first["points"]["points"]]
    stale = client.post("/api/upload", json=upload_body(2, base_ids=ids[:2], plot_id=pid, start=10))
    assert stale.status_code == 409
    assert stale.json()["error"]["code"] == "PLOT_CHANGED"
    ok = client.post("/api/upload", json=upload_body(2, base_ids=ids, plot_id=pid, start=10, csv=make_csv(2, 10, "report")))
    assert ok.status_code == 200, ok.text
    pts = ok.json()["points"]["points"]
    assert len(pts) == 5
    # Source type spelling is unified with the existing entries.
    assert {p["sourceType"] for p in pts} == {"Report"}
    assert ok.json()["plot"]["version"] == 2


def test_upload_rejects_invalid_csv(client):
    body = upload_body(2, csv=HEADER + "A,B,not-a-link,2024-01-01,R\nC,D,https://x.com,31/02/2024,R\n")
    r = client.post("/api/upload", json=body)
    assert r.status_code == 422
    problems = r.json()["error"]["problems"]
    assert [(p["code"], p["row"]) for p in problems] == [("INVALID_URL", 2), ("INVALID_DATE", 3)]


def test_upload_rejects_token_overflow(client):
    long = " ".join(["word"] * 600)
    r = client.post("/api/upload", json=upload_body(1, csv=HEADER + f"A,{long},https://x.com,2024-01-01,R\n"))
    assert r.status_code == 422
    assert r.json()["error"]["problems"][0]["code"] == "TOKEN_LIMIT"
    assert "Row 2" in r.json()["error"]["problems"][0]["message"]


def test_upload_rejects_bad_vectors_layout_and_password(client):
    body = upload_body(2)
    body["vectors"] = body["vectors"][:1]
    assert client.post("/api/upload", json=body).json()["error"]["code"] == "BAD_VECTORS"
    body = upload_body(2)
    body["vectors"][0] = [0.0] * EMBEDDING["dim"]
    assert client.post("/api/upload", json=body).json()["error"]["code"] == "BAD_VECTORS"
    body = upload_body(2)
    body["coords"]["tsne"] = body["coords"]["tsne"][:2]
    assert client.post("/api/upload", json=body).json()["error"]["code"] == "BAD_LAYOUT"
    body = upload_body(2)
    body["embedding"]["model"] = "other/model"
    assert client.post("/api/upload", json=body).json()["error"]["code"] == "MODEL_MISMATCH"
    assert client.post("/api/upload", json=upload_body(2, password="wrong")).status_code == 401


def test_tagging_requires_session(client, data_dir):
    out = client.post("/api/upload", json=upload_body(4)).json()
    pid = out["plot"]["id"]
    ids = [p["id"] for p in out["points"]["points"]]
    assert client.post(f"/api/plots/{pid}/tags", json={"ids": ids, "add": ["x"]}).status_code == 401
    assert client.post("/api/auth/session", json={"password": "wrong"}).status_code == 401
    token = client.post("/api/auth/session", json={"password": "tag-pw"}).json()["token"]
    auth = {"Authorization": f"Bearer {token}"}
    r = client.post(f"/api/plots/{pid}/tags", json={"ids": ids[:2], "add": ["  Policy  review ", "urgent"]}, headers=auth)
    assert r.status_code == 200, r.text
    assert r.json()["updates"] == {ids[0]: ["Policy review", "urgent"], ids[1]: ["Policy review", "urgent"]}
    # Same tag in a different case reuses the existing spelling; removal is case-insensitive.
    r = client.post(f"/api/plots/{pid}/tags", json={"ids": ids[1:3], "add": ["POLICY REVIEW"], "remove": ["Urgent"]},
                    headers=auth)
    assert r.json()["updates"] == {ids[1]: ["Policy review"], ids[2]: ["Policy review"]}
    points = read(data_dir, f"plots/{pid}/points.json")["points"]
    assert [p["tags"] for p in points] == [["Policy review", "urgent"], ["Policy review"], ["Policy review"], []]
    assert read(data_dir, "index.json")["plots"][0]["version"] == 3
    # The admin password also opens a tagging session.
    assert client.post("/api/auth/session", json={"password": "admin-pw"}).status_code == 200
    bad = client.post(f"/api/plots/{pid}/tags", json={"ids": ids, "add": ["x" * 41]}, headers=auth)
    assert bad.json()["error"]["code"] == "BAD_TAG"
    forged = {"Authorization": f"Bearer {token[:-2]}xx"}
    assert client.post(f"/api/plots/{pid}/tags", json={"ids": ids, "add": ["y"]}, headers=forged).status_code == 401


def test_delete_sheet_and_plot(client, data_dir):
    a = client.post("/api/upload", json=upload_body(3)).json()
    pid = a["plot"]["id"]
    ids = [p["id"] for p in a["points"]["points"]]
    b = client.post("/api/upload", json=upload_body(2, base_ids=ids, plot_id=pid, start=20)).json()
    coords_before = b["points"]["coords"]["pca"]
    sid_a = a["sheet"]
    r = client.post(f"/api/plots/{pid}/sheets/{sid_a}/delete", json={"password": "wrong"})
    assert r.status_code == 401
    r = client.post(f"/api/plots/{pid}/sheets/{sid_a}/delete", json={"password": "admin-pw"})
    assert r.status_code == 200, r.text
    out = r.json()
    assert len(out["points"]["points"]) == 2
    # The remaining points keep their coordinates.
    assert out["points"]["coords"]["pca"] == coords_before[6:]
    assert not (data_dir / f"plots/{pid}/sheets/{sid_a}").exists()
    assert [s["id"] for s in out["plot"]["sheets"]] == [b["sheet"]]
    r = client.post(f"/api/plots/{pid}/delete", json={"password": "admin-pw"})
    assert r.status_code == 200
    assert r.json()["index"]["plots"] == []
    assert not (data_dir / f"plots/{pid}").exists()
    assert client.post(f"/api/plots/{pid}/delete", json={"password": "admin-pw"}).status_code == 404


def test_data_proxy_is_restricted(client):
    out = client.post("/api/upload", json=upload_body(2)).json()
    pid = out["plot"]["id"]
    r = client.get(f"/api/data/plots/{pid}/points.json")
    assert r.status_code == 200 and r.headers["cache-control"] == "no-store"
    assert client.get("/api/data/index.json").json()["plots"][0]["id"] == pid
    assert client.get("/api/data/../server/app/config.py").status_code == 404
    assert client.get("/api/data/plots/x/secret.txt").status_code == 404


def test_read_only_without_admin_password(data_dir):
    app = create_app(Settings(session_secret="x", allowed_origins=[ORIGIN], local_root=data_dir),
                     store=LocalStore(data_dir))
    with TestClient(app) as c:
        assert c.get("/api/health").json()["writable"] is False
        r = c.post("/api/auth/check", json={"password": ""})
        assert r.status_code == 503
