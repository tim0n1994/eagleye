import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile
import types
import unittest
from urllib.error import HTTPError
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location('collector', Path(__file__).resolve().parents[3] / 'scripts/reddit-collector.py')
collector = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(collector)


class CollectorTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.file = Path(self.tmp.name) / 'credential.json'
        self.events = []
        self.identity = {'name': 'fixture-user'}
        self.listing = {'data': {'children': [{'data': {'id': 'abc', 'permalink': '/r/test/comments/abc/title/', 'num_comments': 7, 'url_overridden_by_dest': 'https://example.org', 'title': 'fixture'}}]}}
        owner = self
        class Credential:
            @classmethod
            def from_dict(cls, data):
                owner.events.append('credential')
                return data
        class Client:
            def __init__(self, *, credential):
                owner.events.append('client')
                assert credential['cookies']
            def __enter__(self): return self
            def __exit__(self, *args): pass
            def get_me(self):
                owner.events.append('identity')
                return owner.identity
            def get_subreddit(self, sub, **opts):
                owner.events.append(('listing', sub, opts))
                return owner.listing
        self.enterContext(patch.dict(sys.modules, {'rdt_cli': types.ModuleType('rdt_cli'), 'rdt_cli.auth': types.SimpleNamespace(Credential=Credential), 'rdt_cli.client': types.SimpleNamespace(RedditClient=Client)}))
        self.enterContext(patch.dict(os.environ, EAGLEYE_REDDIT_CREDENTIAL_FILE=str(self.file)))

    def test_missing_invalid_auth_never_constructs_client(self):
        for content in [None, '{}', '{', '[]', '{"cookies": {"session": ""}}']:
            if content is not None: self.file.write_text(content)
            with self.assertRaisesRegex(RuntimeError, 'AUTH_REQUIRED'):
                collector.collect('test', 'hot', 20)
            self.assertEqual(self.events, [])

    def test_identity_required_before_listing(self):
        self.file.write_text('{"cookies":{"session":"synthetic"}}')
        for identity in [{}, {'name': ''}, None]:
            self.events.clear()
            self.identity = identity
            with self.assertRaisesRegex(RuntimeError, 'AUTH_REQUIRED'):
                collector.collect('test', 'hot', 20)
            self.assertEqual(self.events, ['credential', 'client', 'identity'])

    def test_mapping_and_call_order(self):
        self.file.write_text('{"cookies":{"session":"synthetic"}}')
        result = collector.collect('test', 'new', 3)
        self.assertEqual(self.events, ['credential', 'client', 'identity', ('listing', 'test', {'sort': 'new', 'limit': 3})])
        self.assertEqual(result[0]['comments'], 7)
        self.assertEqual(result[0]['url'], 'https://reddit.com/r/test/comments/abc/title/')
        self.assertEqual(result[0]['url_overridden_by_dest'], 'https://example.org')

    def test_malformed_listing_throws(self):
        self.file.write_text('{"cookies":{"session":"synthetic"}}')
        for listing in [{}, {'data': {'children': {}}}, {'data': {'children': [{}]}}]:
            self.listing = listing
            with self.assertRaisesRegex(RuntimeError, 'SCHEMA_ERROR'):
                collector.collect('test', 'hot', 20)

    def test_reddit_t2_identity_envelope_is_authenticated(self):
        self.file.write_text('{"cookies":{"session":"synthetic"}}')
        self.identity = {'kind': 't2', 'data': {'name': 'fixture-user'}}
        self.assertEqual(len(collector.collect('test', 'hot', 1)), 1)
        self.assertEqual(self.events[-1], ('listing', 'test', {'sort': 'hot', 'limit': 1}))

    def test_forbidden_authenticated_api_falls_back_to_public_atom_rss(self):
        self.file.write_text('{"cookies":{"session":"synthetic"}}')
        rss = b'''<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <id>t3_rss123</id>
    <title>RSS fixture</title>
    <updated>2026-10-25T00:00:00+00:00</updated>
    <author><name>fixture-author</name></author>
    <link rel="alternate" href="https://www.reddit.com/r/test/comments/rss123/title/" />
    <content type="html">&lt;p&gt;fixture &amp;amp; body&lt;/p&gt;</content>
  </entry>
</feed>'''

        class Response:
            def __enter__(self): return self
            def __exit__(self, *args): pass
            def read(self, _limit): return rss

        class Credential:
            @classmethod
            def from_dict(cls, data): return data

        class Client:
            def __init__(self, *, credential): pass
            def __enter__(self): return self
            def __exit__(self, *args): pass
            def get_me(self): raise RuntimeError('403 Blocked')

        self.enterContext(patch.dict(sys.modules, {
            'rdt_cli': types.ModuleType('rdt_cli'),
            'rdt_cli.auth': types.SimpleNamespace(Credential=Credential),
            'rdt_cli.client': types.SimpleNamespace(RedditClient=Client),
        }))
        self.enterContext(patch.dict(os.environ, {
            'REDDIT_RSS_FALLBACK': '1',
            'REDDIT_RSS_MAX_RETRIES': '0',
            'REDDIT_RSS_STATE_FILE': str(Path(self.tmp.name) / 'rss-state.json'),
        }))
        with patch.object(collector, 'urlopen', return_value=Response()) as fetch:
            posts = collector.collect('test', 'hot', 1)
        self.assertEqual(posts[0]['id'], 'rss123')
        self.assertEqual(posts[0]['url'], 'https://reddit.com/r/test/comments/rss123/title/')
        self.assertEqual(posts[0]['selftext'], 'fixture & body')
        self.assertNotIn('Cookie', fetch.call_args.args[0].headers)

    def test_rss_rate_limit_waits_for_server_reset_before_retry(self):
        self.file.write_text('{"cookies":{"session":"synthetic"}}')

        class Response:
            def __enter__(self): return self
            def __exit__(self, *args): pass
            def read(self, _limit): return b'<feed xmlns="http://www.w3.org/2005/Atom" />'

        class Credential:
            @classmethod
            def from_dict(cls, data): return data

        class Client:
            def __init__(self, *, credential): pass
            def __enter__(self): return self
            def __exit__(self, *args): pass
            def get_me(self): raise RuntimeError('403 Blocked')

        self.enterContext(patch.dict(sys.modules, {
            'rdt_cli': types.ModuleType('rdt_cli'),
            'rdt_cli.auth': types.SimpleNamespace(Credential=Credential),
            'rdt_cli.client': types.SimpleNamespace(RedditClient=Client),
        }))
        self.enterContext(patch.dict(os.environ, {
            'REDDIT_RSS_FALLBACK': '1',
            'REDDIT_RSS_MAX_RETRIES': '1',
            'REDDIT_RSS_STATE_FILE': str(Path(self.tmp.name) / 'rss-state.json'),
        }))
        rate_limited = HTTPError('https://reddit.test', 429, 'limited', {'x-ratelimit-reset': '3'}, None)
        with patch.object(collector, 'urlopen', side_effect=[rate_limited, Response()]), patch.object(collector.time, 'sleep') as pause:
            self.assertEqual(collector.collect('test', 'hot', 1), [])
        pause.assert_called_once_with(4)


if __name__ == '__main__': unittest.main()
