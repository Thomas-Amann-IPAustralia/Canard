"""The write operations. Each returns an async function that, given a Reader for the
current state, produces the files to change and the response for the client. They have
no side effects, so the store can safely re-run them if the branch moves."""

from __future__ import annotations

import math
import re

from . import documents as docs
from .errors import ApiError
from .schema import EMBEDDING, LIMITS, METHOD_KEYS
from .store import Change, Reader

_PLOT_ID_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,60}\Z")
_SHEET_ID_RE = re.compile(r"^s[0-9]{8}-[a-z0-9]{4,8}\Z")
_CONTROL_RE = re.compile(r"[\x00-\x1f\x7f]")
_SPACE_RE = re.compile(r"\s+")


def check_plot_id(plot_id: str) -> str:
    if not _PLOT_ID_RE.match(plot_id):
        raise ApiError(404, "PLOT_NOT_FOUND", "That plot does not exist.")
    return plot_id


def check_sheet_id(sheet_id: str) -> str:
    if not _SHEET_ID_RE.match(sheet_id):
        raise ApiError(404, "SHEET_NOT_FOUND", "That spreadsheet does not exist in this plot.")
    return sheet_id


async def _load_index(reader: Reader) -> dict:
    return docs.loads(await reader.read("index.json")) or docs.empty_index()


async def _load_plot(reader: Reader, plot_id: str) -> tuple[dict, dict]:
    plot = docs.loads(await reader.read(docs.plot_path(plot_id, "plot.json")))
    if plot is None:
        raise ApiError(404, "PLOT_NOT_FOUND", "That plot does not exist. It may have been deleted.")
    points = docs.loads(await reader.read(docs.plot_path(plot_id, "points.json")))
    if points is None:
        points = {"schema": docs.SCHEMA, "plot": plot_id, "version": plot["version"], "methods": METHOD_KEYS,
                  "points": [], "coords": {k: [] for k in METHOD_KEYS}}
    return plot, points


def _upsert_index(index: dict, plot: dict, point_count: int) -> dict:
    entry = docs.index_entry(plot, point_count)
    plots = [p for p in index.get("plots", []) if p["id"] != plot["id"]]
    existing = next((i for i, p in enumerate(index.get("plots", [])) if p["id"] == plot["id"]), None)
    if existing is None:
        plots.append(entry)
    else:
        plots.insert(existing, entry)
    return {**index, "schema": docs.SCHEMA, "updated": plot["updated"], "plots": plots}


def _round(values, places: int) -> list[float]:
    return [round(float(v), places) for v in values]


def validate_vectors(vectors: list[list[float]], expected_rows: int) -> None:
    dim = EMBEDDING["dim"]
    if len(vectors) != expected_rows:
        raise ApiError(400, "BAD_VECTORS", f"Expected {expected_rows} embedding vectors but received {len(vectors)}.")
    for i, v in enumerate(vectors):
        if len(v) != dim:
            raise ApiError(400, "BAD_VECTORS", f"Embedding {i + 1} has {len(v)} dimensions; expected {dim}.")
        norm = 0.0
        for x in v:
            if not math.isfinite(x):
                raise ApiError(400, "BAD_VECTORS", f"Embedding {i + 1} contains an invalid number.")
            norm += x * x
        if abs(math.sqrt(norm) - 1) > 0.02:
            raise ApiError(400, "BAD_VECTORS", f"Embedding {i + 1} is not normalised.")


def validate_coords(coords: dict[str, list[float]], count: int) -> dict[str, list[float]]:
    if set(coords) != set(METHOD_KEYS):
        raise ApiError(400, "BAD_LAYOUT", f"Layouts must be provided for: {', '.join(METHOD_KEYS)}.")
    out = {}
    for key in METHOD_KEYS:
        values = coords[key]
        if len(values) != 2 * count:
            raise ApiError(400, "BAD_LAYOUT", f"The {key} layout has {len(values) // 2} points; expected {count}.")
        if not all(math.isfinite(v) and abs(v) <= 1.0001 for v in values):
            raise ApiError(400, "BAD_LAYOUT", f"The {key} layout contains coordinates outside [-1, 1].")
        out[key] = _round(values, 4)
    return out


