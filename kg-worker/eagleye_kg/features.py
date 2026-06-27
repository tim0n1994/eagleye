from __future__ import annotations

import json
import re
import sqlite3

from .config import EXTRACTOR_VERSION
from .text import content_hash, domain_from_url, parse_json, slugify, stable_id, tokenize


GITHUB_REPO_RE = re.compile(r"github\.com/([A-Za-z0-9_.-]+)/([A-Za-z0-9_.-]+)")


def load_taxonomy(conn: sqlite3.Connection) -> list[sqlite3.Row]:
    return conn.execute(
        """
        SELECT id, slug, name, name_zh, seed_keywords, negative_keywords
        FROM topic_taxonomy
        WHERE status = 'active'
        ORDER BY CASE slug WHEN 'uncategorized-low-confidence' THEN 999 ELSE 0 END, slug
        """
    ).fetchall()


def source_features(item: sqlite3.Row) -> dict:
    payload = parse_json(item["source_payload"])
    normalized = parse_json(item["normalized_payload"])
    source = item["source_slug"]
    features: dict = {"source_slug": source}

    if source == "x-following":
        handle = payload.get("handle") or payload.get("username") or item["author"] or ""
        features.update(
            {
                "handle": str(handle).lstrip("@"),
                "hashtags": re.findall(r"#([A-Za-z0-9_\u4e00-\u9fff]+)", item["content_text"] or item["original_summary"] or item["title"] or ""),
                "mentioned_handles": re.findall(r"@([A-Za-z0-9_]{2,})", item["content_text"] or item["original_summary"] or ""),
                "has_link": bool(item["canonical_url"]),
            }
        )
    elif source == "github-trending":
        repo_name = payload.get("repo_name") or normalized.get("repo_name") or item["title"] or ""
        features.update(
            {
                "repo": repo_name,
                "language": payload.get("language") or normalized.get("language") or "",
                "stars": payload.get("stars") or normalized.get("stars") or None,
                "topics": payload.get("topics") or normalized.get("topics") or [],
            }
        )
    elif source == "hacker-news":
        features.update(
            {
                "points": payload.get("points") or normalized.get("points") or None,
                "comments": payload.get("comments") or normalized.get("comments") or None,
                "domain": domain_from_url(item["canonical_url"]),
            }
        )
    elif source == "hugging-face":
        features.update(
            {
                "paper_id": payload.get("paper_id") or payload.get("paperId") or normalized.get("paper_id") or normalized.get("paperId") or "",
                "authors": payload.get("authors") or normalized.get("authors") or [],
                "upvotes": payload.get("upvotes") or normalized.get("upvotes") or None,
            }
        )
    else:
        features.update({"domain": domain_from_url(item["canonical_url"])})

    return features


def quality_score(item: sqlite3.Row, keywords: list[str]) -> float:
    score = 0.2
    if item["title"] and len(item["title"]) > 12:
        score += 0.2
    if item["original_summary"] or item["content_text"]:
        score += 0.2
    if item["canonical_url"]:
        score += 0.1
    score += min(len(keywords) / 20, 1) * 0.2
    score += min(float(item["score"] or 0), 1) * 0.1
    return round(min(score, 1.0), 3)


def tag_candidates(item: sqlite3.Row, features: dict, keywords: list[str]) -> list[tuple[str, str, str, float, str]]:
    tags: list[tuple[str, str, str, float, str]] = []
    source = item["source_slug"]
    tags.append((f"source:{source}", source, "source", 1.0, "source-rule"))

    domain = features.get("domain") or domain_from_url(item["canonical_url"])
    if domain:
        tags.append((f"domain:{domain}", domain, "source", 0.85, "source-rule"))

    if source == "github-trending" and features.get("language"):
        lang = str(features["language"])
        tags.append((lang, lang, "technology", 0.95, "source-rule"))
    if source == "github-trending" and features.get("repo"):
        repo = str(features["repo"])
        tags.append((repo, repo, "repo", 0.95, "source-rule"))
    if source == "x-following" and features.get("handle"):
        handle = "@" + str(features["handle"]).lstrip("@")
        tags.append((handle, handle, "source", 0.85, "source-rule"))
    for hashtag in features.get("hashtags") or []:
        tags.append((hashtag, hashtag, "technology", 0.75, "source-rule"))

    for kw in keywords[:12]:
        tags.append((kw, kw, "keyword", 0.55, "keyword"))

    return tags


