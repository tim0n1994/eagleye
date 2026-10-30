#!/usr/bin/env python3
"""Reject deployment details in publishable files without echoing their values."""
import ipaddress
import json
from pathlib import Path
import re
import subprocess
import sys

PRIVATE_NETWORKS = tuple(ipaddress.ip_network(net) for net in (
    '10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '100.64.0.0/10',
))
IPV4 = re.compile(r'(?<![\d.])(?:\d{1,3}\.){3}\d{1,3}(?![\d.])')
HOME_PATH = re.compile(r'/(?:home|Users)/([A-Za-z0-9_.-]+)/')
EXAMPLE_USERS = {'user', 'username', 'example', 'runner'}
TAILNET = re.compile(r'\b[\w-]+(?:\.[\w-]+)*\.ts\.net\b', re.I)
MODEL_FIELDS = {'model', 'model_name', 'requested_model', 'actual_model', 'resolved_model', 'upstream_model'}


def findings(path, text):
    """Return categories and locations only; never include a matched value."""
    result = []
    for number, line in enumerate(text.splitlines(), 1):
        for match in IPV4.finditer(line):
            try:
                address = ipaddress.ip_address(match.group())
            except ValueError:
                continue
            # Network definitions describe the rule, not a deployment address.
            if any(address in network for network in PRIVATE_NETWORKS):
                if path == 'scripts/check-public-privacy.py' and '/' in line[match.end():match.end() + 1]:
                    continue
                result.append((number, 'private-network-address'))
                break
        if any(m.group(1) not in EXAMPLE_USERS for m in HOME_PATH.finditer(line)):
            result.append((number, 'personal-home-path'))
        if TAILNET.search(line):
            result.append((number, 'private-tailnet-host'))
    # Release evidence must not disclose the operator's model selections.
    if ((path.startswith('docs/releases/') and path.endswith('.json'))
            or path == 'deploy/thinkpad/deployment.example.json'):
        try:
            value = json.loads(text)
        except ValueError:
            result.append((1, 'invalid-release-evidence-json'))
        else:
            def walk(node):
                if isinstance(node, dict):
                    for key, item in node.items():
                        if key in MODEL_FIELDS and isinstance(item, str) and item:
                            if not re.fullmatch(r'[<\[]?(?:configured|example|test|primary|fallback|redacted)[\w .—<>\[\]-]*', item, re.I):
                                result.append((1, 'deployment-model-selection'))
                        walk(item)
                elif isinstance(node, list):
                    for item in node:
                        walk(item)
            walk(value)
    return sorted(set(result))


def main():
    root = Path(__file__).resolve().parent.parent
    paths = subprocess.check_output(
        ['git', 'ls-files', '-z', '--cached', '--others', '--exclude-standard'], cwd=root,
    ).decode().split('\0')
    count = 0
    for name in sorted(set(filter(None, paths))):
        path = root / name
        if not path.is_file() or path.is_symlink():
            continue
        data = path.read_bytes()
        if b'\0' in data:
            continue
        for number, category in findings(name, data.decode('utf-8', errors='replace')):
            print(f'{name}:{number}: {category}')
            count += 1
    print(f'Public privacy check: {count} finding(s); matched values suppressed.')
    return int(count != 0)


if __name__ == '__main__':
    sys.exit(main())
