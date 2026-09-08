# Security Policy

## Privacy & Security Model

`@chikatina/casparser-js` is designed with a strict privacy-first model:

- **100% In-Process**: Statements are parsed entirely in memory within your Node.js or browser process.
- **Zero Network Activity**: No analytics, telemetry, remote calls, or external service communication.
- **Zero Disk Persistence by Default**: The library does not write statement data to disk unless you explicitly invoke file export options.

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| 1.x     | :white_check_mark: |

## Reporting a Vulnerability

If you discover a security issue or vulnerability:

1. **Do not open a public issue.**
2. Report via GitHub Private Vulnerability Reporting at:
   https://github.com/chikatina/casparser-js/security/advisories/new
3. Alternatively, contact the maintainers directly through GitHub.

We will acknowledge receipt within 48 hours and coordinate a patch and advisory.
