"""Optional AI refinement of document chunks.

The browser splits a document into paragraph-sized units and proposes chunk boundaries
from its embeddings. When a language model is configured, it can regroup those units
into passages and give each one a short title. It never rewrites the text: the stored
summary of every chunk is always the document's own words.

Two providers are supported: Gemini's native API (the default) and any service with an
OpenAI-compatible /chat/completions endpoint.
"""

from __future__ import annotations

import json
import logging
import re

import httpx

from .errors import ApiError

log = logging.getLogger("canard")

GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta/"
OPENAI_BASE = "https://api.openai.com/v1/"
DEFAULT_MODELS = {"gemini": "gemini-flash-latest", "openai": "gpt-5-mini"}
MAX_TITLE = 150

SYSTEM_PROMPT = """You split documents into passages for a semantic map, where each passage becomes one point.
You receive one document's paragraphs ("units") in reading order, each with an id, its section heading and its
length in words. Group consecutive units into passages that each develop one coherent idea, so that someone reading
a passage on its own understands what it is about.

Rules:
- Every unit belongs to exactly one passage; passages are consecutive ranges of ids, in order, with no gaps.
- Start a new passage where the topic shifts. A new section heading is usually a good place to break.
- Keep each passage under {max_words} words where possible; aim for about {target_words}.
- Do not put a short heading-like or transitional unit on its own; attach it to the passage it introduces.
- "suggested_breaks" lists ids where an embedding-based splitter would start a passage. Follow them unless you
  see a clearly better boundary.
- Give every passage a specific, descriptive title of at most 12 words, in the document's language. Do not
  repeat the document title in it.

Reply with JSON only: {{"groups": [{{"start": <first id>, "end": <last id>, "title": "<title>"}}, ...]}}"""


class LlmClient:
    def __init__(self, provider: str, api_key: str, model: str = "", base_url: str = "", timeout: float = 90.0):
        if provider not in DEFAULT_MODELS:
            raise ValueError(f"Unknown LLM provider {provider!r}; use gemini or openai.")
        self.provider = provider
        self.api_key = api_key
        self.model = model or DEFAULT_MODELS[provider]
        base = base_url or (GEMINI_BASE if provider == "gemini" else OPENAI_BASE)
        self.base_url = base if base.endswith("/") else base + "/"
        self.timeout = timeout

    async def complete_json(self, system: str, user: str) -> dict:
        """Send one prompt and return the reply parsed as a JSON object."""
        if self.provider == "gemini":
            url = f"{self.base_url}models/{self.model}:generateContent"
            headers = {"x-goog-api-key": self.api_key}
            payload = {
                "systemInstruction": {"parts": [{"text": system}]},
                "contents": [{"role": "user", "parts": [{"text": user}]}],
                "generationConfig": {"responseMimeType": "application/json", "temperature": 0.2},
            }
        else:
            url = f"{self.base_url}chat/completions"
            headers = {"Authorization": f"Bearer {self.api_key}"}
            payload = {
                "model": self.model,
                "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}],
                "response_format": {"type": "json_object"},
            }
        try:
            async with httpx.AsyncClient(timeout=self.timeout) as client:
                res = await client.post(url, headers=headers, json=payload)
        except httpx.HTTPError as exc:
            log.warning("LLM request failed: %s", exc)
            raise ApiError(502, "LLM_FAILED", "The AI service could not be reached. The chunks were kept as they were.")
        if res.status_code != 200:
            log.warning("LLM returned HTTP %s: %s", res.status_code, res.text[:500])
            raise ApiError(502, "LLM_FAILED", f"The AI service returned an error (HTTP {res.status_code}).")
        try:
            body = res.json()
            if self.provider == "gemini":
                parts = body["candidates"][0]["content"]["parts"]
                text = "".join(p.get("text", "") for p in parts if not p.get("thought"))
            else:
                text = body["choices"][0]["message"]["content"]
            return json.loads(_strip_fences(text))
        except (ValueError, KeyError, IndexError, TypeError):
            raise ApiError(502, "LLM_BAD_OUTPUT", "The AI service gave an answer that could not be read.")

    async def refine(self, title: str, units: list[dict], hints: list[int], target_words: int,
                     max_words: int) -> list[dict]:
        system = SYSTEM_PROMPT.format(target_words=target_words, max_words=max_words)
        user = json.dumps({
            "document_title": title,
            "suggested_breaks": hints,
            "units": [{"id": i, "heading": u["heading"], "words": len(u["text"].split()), "text": u["text"]}
                      for i, u in enumerate(units)],
        }, ensure_ascii=False)
        return validate_groups(await self.complete_json(system, user), len(units))


def _strip_fences(text: str) -> str:
    text = text.strip()
    m = re.match(r"^```(?:json)?\s*(.*?)\s*```$", text, re.S)
    return m.group(1) if m else text


def _clean_title(value) -> str:
    if not isinstance(value, str):
        return ""
    title = re.sub(r"\s+", " ", re.sub(r"[\x00-\x1f\x7f]", " ", value)).strip().strip('"').strip()
    return title[:MAX_TITLE].rstrip()


def validate_groups(reply: dict, count: int) -> list[dict]:
    """Check that the groups cover units 0..count-1 exactly once, in order. Returns clean groups."""
    groups = reply.get("groups") if isinstance(reply, dict) else None
    bad = ApiError(502, "LLM_BAD_OUTPUT", "The AI service's grouping did not cover the document correctly.")
    if not isinstance(groups, list) or not groups:
        raise bad
    out = []
    expected = 0
    for g in groups:
        if not isinstance(g, dict):
            raise bad
        start, end = g.get("start"), g.get("end")
        if not all(isinstance(v, int) and not isinstance(v, bool) for v in (start, end)):
            raise bad
        if start != expected or end < start or end >= count:
            raise bad
        title = _clean_title(g.get("title"))
        if not title:
            raise bad
        out.append({"start": start, "end": end, "title": title})
        expected = end + 1
    if expected != count:
        raise bad
    return out
