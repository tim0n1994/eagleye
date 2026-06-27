from __future__ import annotations

import hashlib
import json
import re
from urllib.parse import urlparse


STOPWORDS = {
    "the", "and", "for", "with", "from", "this", "that", "into", "about", "what",
    "when", "where", "which", "your", "have", "has", "been", "will", "can",
    "could", "would", "should", "http", "https", "com", "www", "new", "using",
    "use", "how", "why", "are", "was", "were", "you", "all", "not", "but",
}

TECH_HINTS = {
    "ai", "llm", "rag", "mcp", "api", "sdk", "cli", "gpu", "cpu", "sql", "db",
    "http", "json", "python", "javascript", "typescript", "rust", "go", "java",
}


def stable_id(*parts: str) -> str:
    raw = "|".join(str(p or "") for p in parts)
    return hashlib.sha1(raw.encode("utf-8")).hexdigest()


def content_hash(*parts: str) -> str:
    raw = "\n".join(str(p or "") for p in parts)
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def slugify(text: str, fallback: str = "tag") -> str:
    slug = re.sub(r"[^a-z0-9\u4e00-\u9fff]+", "-", (text or "").lower()).strip("-")
    return slug or fallback


def domain_from_url(url: str | None) -> str:
    if not url:
        return ""
    try:
        host = urlparse(url).netloc.lower()
    except Exception:
        return ""
    if host.startswith("www."):
        host = host[4:]
    return host


def parse_json(raw: str | None) -> dict:
    if not raw:
        return {}
    try:
        value = json.loads(raw)
        return value if isinstance(value, dict) else {}
    except Exception:
        return {}


def is_good_keyword(word: str) -> bool:
    if not word:
        return False
    key = word.lower().strip()
    if key in STOPWORDS:
        return False
    if key.startswith("@") or "://" in key:
        return False
    if re.search(r"[。！？；，、]", key):
        return False
    has_cjk = bool(re.search(r"[\u4e00-\u9fff]", key))
    if has_cjk:
        return 2 <= len(key) <= 12
    if key in TECH_HINTS:
        return True
    return 3 <= len(key) <= 32


def tokenize(text: str, limit: int = 30) -> list[str]:
    words = re.findall(r"[a-zA-Z][a-zA-Z0-9_+\-.]{2,}|[\u4e00-\u9fff]{2,}", text or "")
    seen: set[str] = set()
    out: list[str] = []
    for word in words:
        key = word.lower()
        if key in seen or not is_good_keyword(word):
            continue
        seen.add(key)
        out.append(word[:80])
        if len(out) >= limit:
            break
    return out
