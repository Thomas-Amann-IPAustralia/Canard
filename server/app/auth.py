"""Password checks, signed tagging sessions and brute-force protection."""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import secrets
import time
from collections import defaultdict, deque

from .errors import ApiError


def passwords_match(given: str, expected: str) -> bool:
    if not expected:
        return False
    return hmac.compare_digest(given.encode("utf-8"), expected.encode("utf-8"))


def _b64(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def _unb64(text: str) -> bytes:
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


class SessionTokens:
    """Stateless HMAC-signed tokens, so sessions survive Render restarts."""

    def __init__(self, secret: str, hours: float):
        self.key = hashlib.sha256(("canard-session:" + secret).encode("utf-8")).digest()
        self.ttl = int(hours * 3600)

    def issue(self, scope: str) -> tuple[str, int]:
        expires = int(time.time()) + self.ttl
        body = _b64(json.dumps({"s": scope, "e": expires, "n": secrets.token_hex(8)}, separators=(",", ":")).encode())
        sig = _b64(hmac.new(self.key, body.encode("ascii"), hashlib.sha256).digest())
        return f"{body}.{sig}", expires

    def verify(self, token: str, scope: str) -> bool:
        try:
            body, sig = token.split(".", 1)
            expected = _b64(hmac.new(self.key, body.encode("ascii"), hashlib.sha256).digest())
            if not hmac.compare_digest(sig, expected):
                return False
            payload = json.loads(_unb64(body))
            return payload.get("s") == scope and int(payload.get("e", 0)) > time.time()
        except (ValueError, KeyError, json.JSONDecodeError):
            return False


class FailureLimiter:
    """Allows a limited number of failed password attempts per client address."""

    def __init__(self, max_failures: int = 10, window_seconds: int = 900):
        self.max_failures = max_failures
        self.window = window_seconds
        self.failures: dict[str, deque[float]] = defaultdict(deque)

    def _prune(self, key: str, now: float) -> deque[float]:
        q = self.failures[key]
        while q and q[0] < now - self.window:
            q.popleft()
        return q

    def check(self, key: str) -> None:
        now = time.time()
        q = self._prune(key, now)
        if len(q) >= self.max_failures:
            retry = int(q[0] + self.window - now) + 1
            raise ApiError(
                429, "TOO_MANY_ATTEMPTS",
                f"Too many incorrect passwords. Try again in {max(1, retry // 60)} minute(s).",
                headers={"Retry-After": str(retry)},
            )

    def fail(self, key: str) -> None:
        self.failures[key].append(time.time())
        if len(self.failures) > 10000:
            # Forget the oldest clients rather than grow without bound.
            for k in list(self.failures)[:5000]:
                del self.failures[k]