def best_taxonomy(item: sqlite3.Row, keywords: list[str], taxonomy: list[sqlite3.Row]) -> tuple[str, float, str]:
    raw_text = " ".join([item["title"] or "", item["original_summary"] or "", item["content_text"] or "", " ".join(keywords)])
    text = raw_text.lower()
    ascii_tokens = set(re.findall(r"[a-z][a-z0-9_+\-.]*", text))

    def seed_matches(seed_value: object) -> bool:
        seed = str(seed_value or "").lower().strip()
        if not seed:
            return False
        has_cjk = bool(re.search(r"[\u4e00-\u9fff]", seed))
        if has_cjk:
            return seed in text
        if re.search(r"\s", seed):
            return seed in text
        return seed in ascii_tokens

    best_id = ""
    best_score = 0.0
    best_reason = ""
    for topic in taxonomy:
        if topic["slug"] == "uncategorized-low-confidence":
            continue
        try:
            seeds = json.loads(topic["seed_keywords"] or "[]")
        except Exception:
            seeds = []
        matches = [seed for seed in seeds if seed_matches(seed)]
        if matches:
            score = min(0.45 + len(matches) * 0.12, 0.95)
            if score > best_score:
                best_id = topic["id"]
                best_score = score
                best_reason = f"matched seeds: {', '.join(matches[:6])}"

    if best_id:
        return best_id, round(best_score, 3), best_reason

    fallback = next((t for t in taxonomy if t["slug"] == "uncategorized-low-confidence"), None)
    return fallback["id"] if fallback else "", 0.2, "no taxonomy seed matched"


def ensure_tag(conn: sqlite3.Connection, label: str, tag_type: str) -> str:
    slug = slugify(label, "tag")
    tag_id = "kgt_" + stable_id(slug, tag_type)[:24]
    conn.execute(
        """
        INSERT OR IGNORE INTO kg_tags (id, slug, label, type, created_by)
        VALUES (?, ?, ?, ?, 'deterministic')
        """,
        (tag_id, slug, label[:160], tag_type),
    )
    row = conn.execute("SELECT id FROM kg_tags WHERE slug = ?", (slug,)).fetchone()
    return str(row["id"] if row else tag_id)


def normalize_author_name(value: object) -> str:
    if isinstance(value, dict):
        user = value.get("user")
        if isinstance(user, dict):
            return str(user.get("fullname") or user.get("name") or user.get("user") or "").strip()
        return str(value.get("name") or value.get("fullname") or "").strip()
    return str(value or "").strip()


def github_repos_from_text(text: str) -> list[str]:
    repos: list[str] = []
    seen: set[str] = set()
    for owner, repo in GITHUB_REPO_RE.findall(text or ""):
        repo_name = f"{owner}/{repo}".rstrip(".,)")
        key = repo_name.lower()
        if key in seen:
            continue
        seen.add(key)
        repos.append(repo_name)
    return repos


def entity_candidates(item: sqlite3.Row, features: dict) -> list[dict]:
    source = item["source_slug"]
    candidates: list[dict] = []
    raw_text = "\n".join([item["canonical_url"] or "", item["title"] or "", item["original_summary"] or "", item["content_text"] or ""])

    def add(name: str, entity_type: str, confidence: float, source_rule: str, homepage_url: str = "", external_refs: dict | None = None) -> None:
        clean = str(name or "").strip()
        if not clean:
            return
        candidates.append(
            {
                "name": clean[:220],
                "mention_text": clean[:220],
                "entity_type": entity_type,
                "confidence": confidence,
                "source_rule": source_rule,
                "homepage_url": homepage_url,
                "external_refs": external_refs or {},
            }
        )

    if source == "x-following":
        handle = str(features.get("handle") or "").lstrip("@")
        if handle:
            add(f"@{handle}", "account", 0.98, "x-author", f"https://x.com/{handle}", {"x_handle": handle})
        for mentioned in features.get("mentioned_handles") or []:
            handle = str(mentioned or "").lstrip("@")
            if handle:
                add(f"@{handle}", "account", 0.85, "x-mention", f"https://x.com/{handle}", {"x_handle": handle})

    if source == "github-trending" and features.get("repo"):
        repo = str(features["repo"])
        add(repo, "repo", 0.99, "github-repo", item["canonical_url"] or f"https://github.com/{repo}", {"github_repo": repo})
        if "/" in repo:
            owner = repo.split("/", 1)[0]
            add(owner, "account", 0.9, "github-owner", f"https://github.com/{owner}", {"github_owner": owner})

    if source == "hugging-face":
        paper_id = str(features.get("paper_id") or "").strip()
        if paper_id and paper_id.lower() != "undefined":
            add(paper_id, "paper", 0.9, "hf-paper-id", f"https://huggingface.co/papers/{paper_id}", {"paper_id": paper_id})
        for author in (features.get("authors") or [])[:10]:
            name = normalize_author_name(author)
            if name:
                add(name, "person", 0.72, "hf-author")

    domain = features.get("domain") or domain_from_url(item["canonical_url"])
    if domain and source != "x-following":
        add(domain, "domain", 0.8, "canonical-domain", f"https://{domain}", {"domain": domain})

    for repo in github_repos_from_text(raw_text)[:5]:
        add(repo, "repo", 0.88, "github-link", f"https://github.com/{repo}", {"github_repo": repo})

    unique: dict[tuple[str, str], dict] = {}
    for candidate in candidates:
        key = (candidate["entity_type"], candidate["name"].lower())
        previous = unique.get(key)
        if not previous or candidate["confidence"] > previous["confidence"]:
            unique[key] = candidate
    return list(unique.values())


