"""Collect Reddit posts with authenticated API first and public RSS fallback."""
import argparse
from contextlib import contextmanager
from datetime import datetime
from html import unescape
import json
import math
import os
from pathlib import Path
import re
import socket
import time
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlencode, urlparse
from urllib.request import Request, urlopen
import xml.etree.ElementTree as ET

try:
    import fcntl
except ImportError:  # pragma: no cover - Eagleye runs on Linux.
    fcntl = None


ATOM = '{http://www.w3.org/2005/Atom}'
RSS_USER_AGENT = 'Mozilla/5.0 (compatible; Eagleye/1.0; Reddit RSS collector)'
ARCTIC_METRICS_URL = 'https://arctic-shift.photon-reddit.com/api/posts/ids'


def _env_bool(name, default=False):
    value = os.environ.get(name)
    if value is None:
        return default
    return value.strip().lower() in {'1', 'true', 'yes', 'on'}


def _read_saved_credential():
    credential_file = Path(os.environ.get('EAGLEYE_REDDIT_CREDENTIAL_FILE', '~/.config/rdt-cli/credential.json')).expanduser()
    try:
        with credential_file.open() as stream:
            saved = json.load(stream)
        cookies = saved.get('cookies')
        if not isinstance(cookies, dict) or not cookies or not all(isinstance(k, str) and isinstance(v, str) and v for k, v in cookies.items()):
            raise ValueError()
    except (OSError, ValueError, AttributeError, TypeError):
        raise RuntimeError('AUTH_REQUIRED: valid application credential file required') from None
    return saved


def _reddit_api_headers(saved):
    cookies = saved.get('cookies', {})
    return {
        'Accept': 'application/json',
        'User-Agent': os.environ.get('REDDIT_API_USER_AGENT', 'Eagleye/1.6.0 Reddit collector'),
        'Cookie': '; '.join(f'{name}={value}' for name, value in cookies.items()),
    }


def _urllib_reddit_json(path, params, saved):
    query = urlencode(params)
    url = f'https://www.reddit.com{path}'
    if query:
        url = f'{url}?{query}'
    request = Request(url, headers=_reddit_api_headers(saved))
    timeout = max(5, int(os.environ.get('REDDIT_API_TIMEOUT_S', '20')))
    with urlopen(request, timeout=timeout) as response:
        return json.loads(response.read(8 * 1024 * 1024))


def _normalize_authenticated_listing(listing):
    try:
        children = listing['data']['children']
        if not isinstance(children, list):
            raise ValueError()
        posts = []
        for child in children:
            post = dict(child['data'])
            if not post.get('id') or not isinstance(post.get('permalink'), str) or not post['permalink'].startswith('/r/'):
                raise ValueError()
            post['comments'] = post.get('num_comments', 0)
            post['url'] = 'https://reddit.com' + post['permalink']
            posts.append(post)
        return posts
    except (KeyError, TypeError, ValueError):
        raise RuntimeError('SCHEMA_ERROR: invalid Reddit listing') from None


def _collect_authenticated_urllib(subreddit, sort, limit, saved):
    clean = re.sub(r'^r/', '', str(subreddit), flags=re.IGNORECASE)
    if not re.fullmatch(r'[A-Za-z0-9_]+', clean):
        raise RuntimeError('COLLECTION_FAILED: invalid subreddit')
    path = f'/r/{quote(clean, safe="")}.json' if sort == 'hot' else f'/r/{quote(clean, safe="")}/{quote(sort, safe="")}.json'
    params = {'limit': limit, 'raw_json': 1}
    identity = _urllib_reddit_json('/api/me.json', {'raw_json': 1}, saved)
    if isinstance(identity, dict) and isinstance(identity.get('data'), dict):
        identity = identity['data']
    username = (identity.get('name') or identity.get('username')) if isinstance(identity, dict) else None
    if not isinstance(username, str) or not username.strip():
        raise RuntimeError('AUTH_REQUIRED: authenticated identity required')
    return _normalize_authenticated_listing(_urllib_reddit_json(path, params, saved))


