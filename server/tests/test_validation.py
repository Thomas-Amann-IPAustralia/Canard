import hashlib

import pytest

from app.schema import CLUSTERS, COLUMNS, EMBEDDING, LIMITS
from app.tokens import TOKENIZER_PATH, count_tokens
from app.validation import check_token_limits, validate_csv_text

from .conftest import ROOT, load_json

CASES = load_json("tests/fixtures/csv/cases.json")
GOLDEN = load_json("tests/fixtures/csv/golden.json")


def run_case(case):
    result = validate_csv_text(case["csv"])
    errors = result["errors"]
    if case.get("tokens") and not errors:
        errors = check_token_limits(result["rows"], count_tokens)
    rows = []
    for r in result["rows"]:
        r = dict(r)
        tokens = r.pop("tokens", None)
        if case.get("tokens"):
            r["tokens"] = tokens
        rows.append(r)
    return {
        "name": case["name"],
        "errors": [e.to_dict() for e in errors],
        "warnings": [w.to_dict() for w in result["warnings"]],
        "rows": rows,
    }


@pytest.mark.parametrize("index", range(len(CASES)), ids=[c["name"] for c in CASES])
def test_matches_javascript_golden(index):
    case = CASES[index]
    result = run_case(case)
    assert [{"code": e["code"], "row": e["row"]} for e in result["errors"]] == case["errors"]
    assert result == GOLDEN[index]


def test_tokenizer_matches_browser_copy():
    browser = ROOT / "site/models/bge-small-en-v1.5/tokenizer.json"
    digest = lambda p: hashlib.sha256(p.read_bytes()).hexdigest()  # noqa: E731
    assert digest(TOKENIZER_PATH) == digest(browser)


def test_schema_matches_javascript():
    js = (ROOT / "site/js/schema.js").read_text(encoding="utf-8")
    for col in COLUMNS:
        assert f"key: '{col['key']}', header: '{col['header']}'" in js
    assert f"model: '{EMBEDDING['model']}'" in js
    assert f"dtype: '{EMBEDDING['dtype']}'" in js
    assert f"maxTokens: {EMBEDDING['maxTokens']}" in js
    assert f"dim: {EMBEDDING['dim']}" in js
    for key, value in LIMITS.items():
        assert f"{key}: {value:_}" in js or f"{key}: {value}" in js, key
    assert f"territories: {CLUSTERS['territories']}," in js
    territories = (ROOT / "site/js/territories.js").read_text(encoding="utf-8")
    assert territories.count("    key: '") == CLUSTERS["territories"]


def test_token_count_includes_special_tokens():
    assert count_tokens("Hello world") == 4