def upload(*, rows: list[dict], vectors: list[list[float]], coords: dict, base_ids: list[str], filename: str,
           csv_text: str, plot_id: str | None, new_plot: dict | None, embedding: dict, layout_params: dict):
    async def op(reader: Reader):
        index = await _load_index(reader)
        now = docs.now_iso()
        if new_plot is not None:
            known = {p["id"] for p in index.get("plots", [])}
            pid = docs.slugify(new_plot["name"]) + "-" + docs.random_suffix()
            while pid in known:
                pid = docs.slugify(new_plot["name"]) + "-" + docs.random_suffix()
            plot = {
                "schema": docs.SCHEMA, "id": pid, "name": new_plot["name"],
                "description": new_plot.get("description", ""), "created": now, "updated": now, "version": 0,
                "embedding": {**EMBEDDING, "text": "title, a line break, then summary"},
                "layout": {}, "sheets": [],
            }
            points = {"schema": docs.SCHEMA, "plot": pid, "version": 0, "methods": METHOD_KEYS,
                      "points": [], "coords": {k: [] for k in METHOD_KEYS}}
        else:
            pid = check_plot_id(plot_id or "")
            plot, points = await _load_plot(reader, pid)
            stored = plot.get("embedding", {})
            if stored.get("model") != embedding.get("model") or stored.get("pooling") != embedding.get("pooling"):
                raise ApiError(409, "MODEL_MISMATCH",
                               f"This plot was built with {stored.get('model')}; new entries must use the same model.")

        current_ids = [p["id"] for p in points["points"]]
        if current_ids != base_ids:
            raise ApiError(409, "PLOT_CHANGED",
                           "This plot changed while your upload was being prepared (someone else added or removed "
                           "entries). Please upload the file again.")
        total = len(current_ids) + len(rows)
        if total > LIMITS["maxPointsPerPlot"]:
            raise ApiError(400, "PLOT_TOO_LARGE",
                           f"This upload would give the plot {total} entries; the maximum is "
                           f"{LIMITS['maxPointsPerPlot']}. Create a new plot for these entries instead.")
        layout = validate_coords(coords, total)

        # Reuse the existing spelling of a source type that differs only in case.
        spelling = {}
        for p in points["points"]:
            spelling.setdefault(p["sourceType"].lower(), p["sourceType"])
        for r in rows:
            spelling.setdefault(r["sourceType"].lower(), r["sourceType"])

        sheet_ids = {s["id"] for s in plot["sheets"]}
        sid = f"s{now[:10].replace('-', '')}-{docs.random_suffix()}"
        while sid in sheet_ids:
            sid = f"s{now[:10].replace('-', '')}-{docs.random_suffix()}"
        new_points = [{
            "id": f"{sid}-{r['row']}", "sheet": sid, "row": r["row"], "title": r["title"], "summary": r["summary"],
            "link": r["link"], "date": r["date"], "sourceType": spelling[r["sourceType"].lower()], "tags": [],
        } for r in rows]

        plot = {**plot, "updated": now, "version": plot["version"] + 1,
                "layout": {"computed": now, "methods": METHOD_KEYS, "params": layout_params},
                "sheets": plot["sheets"] + [{"id": sid, "filename": filename, "uploaded": now, "rows": len(rows)}]}
        points = {**points, "version": plot["version"], "methods": METHOD_KEYS,
                  "points": points["points"] + new_points, "coords": layout}
        vectors_doc = {"schema": docs.SCHEMA, "sheet": sid, "model": EMBEDDING["model"], "dim": EMBEDDING["dim"],
                       "ids": [p["id"] for p in new_points], "vectors": [_round(v, 6) for v in vectors]}
        index = _upsert_index(index, plot, len(points["points"]))
        files = {
            "index.json": docs.dump_index(index),
            docs.plot_path(pid, "plot.json"): docs.dump_plot(plot),
            docs.plot_path(pid, "points.json"): docs.dump_points(points),
            docs.sheet_dir(pid, sid) + "source.csv": csv_text.encode("utf-8"),
            docs.sheet_dir(pid, sid) + "vectors.json": docs.dump_vectors(vectors_doc),
        }
        noun = "entry" if len(rows) == 1 else "entries"
        message = f"Add {len(rows)} {noun} from {filename} to plot \"{plot['name']}\""
        return Change(files, message), {"plot": plot, "points": points, "index": index, "sheet": sid}

    return op


