"""CSV parsing and validation, mirroring site/js/csv.js line for line.

The browser validates uploads instantly; the server repeats every check before it
commits anything. The shared fixtures in tests/fixtures/csv run against both
implementations, so codes, row numbers and messages stay identical. JavaScript's
definitions of whitespace and digits are used throughout for that reason.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, asdict
from typing import Callable

from .schema import COLUMNS, EMBEDDING, LIMITS, embedding_text

EXPECTED_HEADERS = [c["header"] for c in COLUMNS]
EXPECTED_LIST = ", ".join(EXPECTED_HEADERS)
LINK_INDEX = next(i for i, c in enumerate(COLUMNS) if c["key"] == "link")
REQUIRED_LIST = "Title, Summary, Publication Date and Source type"

# JavaScript's \s character class.
WS = "\t\n\v\f\r    -     　﻿"
_TRIM_RE = re.compile(f"^[{WS}]+|[{WS}]+\\Z")
_SPACES_RE = re.compile(f"[{WS}]+")

MONTHS = {
    "jan": 1, "january": 1, "feb": 2, "february": 2, "mar": 3, "march": 3, "apr": 4, "april": 4,
    "may": 5, "jun": 6, "june": 6, "jul": 7, "july": 7, "aug": 8, "august": 8,
    "sep": 9, "sept": 9, "september": 9, "oct": 10, "october": 10, "nov": 11, "november": 11,
    "dec": 12, "december": 12,
}


def js_trim(value: str) -> str:
    return _TRIM_RE.sub("", value)


@dataclass
class CsvProblem:
    code: str
    message: str
    row: int | None = None
    column: str | None = None

    def to_dict(self) -> dict:
        return asdict(self)


@dataclass
class Record:
    row: int
    fields: list[str]


def parse_csv(text: str) -> tuple[list[Record], CsvProblem | None]:
    records: list[Record] = []
    fields: list[str] = []
    field: list[str] = []
    row = 1
    in_quotes = False
    quote_row = 0
    after_quote = False
    n = len(text)
    i = 0
    while i < n:
        c = text[i]
        if in_quotes:
            if c == '"':
                if i + 1 < n and text[i + 1] == '"':
                    field.append('"')
                    i += 2
                    continue
                in_quotes = False
                after_quote = True
                i += 1
                continue
            if c == "\r":
                field.append("\n")
                i += 2 if i + 1 < n and text[i + 1] == "\n" else 1
                continue
            field.append(c)
            i += 1
            continue
        if c == ",":
            fields.append("".join(field))
            field = []
            after_quote = False
            i += 1
            continue
        if c in ("\n", "\r"):
            fields.append("".join(field))
            records.append(Record(row, fields))
            fields = []
            field = []
            after_quote = False
            row += 1
            i += 2 if c == "\r" and i + 1 < n and text[i + 1] == "\n" else 1
            continue
        if after_quote:
            if c in (" ", "\t"):
                i += 1
                continue
            return records, CsvProblem(
                "BAD_QUOTE",
                f'Row {row}: there is text after a closing double quote. If a value contains double quotes, '
                f'wrap the whole value in double quotes and double each quote inside it, for example "He said ""hello""".',
                row,
            )
        if c == '"' and js_trim("".join(field)) == "":
            in_quotes = True
            quote_row = row
            field = []
            i += 1
            continue
        field.append(c)
        i += 1
    if in_quotes:
        return records, CsvProblem(
            "UNCLOSED_QUOTE",
            f"Row {quote_row}: a value starts with a double quote that is never closed. "
            "Check for a missing closing quotation mark.",
            quote_row,
        )
    if field or fields or after_quote:
        fields.append("".join(field))
        records.append(Record(row, fields))
    return records, None


def _normalise_header(value: str) -> str:
    return _SPACES_RE.sub(" ", js_trim(value.lstrip("﻿"))).lower()


def _is_blank(fields: list[str]) -> bool:
    return all(js_trim(f) == "" for f in fields)


def _trim_trailing_empty(fields: list[str]) -> list[str]:
    end = len(fields)
    while end > 0 and js_trim(fields[end - 1]) == "":
        end -= 1
    return fields[:end]


def _quote_value(value: str, max_len: int = 60) -> str:
    v = value[: max_len - 1] + "…" if len(value) > max_len else value
    return f'"{v}"'


