import json
import sys
from pathlib import Path

import pytest

SERVER = Path(__file__).resolve().parent.parent
ROOT = SERVER.parent
sys.path.insert(0, str(SERVER))


@pytest.fixture(scope="session")
def repo_root() -> Path:
    return ROOT


def load_json(rel: str):
    return json.loads((ROOT / rel).read_text(encoding="utf-8"))