def delete_sheet(plot_id: str, sheet_id: str):
    async def op(reader: Reader):
        index = await _load_index(reader)
        plot, points = await _load_plot(reader, plot_id)
        sheet = next((s for s in plot["sheets"] if s["id"] == sheet_id), None)
        if sheet is None:
            raise ApiError(404, "SHEET_NOT_FOUND", "That spreadsheet is no longer in this plot.")
        keep = [i for i, p in enumerate(points["points"]) if p["sheet"] != sheet_id]
        coords = {k: [v for i in keep for v in points["coords"][k][2 * i: 2 * i + 2]] for k in METHOD_KEYS}
        now = docs.now_iso()
        plot = {**plot, "updated": now, "version": plot["version"] + 1,
                "sheets": [s for s in plot["sheets"] if s["id"] != sheet_id]}
        points = {**points, "version": plot["version"], "points": [points["points"][i] for i in keep], "coords": coords}
        index = _upsert_index(index, plot, len(points["points"]))
        files: dict[str, bytes | None] = {path: None for path in await reader.list(docs.sheet_dir(plot_id, sheet_id))}
        files.update({
            "index.json": docs.dump_index(index),
            docs.plot_path(plot_id, "plot.json"): docs.dump_plot(plot),
            docs.plot_path(plot_id, "points.json"): docs.dump_points(points),
        })
        message = f"Remove {sheet['filename']} ({sheet['rows']} entries) from plot \"{plot['name']}\""
        return Change(files, message), {"plot": plot, "points": points, "index": index}

    return op


def delete_plot(plot_id: str):
    async def op(reader: Reader):
        index = await _load_index(reader)
        plot, _ = await _load_plot(reader, plot_id)
        files: dict[str, bytes | None] = {path: None for path in await reader.list(f"plots/{plot_id}/")}
        index = {**index, "updated": docs.now_iso(), "plots": [p for p in index.get("plots", []) if p["id"] != plot_id]}
        files["index.json"] = docs.dump_index(index)
        return Change(files, f"Delete plot \"{plot['name']}\""), {"index": index}

    return op


def normalise_tag(tag: str) -> str:
    clean = _SPACE_RE.sub(" ", _CONTROL_RE.sub(" ", tag)).strip()
    if not clean:
        raise ApiError(400, "BAD_TAG", "Tags cannot be empty.")
    if len(clean) > LIMITS["maxTagLength"]:
        raise ApiError(400, "BAD_TAG", f"Tags can be at most {LIMITS['maxTagLength']} characters long.")
    return clean


def tag_points(plot_id: str, ids: list[str], add: list[str], remove: list[str]):
    add = [normalise_tag(t) for t in add]
    remove_keys = {normalise_tag(t).lower() for t in remove}

    async def op(reader: Reader):
        plot, points = await _load_plot(reader, plot_id)
        spelling = {}
        for p in points["points"]:
            for t in p.get("tags", []):
                spelling.setdefault(t.lower(), t)
        to_add = []
        for t in add:
            canonical = spelling.setdefault(t.lower(), t)
            if canonical.lower() not in {x.lower() for x in to_add}:
                to_add.append(canonical)
        wanted = set(ids)
        updates = {}
        new_list = []
        for p in points["points"]:
            if p["id"] not in wanted:
                new_list.append(p)
                continue
            tags = [t for t in p.get("tags", []) if t.lower() not in remove_keys]
            lower = {t.lower() for t in tags}
            for t in to_add:
                if t.lower() not in lower:
                    tags.append(t)
                    lower.add(t.lower())
            if len(tags) > LIMITS["maxTagsPerPoint"]:
                raise ApiError(400, "TOO_MANY_TAGS",
                               f"\"{p['title'][:60]}\" would have {len(tags)} tags; the limit is {LIMITS['maxTagsPerPoint']}.")
            if tags != p.get("tags", []):
                updates[p["id"]] = tags
            new_list.append({**p, "tags": tags})
        missing = sorted(wanted - {p["id"] for p in points["points"]})
        if not updates:
            return Change(), {"version": plot["version"], "updates": {}, "missing": missing}
        now = docs.now_iso()
        plot = {**plot, "updated": now, "version": plot["version"] + 1}
        points = {**points, "version": plot["version"], "points": new_list}
        index = _upsert_index(await _load_index(reader), plot, len(new_list))
        parts = [f"+{t}" for t in to_add] + [f"-{t}" for t in remove]
        noun = "entry" if len(updates) == 1 else "entries"
        files = {
            "index.json": docs.dump_index(index),
            docs.plot_path(plot_id, "plot.json"): docs.dump_plot(plot),
            docs.plot_path(plot_id, "points.json"): docs.dump_points(points),
        }
        message = f"Tag {len(updates)} {noun} in \"{plot['name']}\" ({', '.join(parts)})"
        return Change(files, message), {"version": plot["version"], "updates": updates, "missing": missing}

    return op
