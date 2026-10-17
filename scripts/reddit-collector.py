"""Collect using only explicitly saved application authentication."""
import argparse
import json
import os
from pathlib import Path


def collect(subreddit, sort, limit):
    from rdt_cli.auth import Credential
    from rdt_cli.client import RedditClient

    credential_file = Path(os.environ.get('EAGLEYE_REDDIT_CREDENTIAL_FILE', '~/.config/rdt-cli/credential.json')).expanduser()
    try:
        with credential_file.open() as stream:
            saved = json.load(stream)
        cookies = saved.get('cookies')
        if not isinstance(cookies, dict) or not cookies or not all(isinstance(k, str) and isinstance(v, str) and v for k, v in cookies.items()):
            raise ValueError()
        cred = Credential.from_dict(saved)
    except (OSError, ValueError, AttributeError, TypeError):
        raise RuntimeError('AUTH_REQUIRED: valid application credential file required') from None
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
