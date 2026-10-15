"""Token counting with the embedding model's tokenizer (same file the browser uses)."""

from __future__ import annotations

from functools import lru_cache
from pathlib import Path

from tokenizers import Tokenizer

TOKENIZER_PATH = Path(__file__).resolve().parent.parent / "assets" / "tokenizer.json"


@lru_cache(maxsize=1)
def _tokenizer() -> Tokenizer:
    tok = Tokenizer.from_file(str(TOKENIZER_PATH))
    tok.no_truncation()
    tok.no_padding()
    return tok


def count_tokens(text: str) -> int:
    """Number of tokens including the [CLS] and [SEP] special tokens."""
    return len(_tokenizer().encode(text).ids)


def warm_up() -> None:
    """Load the tokenizer at start-up so the first upload is not delayed."""
    count_tokens("warm up")