_URL_RE = re.compile(
    rf"^https?://([^{WS}/?#@]+@)?([^{WS}/?#:@]+)(:[0-9]{{1,5}})?([/?#][^{WS}]*)?\Z", re.IGNORECASE
)
_SCHEME_RE = re.compile(r"^https?://", re.IGNORECASE)
_BARE_DOMAIN_RE = re.compile(rf"^[^{WS}/]+\.[a-z]{{2,}}(/|\Z)", re.IGNORECASE)


def check_url(value: str) -> str | None:
    if not _SCHEME_RE.match(value):
        if re.match(r"^www\.", value, re.IGNORECASE) or _BARE_DOMAIN_RE.match(value):
            return "must start with http:// or https:// (for example https://www.example.com)"
        return "must be a web address starting with http:// or https://"
    m = _URL_RE.match(value)
    if not m:
        return "is not a valid web address (it may contain spaces)"
    host = m.group(2)
    if host.lower() != "localhost" and ("." not in host or host.startswith(".") or host.endswith(".")):
        return "does not contain a valid domain name"
    return None


def _days_in_month(year: int, month: int) -> int:
    leap = (year % 4 == 0 and year % 100 != 0) or year % 400 == 0
    return [31, 29 if leap else 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]


_ISO_RE = re.compile(
    r"^([0-9]{4})([-/])([0-9]{1,2})\2([0-9]{1,2})"
    r"(?:[T ][0-9]{1,2}:[0-9]{2}(?::[0-9]{2}(?:\.[0-9]+)?)?(?:Z|[+-][0-9]{2}:?[0-9]{2})?)?\Z"
)
_DMY_RE = re.compile(r"^([0-9]{1,2})([/.-])([0-9]{1,2})\2([0-9]{4})\Z")
_D_MONTH_Y_RE = re.compile(rf"^([0-9]{{1,2}})(?:st|nd|rd|th)?[{WS}]+([A-Za-z]+)\.?,?[{WS}]+([0-9]{{4}})\Z")
_MONTH_D_Y_RE = re.compile(rf"^([A-Za-z]+)\.?[{WS}]+([0-9]{{1,2}})(?:st|nd|rd|th)?,?[{WS}]+([0-9]{{4}})\Z")
_TWO_DIGIT_YEAR_RE = re.compile(r"^[0-9]{1,2}[/.-][0-9]{1,2}[/.-][0-9]{2}\Z")
_PARTIAL_RE = re.compile(r"^[0-9]{4}(-[0-9]{1,2})?\Z")


def parse_date(value: str) -> dict:
    v = js_trim(value)
    if m := _ISO_RE.match(v):
        y, mo, d = int(m.group(1)), int(m.group(3)), int(m.group(4))
    elif m := _DMY_RE.match(v):
        d, mo, y = int(m.group(1)), int(m.group(3)), int(m.group(4))
        if mo > 12 and d <= 12:
            return {"error": "looks like a month/day/year date. Dates are read as day/month/year "
                             "(Australian format); YYYY-MM-DD is safest"}
    elif m := _D_MONTH_Y_RE.match(v):
        d, y = int(m.group(1)), int(m.group(3))
        mo = MONTHS.get(m.group(2).lower())
        if not mo:
            return {"error": f'has an unrecognised month name "{m.group(2)}"'}
    elif m := _MONTH_D_Y_RE.match(v):
        d, y = int(m.group(2)), int(m.group(3))
        mo = MONTHS.get(m.group(1).lower())
        if not mo:
            return {"error": f'has an unrecognised month name "{m.group(1)}"'}
    elif _TWO_DIGIT_YEAR_RE.match(v):
        return {"error": "has a two-digit year. Use a four-digit year, for example 2024-03-15 or 15/03/2024"}
    elif _PARTIAL_RE.match(v):
        return {"error": "needs a full date. If only the year or month is known, use the first day, "
                         "for example 2024-01-01"}
    else:
        return {"error": "is not a recognised date. Use YYYY-MM-DD (for example 2024-03-15) "
                         "or DD/MM/YYYY (for example 15/03/2024)"}
    if y < 1000 or y > 9999 or mo < 1 or mo > 12 or d < 1 or d > _days_in_month(y, mo):
        return {"error": "is not a real calendar date"}
    return {"iso": f"{y:04d}-{mo:02d}-{d:02d}"}


