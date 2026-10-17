import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile
import types
import unittest
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


if __name__ == '__main__': unittest.main()