def _collect_authenticated(subreddit, sort, limit, saved):
    if _env_bool('REDDIT_AUTH_URLLIB'):
        return _collect_authenticated_urllib(subreddit, sort, limit, saved)

    from rdt_cli.auth import Credential
    from rdt_cli.client import RedditClient

    cred = Credential.from_dict(saved)
    with RedditClient(credential=cred) as client:
        try:
            identity = client.get_me()
        except Exception:
            raise RuntimeError('AUTH_REQUIRED: identity verification failed') from None
        if isinstance(identity, dict) and isinstance(identity.get('data'), dict):
            identity = identity['data']
        username = (identity.get('name') or identity.get('username')) if isinstance(identity, dict) else None
        if not isinstance(username, str) or not username.strip():
            raise RuntimeError('AUTH_REQUIRED: authenticated identity required')
        listing = client.get_subreddit(subreddit, sort=sort, limit=limit)
    return _normalize_authenticated_listing(listing)


def _rss_sort_path(sort):
    return {
        'hot': '.rss',
        'new': 'new/.rss',
        'top': 'top/.rss?t=day',
        'rising': 'rising/.rss',
        'controversial': 'controversial/.rss?t=day',
    }.get(sort, '.rss')


def _parse_retry_seconds(error):
    headers = getattr(error, 'headers', None)
    raw = headers.get('retry-after') if headers is not None else None
    raw = raw or (headers.get('x-ratelimit-reset') if headers is not None else None) or '1'
    try:
        return max(1, min(60, int(float(raw))))
    except (TypeError, ValueError):
        return 1


def _controller_request(method, path, payload=None):
    socket_path = os.environ.get('REDDIT_RSS_CONTROLLER_SOCKET')
    if not socket_path:
        return None
    body = json.dumps(payload).encode() if payload is not None else b''
    request = (
        f'{method} {path} HTTP/1.1\r\n'
        'Host: localhost\r\n'
        'Connection: close\r\n'
        'Content-Type: application/json\r\n'
        f'Content-Length: {len(body)}\r\n\r\n'
    ).encode() + body
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as sock:
        sock.settimeout(5)
        sock.connect(socket_path)
        sock.sendall(request)
        chunks = []
        while True:
            chunk = sock.recv(65536)
            if not chunk:
                break
            chunks.append(chunk)
    response = b''.join(chunks)
    head, _, raw_body = response.partition(b'\r\n\r\n')
    status_line = head.splitlines()[0].decode('latin1') if head else ''
    status = int(status_line.split()[1]) if len(status_line.split()) > 1 else 500
    if status >= 400:
        raise RuntimeError('controller request failed')
    return json.loads(raw_body.decode('utf-8')) if raw_body else {}


def _select_rss_egress():
    group = os.environ.get('REDDIT_RSS_EGRESS_GROUP')
    if not group or not os.environ.get('REDDIT_RSS_CONTROLLER_SOCKET'):
        return
    encoded_group = quote(group, safe='')
    status = _controller_request('GET', f'/proxies/{encoded_group}') or {}
    names = status.get('all') if isinstance(status, dict) else None
    if not isinstance(names, list):
        return
    # Prefer one node per region because this subscription exposes three IPs.
    candidates = []
    for region in ('日本', '美国', '新加坡'):
        candidate = next((name for name in names if region in str(name)), None)
        if candidate is not None and candidate not in candidates:
            candidates.append(candidate)
    if not candidates:
        candidates = [name for name in names if name not in {'DIRECT', 'REJECT'}]
    if not candidates:
        return
    state_path = Path(os.environ.get('REDDIT_RSS_STATE_FILE', '~/.local/share/argus/eagleye/reddit-rss-state.json')).expanduser()
    state_path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    try:
        current = json.loads(state_path.read_text())
        index = int(current.get('next_index', 0))
    except (OSError, ValueError, TypeError, AttributeError):
        index = 0
    selected = candidates[index % len(candidates)]
    state_path.write_text(json.dumps({'next_index': (index + 1) % len(candidates)}))
    state_path.chmod(0o600)
    _controller_request('PUT', f'/proxies/{encoded_group}', {'name': selected})


