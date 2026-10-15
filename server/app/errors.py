"""API error type rendered as {"error": {"code", "message", "problems"?}}."""

from __future__ import annotations


class ApiError(Exception):
    def __init__(self, status: int, code: str, message: str, problems: list[dict] | None = None,
                 headers: dict[str, str] | None = None):
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message
        self.problems = problems
        self.headers = headers

    def body(self) -> dict:
        err = {"code": self.code, "message": self.message}
        if self.problems is not None:
            err["problems"] = self.problems
        return {"error": err}
