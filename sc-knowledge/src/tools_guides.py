"""sc_org_guides: search over privately-synced org guide text files.

GuideStore parses `*.txt` files mounted from a ConfigMap that a cluster
operator populates via scripts/sync-org-guides.sh from private PDFs under the
repo-root OrgGuides/ (never committed -- see that script's header comment).
The guide text itself never lives in this repo; only synthetic fixtures do
(tests/fixtures/guides/).

Parsing rules (binding, see task-7 brief):
- File's first non-empty line is the guide title (fallback: filename stem).
- Version: first regex match of `(?i)alpha\\s+(\\d+\\.\\d+(?:\\.\\d+)?)` in the
  file, formatted "Alpha x.y.z".
- Section boundaries: a numbered heading (`^\\s*\\d+\\.\\s+[A-Z]`) or an
  ALL-CAPS-ish heading line (>=12 chars, >=80% of its letters uppercase,
  >=2 words). Text before the first heading is its own section with
  heading == title.

Ranking is BM25 (k1=1.5, b=0.75) over sections, with heading tokens counted
twice (a match in the heading is a stronger relevance signal than a match
buried in body text).
"""
import math
import os
import re
import time
from dataclasses import dataclass
from typing import Callable

_VERSION_RE = re.compile(r"(?i)alpha\s+(\d+\.\d+(?:\.\d+)?)")
_NUMBERED_HEADING_RE = re.compile(r"^\s*\d+\.\s+[A-Z]")
_TOKEN_RE = re.compile(r"[a-z0-9]+")
_TEXT_CAP_CHARS = 4000
_TRUNCATION_SUFFIX = "…(truncated)"

_STOPWORDS = {
    "a", "an", "the", "and", "or", "but", "if", "of", "to", "in", "on", "for",
    "is", "are", "was", "were", "be", "been", "being", "with", "at", "by",
    "from", "as", "that", "this", "it", "its", "my", "your", "his", "her",
    "their", "our", "did", "does", "do", "why", "how", "what", "when",
    "where", "who", "which", "i", "you", "he", "she", "they", "we", "not",
    "so", "than", "too", "can", "will", "would", "should", "could",
}


@dataclass(frozen=True)
class Section:
    guide: str
    version: str | None
    heading: str
    text: str


def _is_caps_heading(line: str) -> bool:
    stripped = line.strip()
    if len(stripped) < 12:
        return False
    words = stripped.split()
    if len(words) < 2:
        return False
    letters = [c for c in stripped if c.isalpha()]
    if not letters:
        return False
    upper = sum(1 for c in letters if c.isupper())
    return (upper / len(letters)) >= 0.8


def _is_heading(line: str) -> bool:
    if _NUMBERED_HEADING_RE.match(line):
        return True
    return _is_caps_heading(line)


def _parse_guide(path: str) -> list[Section]:
    raw = open(path, "r", encoding="utf-8", errors="replace").read()
    lines = raw.split("\n")

    title = None
    for line in lines:
        if line.strip():
            title = line.strip()
            break
    if not title:
        title = os.path.splitext(os.path.basename(path))[0]

    m = _VERSION_RE.search(raw)
    version = f"Alpha {m.group(1)}" if m else None

    sections: list[Section] = []
    heading = title
    body: list[str] = []
    started_first_heading = False

    def flush():
        text = "\n".join(body).strip()
        if text:
            sections.append(Section(guide=title, version=version, heading=heading, text=text))

    for line in lines:
        if _is_heading(line):
            if started_first_heading or body:
                flush()
            heading = line.strip()
            body = []
            started_first_heading = True
        else:
            body.append(line)
    flush()

    return sections


class GuideStore:
    def __init__(self, directory: str, clock: Callable[[], float] = time.monotonic,
                 recheck_s: float = 60.0) -> None:
        self._dir = directory
        self._clock = clock
        self._recheck_s = recheck_s
        self._last_check: float | None = None
        self._fingerprint: tuple | None = None
        self._sections: list[Section] = []

    def _scan(self) -> tuple:
        try:
            entries = []
            for name in sorted(os.listdir(self._dir)):
                if not name.endswith(".txt"):
                    continue
                p = os.path.join(self._dir, name)
                try:
                    st = os.stat(p)
                except OSError:
                    continue
                entries.append((name, st.st_mtime))
            return tuple(entries)
        except OSError:
            return ()

    def sections(self) -> list[Section]:
        now = self._clock()
        if self._last_check is not None and (now - self._last_check) < self._recheck_s:
            return self._sections
        self._last_check = now
        fp = self._scan()
        if fp == self._fingerprint and self._sections:
            return self._sections
        self._fingerprint = fp
        secs: list[Section] = []
        for name, _mtime in fp:
            try:
                secs.extend(_parse_guide(os.path.join(self._dir, name)))
            except OSError:
                continue
        self._sections = secs
        return self._sections


def _tokenise(text: str) -> list[str]:
    return [t for t in _TOKEN_RE.findall(text.lower()) if t not in _STOPWORDS]


def _truncate(text: str) -> str:
    if len(text) <= _TEXT_CAP_CHARS:
        return text
    cut = text.rfind("\n", 0, _TEXT_CAP_CHARS)
    if cut <= 0:
        cut = _TEXT_CAP_CHARS
    return text[:cut].rstrip() + "\n" + _TRUNCATION_SUFFIX


def _bm25_scores(query_tokens: list[str], docs: list[list[str]], k1: float = 1.5, b: float = 0.75) -> list[float]:
    n = len(docs)
    if n == 0:
        return []
    doc_lens = [len(d) for d in docs]
    avgdl = sum(doc_lens) / n if n else 0.0
    df: dict[str, int] = {}
    for d in docs:
        for term in set(d):
            df[term] = df.get(term, 0) + 1
    idf: dict[str, float] = {}
    for term, freq in df.items():
        idf[term] = math.log(1 + (n - freq + 0.5) / (freq + 0.5))
    scores = [0.0] * n
    for i, d in enumerate(docs):
        if not d:
            continue
        tf: dict[str, int] = {}
        for term in d:
            tf[term] = tf.get(term, 0) + 1
        dl = doc_lens[i]
        score = 0.0
        for term in query_tokens:
            if term not in tf:
                continue
            f = tf[term]
            score += idf.get(term, 0.0) * (f * (k1 + 1)) / (f + k1 * (1 - b + b * dl / avgdl))
        scores[i] = score
    return scores


class GuideTools:
    def __init__(self, store: GuideStore) -> None:
        self._store = store

    def org_guides(self, query: str, limit: int = 3) -> dict:
        sections = self._store.sections()
        if not sections:
            return {"source": "org guide", "sections": [], "note": "no org guides loaded"}

        query_tokens = _tokenise(query)
        docs = [_tokenise(s.heading) * 2 + _tokenise(s.text) for s in sections]
        scores = _bm25_scores(query_tokens, docs)

        ranked = sorted(zip(scores, sections), key=lambda sc: sc[0], reverse=True)
        out = []
        for score, sec in ranked:
            if score <= 0:
                break
            out.append({
                "guide": sec.guide,
                "version": sec.version,
                "heading": sec.heading,
                "text": _truncate(sec.text),
                "score": round(score, 4),
            })
            if len(out) >= max(1, limit):
                break
        return {"source": "org guide", "sections": out}
