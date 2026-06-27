from __future__ import annotations

from pathlib import Path


KG_WORKER_ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = KG_WORKER_ROOT.parent
DEFAULT_DB_PATH = REPO_ROOT / "eagleye.db"

EXTRACTOR_VERSION = "kg-v2-deterministic-0.1"

PRIORITY_SOURCES = [
    "x-following",
    "hacker-news",
    "github-trending",
    "hugging-face",
    "product-hunt",
]

