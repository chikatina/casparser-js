# Contributing to casparser-js

Contributions are welcome. Here is what you need to know to get started.

## Principles

1. **Strictly in-process**: The parser must never transmit data over the network or leak statement content. Statements are complete financial histories.
2. **Decimal precision**: All monetary calculations, units, and NAVs use the internal `Decimal` class to prevent binary floating-point rounding errors. Never use JavaScript `Number` for monetary arithmetic.
3. **No runtime dependencies**: Beyond the optional peer dependency on `pdfjs-dist`, the core package remains dependency-free.
4. **No private data in tests**: Never commit real statements, PANs, bank accounts, or names. Tests use synthetic data, structural mocks, or masked geometry.

## Setup

Requires Node.js 20 or later.

```bash
git clone https://github.com/chikatina/casparser-js.git
cd casparser-js
npm install
```

## Running Tests

```bash
# Run the complete test suite
npm test

# Run tests with code coverage report
npm run test:coverage
```

### Testing with Real Statements Locally

Integration tests look for optional environment variables pointing to real statements on your local machine:

- `CAMS_CAS_FILE` and `CAMS_CAS_PASSWORD`
- `KFINTECH_CAS_FILE`
- `NSDL_CAS_FILE_1`

If these variables are unset, integration suites skip automatically while all invariant, unit, schema, and documentation tests run and pass.

## Schema Synchronization

If you alter any model in `src/types.js`:

```bash
npm run schema
```

This regenerates `schema/CASData.schema.json` and `schema/NSDLCASData.schema.json`. The CI suite checks that the checked-in schemas match what the models produce.

## Pull Requests

1. Fork the repo and create your branch from `master`.
2. Ensure `npm test` passes.
3. Keep commits atomic and clearly titled.
4. Open a pull request describing what you changed and why.