def ensure_entity(conn: sqlite3.Connection, candidate: dict) -> str:
    entity_type = candidate["entity_type"]
    name = candidate["name"]
    canonical_slug = slugify(f"{entity_type}:{name}", "entity")
    entity_id = "kgec_" + stable_id(canonical_slug)[:24]
    aliases = json.dumps([name], ensure_ascii=False)
    refs = json.dumps(candidate.get("external_refs") or {}, ensure_ascii=False)
    conn.execute(
        """
        INSERT INTO canonical_entities
          (id, canonical_name, canonical_slug, entity_type, aliases, homepage_url,
           external_refs, confidence, created_by, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'deterministic', datetime('now'))
        ON CONFLICT(canonical_slug) DO UPDATE SET
          canonical_name=excluded.canonical_name,
          aliases=excluded.aliases,
          homepage_url=COALESCE(NULLIF(excluded.homepage_url, ''), canonical_entities.homepage_url),
          external_refs=excluded.external_refs,
          confidence=MAX(canonical_entities.confidence, excluded.confidence),
          updated_at=datetime('now')
        """,
        (
            entity_id,
            name[:220],
            canonical_slug,
            entity_type,
            aliases,
            candidate.get("homepage_url") or "",
            refs,
            candidate["confidence"],
        ),
    )
    row = conn.execute("SELECT id FROM canonical_entities WHERE canonical_slug = ?", (canonical_slug,)).fetchone()
    return str(row["id"] if row else entity_id)


def upsert_entity_mention(conn: sqlite3.Connection, item: sqlite3.Row, candidate: dict, entity_id: str, run_id: str) -> str:
    normalized = slugify(candidate["mention_text"], "mention")
    mention_id = "kgm_" + stable_id(item["id"], candidate["entity_type"], normalized, candidate["source_rule"])[:24]
    conn.execute(
        """
        INSERT OR REPLACE INTO entity_mentions
          (id, item_id, mention_text, normalized_text, entity_type, extractor, confidence, run_id)
        VALUES (?, ?, ?, ?, ?, 'deterministic', ?, ?)
        """,
        (
            mention_id,
            item["id"],
            candidate["mention_text"][:220],
            normalized,
            candidate["entity_type"],
            candidate["confidence"],
            run_id,
        ),
    )
    conn.execute(
        """
        INSERT OR REPLACE INTO entity_links
          (mention_id, entity_id, link_confidence, linker, evidence)
        VALUES (?, ?, ?, 'deterministic', ?)
        """,
        (
            mention_id,
            entity_id,
            candidate["confidence"],
            json.dumps(
                {
                    "item_id": item["id"],
                    "source_rule": candidate["source_rule"],
                    "external_refs": candidate.get("external_refs") or {},
                },
                ensure_ascii=False,
            ),
        ),
    )
    return mention_id


def upsert_edge(
    conn: sqlite3.Connection,
    from_kind: str,
    from_id: str,
    to_kind: str,
    to_id: str,
    edge_type: str,
    confidence: float,
    extractor: str,
    run_id: str,
    evidence: dict,
) -> None:
    edge_id = "kge_" + stable_id(from_kind, from_id, to_kind, to_id, edge_type, extractor)[:24]
    conn.execute(
        """
        INSERT INTO kg_edges
          (id, from_kind, from_id, to_kind, to_id, edge_type, weight, confidence,
           evidence_item_ids, evidence, extractor, extractor_version, run_id,
           first_seen_at, last_seen_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'), datetime('now'))
        ON CONFLICT(from_kind, from_id, to_kind, to_id, edge_type, extractor) DO UPDATE SET
          weight=excluded.weight,
          confidence=excluded.confidence,
          evidence_item_ids=excluded.evidence_item_ids,
          evidence=excluded.evidence,
          extractor_version=excluded.extractor_version,
          run_id=excluded.run_id,
          last_seen_at=datetime('now'),
          updated_at=datetime('now')
        """,
        (
            edge_id,
            from_kind,
            from_id,
            to_kind,
            to_id,
            edge_type,
            confidence,
            confidence,
            json.dumps([evidence.get("item_id")], ensure_ascii=False),
            json.dumps(evidence, ensure_ascii=False),
            extractor,
            EXTRACTOR_VERSION,
            run_id,
        ),
    )


