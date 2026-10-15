"""Canard API: the small write service behind the static GitHub Pages site.

Viewing never touches this service; the site reads its data straight from GitHub
Pages. The API verifies passwords, re-validates uploads and commits changes to the
repository's data directory.
"""

from __future__ import annotations

import logging
import re
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel, Field

from . import operations as ops
from .auth import FailureLimiter, SessionTokens, passwords_match
from .config import Settings
from .errors import ApiError
from .schema import EMBEDDING, LIMITS
from .store import GitHubStore, LocalStore
from .tokens import count_tokens, warm_up
from .validation import check_token_limits, validate_csv_text

VERSION = "1.0.0"
log = logging.getLogger("canard")
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")

_DATA_PATH_RE = re.compile(
    r"^(index\.json|plots/[a-z0-9-]+/(plot\.json|points\.json|sheets/[a-z0-9-]+/(vectors\.json|source\.csv)))\Z"
)


# Request bodies (module level so FastAPI can resolve the annotations).
class PasswordBody(BaseModel):
    password: str = Field(max_length=500)

class NewPlot(BaseModel):
    name: str = Field(min_length=1, max_length=LIMITS["maxPlotNameLength"])
    description: str = Field(default="", max_length=LIMITS["maxPlotDescriptionLength"])

class Embedding(BaseModel):
    model: str
    dtype: str
    pooling: str
    normalize: bool
    dim: int

class UploadBody(BaseModel):
    password: str = Field(max_length=500)
    plotId: str | None = None
    newPlot: NewPlot | None = None
    filename: str = Field(min_length=1, max_length=200)
    csv: str = Field(max_length=LIMITS["maxCsvBytes"])
    vectors: list[list[float]]
    baseIds: list[str]
    coords: dict[str, list[float]]
    layoutParams: dict = Field(default_factory=dict)
    embedding: Embedding
    clusters: dict | None = None
    clusterParams: dict = Field(default_factory=dict)

class ClustersBody(BaseModel):
    password: str = Field(max_length=500)
    baseIds: list[str] = Field(max_length=LIMITS["maxPointsPerPlot"])
    clusters: dict
    clusterParams: dict = Field(default_factory=dict)

class TagBody(BaseModel):
    ids: list[str] = Field(min_length=1, max_length=LIMITS["maxPointsPerPlot"])
    add: list[str] = Field(default_factory=list, max_length=20)
    remove: list[str] = Field(default_factory=list, max_length=20)


def build_store(settings: Settings):
    if settings.store == "github":
        if not settings.github_token or not settings.github_repo:
            raise RuntimeError("CANARD_STORE=github needs GITHUB_TOKEN and GITHUB_REPO.")
        return GitHubStore(settings.github_token, settings.github_repo, settings.github_branch, settings.data_dir,
                           {"name": settings.commit_name, "email": settings.commit_email})
    return LocalStore(settings.local_root)


