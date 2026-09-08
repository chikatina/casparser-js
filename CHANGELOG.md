# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] - 2025-01-01

### Added
- Initial release: JavaScript port of `casparser` and `casparser-isin`.
- Parsers for CAMS (detailed and summary), KFintech (detailed and summary), NSDL CAS, and CDSL CAS statements.
- Exact arbitrary-precision decimal arithmetic via internal `Decimal` implementation.
- Full capital gains reporting:
  - First-in, first-out (FIFO) unit matching.
  - Grandfathering computation for equity lots held on or before 31 January 2018.
  - Schedule 112A rows and CSV export for income tax filing utilities.
  - Advance tax quarterly gain distribution windows.
- Pluggable PDF backends with native `pdfjs-dist` support.
- Pluggable ISIN database interface with built-in SQLite (`SqlIsinDb`) and in-memory (`MemoryIsinDb`) adapters.
- CLI tool (`casparser-js` / `casparser`) supporting JSON, CSV, and formatted tabular outputs.
- Self-verifying JSON Schema generation for TypeScript tooling and contract validation.
