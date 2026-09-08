# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.1.0] - 2026-09-09

### Added
- `Folio.name`: Extract primary folio holder name from CAMS and KFintech statements, enabling multi-investor folio attribution.
- Wrapped transaction description continuation: stitch multi-line descriptions within 10pt baseline gap in transaction tables, preventing SIP instalment tags from truncating and correctly reclassifying rows to `PURCHASE_SIP`.
- Informational marker rows: preserve non-financial events (`***Registration of Nominee***`, balance restatements) as `TransactionType.MISC` rows with `amount: null`, `units: null`, and `nav: null`, while safely filtering out stray footnote dates.
- Dedicated unit test suite (`test/cams-units.test.js`) validating folio name extraction, continuation merging, and marker row emission without requiring private PDF fixtures.
- Full CI/CD automation: multi-OS matrix test workflow (Node 20, 22, 24 on Ubuntu and Windows) and automated npm release publishing with provenance.

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