def _collapse_spaces(value: str) -> str:
    return _SPACES_RE.sub(" ", js_trim(value))


def _clean_summary(value: str) -> str:
    value = re.sub(r"\r\n?", "\n", value)
    lines = [js_trim(re.sub(r"[ \t]+", " ", line)) for line in value.split("\n")]
    joined = re.sub(r"\n{3,}", "\n\n", "\n".join(lines))
    return js_trim(joined)


def _looks_like_data(cells: list[str]) -> bool:
    return any(re.match(r"^https?://", js_trim(c), re.IGNORECASE) or "iso" in parse_date(c) for c in cells)


def _check_header(record: Record) -> list[CsvProblem]:
    raw = _trim_trailing_empty(record.fields)
    cells = [_normalise_header(c) for c in raw]
    expected = [_normalise_header(h) for h in EXPECTED_HEADERS]
    if len(raw) == 1 and (";" in raw[0] or "\t" in raw[0]):
        sep = "semicolons (;)" if ";" in raw[0] else "tabs"
        return [CsvProblem(
            "WRONG_DELIMITER",
            f'The columns are separated by {sep} instead of commas. In Excel, choose File > Save As and pick '
            f'"CSV UTF-8 (Comma delimited)".', 1)]
    if cells == expected:
        return []
    if _looks_like_data(raw):
        return [CsvProblem(
            "HEADER_MISSING",
            f"Row 1 must contain the column headings: {EXPECTED_LIST}. It looks like it contains an entry instead. "
            "Download the template to see the expected layout.", 1)]
    if len(cells) == len(expected) and sorted(cells) == sorted(expected):
        return [CsvProblem("HEADER_ORDER", f"The columns are in the wrong order. They must be: {EXPECTED_LIST}.", 1)]
    if len(cells) != len(expected):
        missing = [h for h in EXPECTED_HEADERS if _normalise_header(h) not in cells]
        extra = [h for h in raw if _normalise_header(h) not in expected]
        plural = "" if len(cells) == 1 else "s"
        msg = (f"The header row has {len(cells)} column{plural} but exactly {len(expected)} are required: "
               f"{EXPECTED_LIST}.")
        if missing:
            msg += f" Missing: {', '.join(missing)}."
        if extra:
            msg += f" Not expected: {', '.join(_quote_value(js_trim(h), 40) for h in extra)}."
        return [CsvProblem("HEADER_COLUMN_COUNT", msg, 1)]
    problems = []
    for i, c in enumerate(cells):
        if c != expected[i]:
            problems.append(CsvProblem(
                "HEADER_MISMATCH",
                f'Column {i + 1} is headed {_quote_value(js_trim(raw[i]), 40)} but should be "{EXPECTED_HEADERS[i]}".',
                1, EXPECTED_HEADERS[i]))
    return problems


