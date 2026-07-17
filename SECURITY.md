# Security policy

Olive Remote is intentionally limited to local-network operation. It has no account system, cloud relay, advertising, or analytics service.

## Reporting a vulnerability

Please report a security or privacy issue through a private GitHub security advisory for this repository. Do not include music-library names, exported diagnostics, device addresses, credentials, or other personal data in a public issue.

Include the affected app version, platform, and the minimum steps needed to reproduce the problem. Reports involving a real music server should use redacted diagnostic output.

## Supported version

Until the first public store release, only the latest commit on the `release` branch is supported.

## Trust boundary

The app accepts local HTTP because compatible legacy servers do not provide HTTPS. Requests are restricted to private, loopback, link-local, or `.local` targets; redirects are disabled; automatic fallback discovery is bounded to the active private IPv4 `/24`, ports 80 and 8163, and known identification paths.