def extract_item(conn: sqlite3.Connection, item: sqlite3.Row, taxonomy: list[sqlite3.Row], run_id: str) -> dict:
    text = "\n".join([item["title"] or "", item["original_summary"] or "", item["content_text"] or ""])
    keywords = tokenize(text)
    features = source_features(item)
    chash = content_hash(item["title"], item["original_summary"], item["content_text"], item["canonical_url"])
    qscore = quality_score(item, keywords)

    conn.execute(
        """
        INSERT INTO item_features
          (item_id, source_slug, domain, author_norm, language_detected, content_hash,
           title_tokens, keyword_candidates, source_features, quality_score, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
        ON CONFLICT(item_id) DO UPDATE SET
          source_slug=excluded.source_slug,
          domain=excluded.domain,
          author_norm=excluded.author_norm,
          language_detected=excluded.language_detected,
          content_hash=excluded.content_hash,
          title_tokens=excluded.title_tokens,
          keyword_candidates=excluded.keyword_candidates,
          source_features=excluded.source_features,
          quality_score=excluded.quality_score,
          updated_at=datetime('now')
        """,
        (
            item["id"],
            item["source_slug"],
            features.get("domain") or domain_from_url(item["canonical_url"]),
            item["author"] or features.get("handle") or "",
            item["language"] or "",
            chash,
            json.dumps(tokenize(item["title"] or ""), ensure_ascii=False),
            json.dumps(keywords, ensure_ascii=False),
            json.dumps(features, ensure_ascii=False),
            qscore,
        ),
    )

    tag_count = 0
    edge_count = 0
    for label, display, tag_type, confidence, assigned_by in tag_candidates(item, features, keywords):
        tag_id = ensure_tag(conn, display or label, tag_type)
        evidence = {"item_id": item["id"], "label": label, "extractor_version": EXTRACTOR_VERSION}
        conn.execute(
            """
            INSERT OR REPLACE INTO item_tag_assignments
              (item_id, tag_id, confidence, assigned_by, evidence, run_id)
            VALUES (?, ?, ?, ?, ?, ?)
            """,
            (
                item["id"],
                tag_id,
                confidence,
                assigned_by,
                json.dumps(evidence, ensure_ascii=False),
                run_id,
            ),
        )
        upsert_edge(
            conn,
            "item",
            item["id"],
            "tag",
            tag_id,
            "item_has_tag",
            confidence,
            assigned_by,
            run_id,
            evidence,
        )
        tag_count += 1
        edge_count += 1

    topic_id, relevance, reason = best_taxonomy(item, keywords, taxonomy)
    if topic_id:
        conn.execute(
            """
            INSERT OR REPLACE INTO item_topic_assignments
              (item_id, topic_kind, topic_id, relevance, assigned_by, reason, run_id)
            VALUES (?, 'taxonomy', ?, ?, 'deterministic', ?, ?)
            """,
            (item["id"], topic_id, relevance, reason, run_id),
        )
        upsert_edge(
            conn,
            "item",
            item["id"],
            "taxonomy_topic",
            topic_id,
            "item_belongs_taxonomy_topic",
            relevance,
            "deterministic",
            run_id,
            {"item_id": item["id"], "reason": reason},
        )
        edge_count += 1

    entity_count = 0
    for candidate in entity_candidates(item, features):
        entity_id = ensure_entity(conn, candidate)
        mention_id = upsert_entity_mention(conn, item, candidate, entity_id, run_id)
        upsert_edge(
            conn,
            "item",
            item["id"],
            "entity",
            entity_id,
            "item_mentions_entity",
            candidate["confidence"],
            "deterministic",
            run_id,
            {
                "item_id": item["id"],
                "mention_id": mention_id,
                "mention_text": candidate["mention_text"],
                "source_rule": candidate["source_rule"],
            },
        )
        entity_count += 1
        edge_count += 1

    return {"tags": tag_count, "topic": 1 if topic_id else 0, "entities": entity_count, "edges": edge_count}