def create_app(settings: Settings | None = None, store=None) -> FastAPI:
    settings = settings or Settings.from_env()

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        app.state.store = store or build_store(settings)
        warm_up()
        log.info("Canard API %s ready (store=%s, writable=%s)", VERSION, app.state.store.kind, settings.writable)
        yield
        await app.state.store.close()

    app = FastAPI(title="Canard API", version=VERSION, lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)
    app.state.settings = settings
    app.state.sessions = SessionTokens(settings.session_secret, settings.session_hours)
    app.state.limiter = FailureLimiter()
    app.state.global_limiter = FailureLimiter(max_failures=100, window_seconds=900)
    app.add_middleware(GZipMiddleware, minimum_size=1024)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.allowed_origins,
        allow_methods=["GET", "POST", "OPTIONS"],
        allow_headers=["Content-Type", "Authorization"],
        max_age=86400,
    )

    @app.exception_handler(ApiError)
    async def api_error(_: Request, exc: ApiError):
        return JSONResponse(exc.body(), status_code=exc.status, headers=exc.headers)

    @app.exception_handler(RequestValidationError)
    async def bad_request(_: Request, exc: RequestValidationError):
        first = exc.errors()[0] if exc.errors() else {}
        where = ".".join(str(p) for p in first.get("loc", []) if p != "body")
        return JSONResponse(ApiError(400, "BAD_REQUEST", f"Invalid request ({where}: {first.get('msg', 'invalid')}).").body(),
                            status_code=400)

    def client_key(request: Request) -> str:
        forwarded = request.headers.get("true-client-ip") or request.headers.get("x-forwarded-for", "").split(",")[0]
        return forwarded.strip() or (request.client.host if request.client else "unknown")

    def require_password(request: Request, given: str, *, scope: str) -> None:
        if not settings.writable:
            raise ApiError(503, "READ_ONLY", "Editing is switched off: the server has no admin password configured.")
        key = client_key(request)
        app.state.global_limiter.check("*")
        app.state.limiter.check(key)
        expected = [settings.admin_password] if scope == "admin" else [settings.tag_password, settings.admin_password]
        if not any(passwords_match(given, e) for e in expected):
            app.state.limiter.fail(key)
            app.state.global_limiter.fail("*")
            raise ApiError(401, "WRONG_PASSWORD", "That password is not correct.")

    def require_session(request: Request) -> None:
        header = request.headers.get("authorization", "")
        token = header[7:] if header.lower().startswith("bearer ") else ""
        if not token or not app.state.sessions.verify(token, "tag"):
            raise ApiError(401, "SESSION_EXPIRED", "Your tagging session has expired. Enter the password again.")

    @app.get("/api/health")
    async def health():
        return {"ok": True, "version": VERSION, "store": app.state.store.kind, "writable": settings.writable,
                "embedding": EMBEDDING, "limits": LIMITS}

    @app.post("/api/auth/check")
    async def auth_check(body: PasswordBody, request: Request):
        require_password(request, body.password, scope="admin")
        return {"ok": True}

    @app.post("/api/auth/session")
    async def auth_session(body: PasswordBody, request: Request):
        require_password(request, body.password, scope="tag")
        token, expires = app.state.sessions.issue("tag")
        return {"token": token, "expiresAt": expires}

    @app.post("/api/upload")
    async def upload(body: UploadBody, request: Request):
        require_password(request, body.password, scope="admin")
        if (body.plotId is None) == (body.newPlot is None):
            raise ApiError(400, "BAD_REQUEST", "Choose either an existing plot or a new plot.")
        emb = body.embedding
        if (emb.model, emb.dtype, emb.pooling, emb.normalize, emb.dim) != (
                EMBEDDING["model"], EMBEDDING["dtype"], EMBEDDING["pooling"], EMBEDDING["normalize"], EMBEDDING["dim"]):
            raise ApiError(409, "MODEL_MISMATCH", "The page used a different embedding model from the server. "
                                                  "Reload the page and try again.")
        result = validate_csv_text(body.csv)
        problems = result["errors"] or check_token_limits(result["rows"], count_tokens)
        if problems:
            raise ApiError(422, "INVALID_CSV", "The spreadsheet was rejected.", [p.to_dict() for p in problems])
        ops.validate_vectors(body.vectors, len(result["rows"]))
        new_plot = None
        if body.newPlot:
            name = body.newPlot.name.strip()
            if not name:
                raise ApiError(400, "BAD_REQUEST", "Give the new plot a name.")
            new_plot = {"name": name, "description": body.newPlot.description.strip()}
        filename = re.sub(r"[\x00-\x1f/\\]", "_", body.filename.strip())[:200] or "upload.csv"
        op = ops.upload(rows=result["rows"], vectors=body.vectors, coords=body.coords, base_ids=body.baseIds,
                        filename=filename, csv_text=body.csv, plot_id=body.plotId, new_plot=new_plot,
                        embedding=emb.model_dump(), layout_params=body.layoutParams,
                        clusters=body.clusters, cluster_params=body.clusterParams)
        out = await app.state.store.transaction(op)
        out["warnings"] = [w.to_dict() for w in result["warnings"]]
        return out

    @app.post("/api/plots/{plot_id}/sheets/{sheet_id}/delete")
    async def delete_sheet(plot_id: str, sheet_id: str, body: PasswordBody, request: Request):
        require_password(request, body.password, scope="admin")
        op = ops.delete_sheet(ops.check_plot_id(plot_id), ops.check_sheet_id(sheet_id))
        return await app.state.store.transaction(op)

    @app.post("/api/plots/{plot_id}/clusters")
    async def set_clusters(plot_id: str, body: ClustersBody, request: Request):
        require_password(request, body.password, scope="admin")
        op = ops.set_clusters(ops.check_plot_id(plot_id), body.baseIds, body.clusters, body.clusterParams)
        return await app.state.store.transaction(op)

    @app.post("/api/plots/{plot_id}/delete")
    async def delete_plot(plot_id: str, body: PasswordBody, request: Request):
        require_password(request, body.password, scope="admin")
        return await app.state.store.transaction(ops.delete_plot(ops.check_plot_id(plot_id)))

    @app.post("/api/plots/{plot_id}/tags")
    async def tag(plot_id: str, body: TagBody, request: Request):
        require_session(request)
        if not body.add and not body.remove:
            raise ApiError(400, "BAD_REQUEST", "Nothing to change.")
        op = ops.tag_points(ops.check_plot_id(plot_id), body.ids, body.add, body.remove)
        return await app.state.store.transaction(op)

    @app.get("/api/data/{path:path}")
    async def data(path: str):
        if not _DATA_PATH_RE.match(path):
            raise ApiError(404, "NOT_FOUND", "Not found.")
        content = await app.state.store.read(path)
        if content is None:
            raise ApiError(404, "NOT_FOUND", "Not found.")
        media = "text/csv; charset=utf-8" if path.endswith(".csv") else "application/json"
        return Response(content, media_type=media, headers={"Cache-Control": "no-store"})

    return app


app = create_app()
