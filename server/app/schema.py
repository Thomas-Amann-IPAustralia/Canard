"""Shared constants. site/js/schema.js mirrors these; a parity test keeps them in sync."""

COLUMNS = [
    {"key": "title", "header": "Title"},
    {"key": "summary", "header": "Summary"},
    {"key": "link", "header": "Source link"},
    {"key": "date", "header": "Publication Date"},
    {"key": "sourceType", "header": "Source type"},
]

EMBEDDING = {
    "model": "Xenova/bge-small-en-v1.5",
    "dtype": "fp32",
    "pooling": "cls",
    "normalize": True,
    "dim": 384,
    "maxTokens": 512,
}

LIMITS = {
    "maxCsvBytes": 5_000_000,
    "maxRowsPerUpload": 2000,
    "maxPointsPerPlot": 5000,
    "maxErrors": 100,
    "maxSourceTypeLength": 60,
    "maxTagLength": 40,
    "maxTagsPerPoint": 30,
    "maxPlotNameLength": 80,
    "maxPlotDescriptionLength": 500,
    # Documents are split into chunks in the browser; only the chunks reach the server.
    "maxFilesPerUpload": 20,
    "maxDocumentBytes": 25_000_000,
    # One request to the optional AI chunk refinement.
    "maxRefineUnits": 300,
    "maxRefineChars": 40_000,
}

METHOD_KEYS = ["umap", "tsne", "gauss", "pca"]

# Clustering stored with each plot: a topic cluster per entry (-1 for unclustered) and
# each entry's similarity to every growth territory (see site/js/territories.js).
CLUSTERS = {
    "territories": 5,
}


def embedding_text(title: str, summary: str) -> str:
    return f"{title}\n{summary}"
