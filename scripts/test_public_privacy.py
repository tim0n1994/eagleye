"""Privacy checks must catch leaks without printing the confidential value."""
import importlib.util
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('public_privacy', Path(__file__).with_name('check-public-privacy.py'))
privacy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(privacy)


class PublicPrivacyTests(unittest.TestCase):
    def test_private_networks_are_rejected_without_echoing_values(self):
        for octets in [(10, 23, 4, 5), (172, 18, 4, 5), (192, 168, 4, 5), (100, 77, 4, 5)]:
            address = '.'.join(map(str, octets))
            result = privacy.findings('deploy/example.md', 'API=http://' + address + ':3019')
            self.assertEqual(result, [(1, 'private-network-address')])
            self.assertNotIn(address, repr(result))

    def test_loopback_documentation_and_public_addresses_remain_valid(self):
        for address in ['127.0.0.1', '192.0.2.1', '198.51.100.2', '203.0.113.3', '8.8.8.8']:
            self.assertEqual(privacy.findings('deploy/example.md', address), [])

    def test_personal_paths_and_tailnet_hosts_are_rejected(self):
        home = '/home/' + 'operator-private' + '/app'
        host = 'operator-private' + '.ts' + '.net'
        self.assertEqual(privacy.findings('README.md', home + '\n' + host), [
            (1, 'personal-home-path'), (2, 'private-tailnet-host'),
        ])
        self.assertEqual(privacy.findings('README.md', '$HOME/app /home/user/app'), [])

    def test_nested_release_evidence_models_require_placeholders(self):
        evidence = '{"runs":[{"model":"operator-private-selection"}]}'
        self.assertEqual(privacy.findings('docs/releases/sample/result.json', evidence), [
            (1, 'deployment-model-selection'),
        ])
        self.assertEqual(privacy.findings('docs/releases/sample/result.json',
            '{"runs":[{"model":"configured-primary-model"}]}'), [])
        # Public provider capabilities in application code are not deployment evidence.
        self.assertEqual(privacy.findings('server/provider-catalog.json', evidence), [])
        self.assertEqual(privacy.findings('docs/releases/sample/result.json',
            '{"actual_model":"operator-private-selection"}'), [(1, 'deployment-model-selection')])

    def test_symlink_targets_are_scanned_without_following_them(self):
        with tempfile.TemporaryDirectory() as directory:
            link = Path(directory) / 'private-skill'
            target = '/home/' + 'operator-private' + '/missing-skill'
            link.symlink_to(target)
            content = privacy.read_publishable_content(link)
            self.assertEqual(content.decode(), target)
            self.assertEqual(privacy.findings('.agents/skills/private-skill', content.decode()),
                             [(1, 'personal-home-path')])

            link.unlink()
            outside = Path(directory) / 'target.txt'
            outside.write_text('contents must not be read through the link')
            link.symlink_to(outside)
            self.assertEqual(privacy.read_publishable_content(link).decode(), str(outside))


if __name__ == '__main__':
    unittest.main()
