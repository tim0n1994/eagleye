# Security policy

## Supported versions

| Version | Supported |
| --- | --- |
| `main` | Yes |
| Published stable releases | Yes, for the latest release line |
| Older internal or pre-release tags | No |

## Reporting a vulnerability

Please report security issues privately through [GitHub Security Advisories](https://github.com/tim0n1994/eagleye/security/advisories/new).
Include the affected commit or release, the smallest reproducible example,
the impact, and any suggested mitigation. Do not put credentials, cookies,
private source data, or an exploitable proof of concept in a public issue.

We will acknowledge a report within seven days and keep the report private
while a fix and disclosure date are agreed with the reporter.

Eagleye deployments commonly handle credentials, authenticated source
sessions, model gateway access, and a local intelligence database. Keep those
outside Git and rotate any credential that may have been exposed during
diagnosis.