@contextmanager
def _rss_egress_lock():
    state_path = Path(os.environ.get('REDDIT_RSS_STATE_FILE', '~/.local/share/argus/eagleye/reddit-rss-state.json')).expanduser()
    lock_path = Path(f'{state_path}.lock')
    lock_path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    with lock_path.open('a+') as lock:
        if fcntl is not None:
            fcntl.flock(lock.fileno(), fcntl.LOCK_EX)
        try:
            try:
                _select_rss_egress()
            except (OSError, RuntimeError, ValueError, TypeError):
                # RSS remains usable if the optional controller is unavailable.
                pass
            yield
        finally:
            if fcntl is not None:
                fcntl.flock(lock.fileno(), fcntl.LOCK_UN)


def _strip_html(value):
    return re.sub(r'<[^>]+>', ' ', unescape(str(value or ''))).replace('\\xa0', ' ').strip()


def _entry_value(entry, name):
    node = entry.find(f'{ATOM}{name}')
    return node.text.strip() if node is not None and node.text else ''


def _entry_link(entry):
    for node in entry.findall(f'{ATOM}link'):
        href = node.attrib.get('href', '')
        if href and node.attrib.get('rel', 'alternate') == 'alternate':
            return href
    return ''


def _created_utc(value):
    try:
        return int(datetime.fromisoformat(value.replace('Z', '+00:00')).timestamp())
    except (TypeError, ValueError, AttributeError, OverflowError):
        return 0


def _parse_rss(body, limit):
    root = ET.fromstring(body)
    posts = []
    for entry in root.findall(f'{ATOM}entry'):
        link = _entry_link(entry)
        permalink = urlparse(link).path
        match = re.match(r'^/r/[^/]+/comments/([A-Za-z0-9]+)/', permalink)
        if not match:
            continue
        identifier = _entry_value(entry, 'id').removeprefix('t3_') or match.group(1)
        author = entry.find(f'{ATOM}author/{ATOM}name')
        content = _entry_value(entry, 'content') or _entry_value(entry, 'summary')
        posts.append({
            'id': identifier,
            'title': _entry_value(entry, 'title') or '[No Title]',
            'selftext': _strip_html(content),
            'author': author.text.strip() if author is not None and author.text else '',
            'created_utc': _created_utc(_entry_value(entry, 'published') or _entry_value(entry, 'updated')),
            'score': 0,
            'num_comments': 0,
            'comments': 0,
            'subreddit': permalink.split('/')[2],
            'permalink': permalink,
            'url': f'https://reddit.com{permalink}',
        })
        if len(posts) >= limit:
            break
    return posts


def _optional_count(value):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or value < 0:
        return None
    return int(value)


