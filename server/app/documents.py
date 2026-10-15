"""Reading and writing the JSON documents kept in the data directory.

Layout (paths relative to the data directory):

    index.json                              list of plots
    plots/<plot>/plot.json                  plot details, embedding model, spreadsheets
    plots/<plot>/points.json                every entry with tags and 2-D coordinates
    plots/<plot>/sheets/<sheet>/source.csv  the spreadsheet as uploaded
    plots/<plot>/sheets/<sheet>/vectors.json the embedding vector of each entry

Documents are written with one entry per line so that git diffs stay readable.
"""

from __future__ import annotations

import json
import re
import secrets
import string
from datetime import datetime, timezone

SCHEMA = 1
_ALPHABET = string.ascii_lowercase + string.digits


def now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def random_suffix(length: int = 4) -> str:
    return "".join(secrets.choice(_ALPHABET) for _ in range(length))


def slugify(name: str, max_len: int = 40) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")
    return slug[:max_len].strip("-") or "plot"


def compact(value) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def dumps_doc(doc: dict, rows: tuple[str, ...] = (), keyed_rows: tuple[str, ...] = ()) -> bytes:
    """Pretty-print a document: `rows` lists get one item per line, `keyed_rows` dicts one key per line."""
    parts = []
    for key, value in doc.items():
        k = json.dumps(key)
        if key in rows and isinstance(value, list) and value:
            items = ",\n".join("    " + compact(v) for v in value)
            parts.append(f"  {k}: [\n{items}\n  ]")
        elif key in keyed_rows and isinstance(value, dict) and value:
            items = ",\n".join(f"    {json.dumps(kk)}: {compact(vv)}" for kk, vv in value.items())
            parts.append(f"  {k}: {{\n{items}\n  }}")
        else:
            parts.append(f"  {k}: {compact(value)}")
    return ("{\n" + ",\n".join(parts) + "\n}\n").encode("utf-8")


def loads(data: bytes | None):
    return None if data is None else json.loads(data.decode("utf-8"))


def empty_index() -> dict:
    return {"schema": SCHEMA, "updated": now_iso(), "plots": []}


def dump_index(index: dict) -> bytes:
    return dumps_doc(index, rows=("plots",))


def dump_plot(plot: dict) -> bytes:
    return dumps_doc(plot, rows=("sheets",))


def dump_points(points: dict) -> bytes:
    return dumps_doc(points, rows=("points",), keyed_rows=("coords",))


def dump_vectors(doc: dict) -> bytes:
    return dumps_doc(doc, rows=("ids", "vectors"))


def index_entry(plot: dict, point_count: int) -> dict:
    return {
        "id": plot["id"],
        "name": plot["name"],
        "description": plot.get("description", ""),
        "created": plot["created"],
        "updated": plot["updated"],
        "version": plot["version"],
        "points": point_count,
        "sheets": len(plot.get("sheets", [])),
    }


def plot_path(plot_id: str, name: str) -> str:
    return f"plots/{plot_id}/{name}"


def sheet_dir(plot_id: str, sheet_id: str) -> str:
    return f"plots/{plot_id}/sheets/{sheet_id}/"