def validate_csv_text(text: str) -> dict:
    """Validate structure and content. Returns {"rows", "errors", "warnings"}."""
    errors: list[CsvProblem] = []
    warnings: list[CsvProblem] = []
    rows: list[dict] = []
    if text.startswith("﻿"):
        text = text[1:]
    if js_trim(text) == "":
        return {"rows": rows, "warnings": warnings, "errors": [CsvProblem("EMPTY_FILE", "The file is empty.")]}
    if "\u0000" in text:
        return {"rows": rows, "warnings": warnings,
                "errors": [CsvProblem("NOT_CSV", "This file contains binary data and is not a CSV text file.")]}
    records, error = parse_csv(text)
    if error:
        return {"rows": rows, "warnings": warnings, "errors": [error]}
    header_problems = _check_header(records[0])
    if header_problems:
        return {"rows": rows, "warnings": warnings, "errors": header_problems}

    width = len(EXPECTED_HEADERS)
    seen: dict[str, int] = {}
    for record in records[1:]:
        if _is_blank(record.fields):
            continue
        row = record.row
        fields = _trim_trailing_empty(record.fields) if len(record.fields) > width else record.fields
        if len(fields) < width:
            plural = "" if len(fields) == 1 else "s"
            errors.append(CsvProblem(
                "ROW_TOO_FEW_VALUES",
                f"Row {row} has {len(fields)} value{plural} but {width} are expected. Check for a missing comma, "
                "or a line break inside a value that is not wrapped in double quotes.", row))
            continue
        if len(fields) > width:
            errors.append(CsvProblem(
                "ROW_TOO_MANY_VALUES",
                f"Row {row} has {len(fields)} values but {width} are expected. If a value contains a comma, "
                "wrap the whole value in double quotes.", row))
            continue
        entry = {
            "row": row,
            "title": _collapse_spaces(fields[0]),
            "summary": _clean_summary(fields[1]),
            "link": js_trim(fields[2]),
            "date": "",
            "sourceType": _collapse_spaces(fields[4]),
        }
        row_ok = True
        raw_date = js_trim(fields[3])
        values = [entry["title"], entry["summary"], entry["link"], raw_date, entry["sourceType"]]
        for i, v in enumerate(values):
            # The source link is optional (document chunks often have none).
            if v == "" and i != LINK_INDEX:
                row_ok = False
                errors.append(CsvProblem(
                    "MISSING_VALUE",
                    f"Row {row}: {EXPECTED_HEADERS[i]} is empty. Every entry needs a {REQUIRED_LIST}.",
                    row, EXPECTED_HEADERS[i]))
        if entry["link"]:
            reason = check_url(entry["link"])
            if reason:
                row_ok = False
                errors.append(CsvProblem(
                    "INVALID_URL", f"Row {row}: Source link {_quote_value(entry['link'])} {reason}.", row, "Source link"))
        if raw_date:
            parsed = parse_date(raw_date)
            if "error" in parsed:
                row_ok = False
                errors.append(CsvProblem(
                    "INVALID_DATE", f"Row {row}: Publication Date {_quote_value(raw_date, 40)} {parsed['error']}.",
                    row, "Publication Date"))
            else:
                entry["date"] = parsed["iso"]
        max_type = LIMITS["maxSourceTypeLength"]
        if len(entry["sourceType"]) > max_type:
            row_ok = False
            errors.append(CsvProblem(
                "SOURCE_TYPE_TOO_LONG",
                f"Row {row}: Source type is {len(entry['sourceType'])} characters long. Keep it to a short category "
                f'of at most {max_type} characters, such as "Journal article" or "News".', row, "Source type"))
        if not row_ok:
            continue
        key = f"{entry['title'].lower()}\u0000{entry['link'].lower()}"
        if key in seen:
            warnings.append(CsvProblem(
                "DUPLICATE_ROW",
                f"Row {row} repeats row {seen[key]} (same title and source link). Both will be added.", row))
        else:
            seen[key] = row
        rows.append(entry)

    if not errors and not rows:
        errors.append(CsvProblem("NO_ROWS", "The file has a header row but no entries below it."))
    if not errors and len(rows) > LIMITS["maxRowsPerUpload"]:
        errors.append(CsvProblem(
            "TOO_MANY_ROWS",
            f"The file has {len(rows)} entries. At most {LIMITS['maxRowsPerUpload']} can be uploaded at once; "
            "split it into smaller files."))
    return {"rows": rows, "warnings": warnings, "errors": cap_problems(errors)}


def check_token_limits(rows: list[dict], count_tokens: Callable[[str], int],
                       max_tokens: int = EMBEDDING["maxTokens"]) -> list[CsvProblem]:
    errors = []
    for entry in rows:
        count = count_tokens(embedding_text(entry["title"], entry["summary"]))
        entry["tokens"] = count
        if count > max_tokens:
            over = count - max_tokens
            words = max(1, -(-over * 3 // 4))
            errors.append(CsvProblem(
                "TOKEN_LIMIT",
                f"Row {entry['row']} ({_quote_value(entry['title'], 50)}): the title and summary together are {count} "
                f"tokens long, but the embedding model accepts at most {max_tokens}. Shorten this entry by at least "
                f"{over} token{'' if over == 1 else 's'} (roughly {words} word{'' if words == 1 else 's'}).",
                entry["row"], "Summary"))
    return cap_problems(errors)


def cap_problems(errors: list[CsvProblem]) -> list[CsvProblem]:
    limit = LIMITS["maxErrors"]
    if len(errors) <= limit:
        return errors
    extra = len(errors) - limit
    return errors[:limit] + [CsvProblem(
        "MORE_ERRORS",
        f"…and {extra} more problem{'' if extra == 1 else 's'}. Fix the ones above and upload again to see the rest.")]