def _enrich_arctic_metrics(posts):
    """Backfill listing metrics after RSS using one credential-free batch lookup."""
    if not posts or not _env_bool('REDDIT_ARCTIC_METRICS', True):
        return posts
    identifiers = []
    seen = set()
    for post in posts:
        identifier = post.get('id')
        if identifier and identifier not in seen:
            identifiers.append(identifier)
            seen.add(identifier)
    if not identifiers:
        return posts

    base_url = os.environ.get('REDDIT_ARCTIC_METRICS_URL', ARCTIC_METRICS_URL)
    url = f'{base_url}?ids={quote(",".join(identifiers), safe="")}'
    timeout = max(5, int(os.environ.get('REDDIT_ARCTIC_TIMEOUT_S', '10')))
    request = Request(url, headers={
        'Accept': 'application/json',
        'User-Agent': RSS_USER_AGENT,
    })
    try:
        with urlopen(request, timeout=timeout) as response:
            payload = json.loads(response.read(4 * 1024 * 1024))
        rows = payload.get('data') if isinstance(payload, dict) else None
        if not isinstance(rows, list):
            raise ValueError
    except HTTPError as error:
        print(f'  🔖 Reddit: Arctic metrics unavailable (HTTP {error.code})')
        return posts
    except (OSError, URLError, ValueError, TypeError, json.JSONDecodeError):
        print('  🔖 Reddit: Arctic metrics unavailable')
        return posts

    metrics = {row.get('id'): row for row in rows if isinstance(row, dict)}
    for post in posts:
        row = metrics.get(post.get('id'))
        if not row:
            continue
        score = _optional_count(row.get('score'))
        if score is None:
            score = _optional_count(row.get('ups'))
        comments = _optional_count(row.get('num_comments'))
        if score is not None:
            post['score'] = score
            post['ups'] = score
        if comments is not None:
            post['num_comments'] = comments
            post['comments'] = comments
    return posts


def _collect_rss(subreddit, sort, limit):
    clean = re.sub(r'^r/', '', str(subreddit), flags=re.IGNORECASE)
    if not re.fullmatch(r'[A-Za-z0-9_]+', clean):
        raise RuntimeError('COLLECTION_FAILED: invalid subreddit')
    url = f'https://www.reddit.com/r/{quote(clean, safe="")}/{_rss_sort_path(sort)}'
    timeout = max(5, int(os.environ.get('REDDIT_RSS_TIMEOUT_S', '20')))
    retries = max(0, min(2, int(os.environ.get('REDDIT_RSS_MAX_RETRIES', '1'))))
    with _rss_egress_lock():
        for attempt in range(retries + 1):
            request = Request(url, headers={
                'Accept': 'application/atom+xml,application/xml;q=0.9,*/*;q=0.8',
                'User-Agent': RSS_USER_AGENT,
            })
            try:
                with urlopen(request, timeout=timeout) as response:
                    return _enrich_arctic_metrics(_parse_rss(response.read(8 * 1024 * 1024), limit))
            except HTTPError as error:
                if error.code != 429 or attempt >= retries:
                    raise RuntimeError(f'COLLECTION_FAILED: RSS HTTP {error.code}') from None
                time.sleep(_parse_retry_seconds(error) + 1)
            except (URLError, OSError, ET.ParseError, ValueError):
                raise RuntimeError('COLLECTION_FAILED: RSS unavailable') from None
    raise RuntimeError('COLLECTION_FAILED: RSS unavailable')


def collect(subreddit, sort, limit):
    saved = _read_saved_credential()
    try:
        return _collect_authenticated(subreddit, sort, limit, saved)
    except Exception as error:
        if not _env_bool('REDDIT_RSS_FALLBACK'):
            if isinstance(error, RuntimeError):
                raise
            raise RuntimeError('COLLECTION_FAILED: authenticated Reddit request failed') from None
        return _collect_rss(subreddit, sort, limit)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('subreddit')
    parser.add_argument('--sort', default='hot', choices=['hot', 'new', 'top', 'rising', 'controversial'])
    parser.add_argument('--limit', type=int, default=20)
    args = parser.parse_args()
    try:
        if not 1 <= args.limit <= 100:
            raise ValueError('INVALID_LIMIT')
        print(json.dumps({'ok': True, 'data': collect(args.subreddit, args.sort, args.limit)}))
    except Exception as error:
        code = 'AUTH_REQUIRED' if str(error).startswith('AUTH_REQUIRED') else 'COLLECTION_FAILED'
        # Do not emit upstream exceptions, which can contain session material.
        print(json.dumps({'ok': False, 'error': {'code': code, 'message': code}}))


if __name__ == '__main__':
    main()
