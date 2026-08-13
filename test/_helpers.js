/**
 * Shared fixtures for the suite.
 *
 * The end-to-end tests need real statements, which cannot live in a public repository.
 * Each one reads its path and password from the environment and skips when they are
 * absent, so a contributor without the sample bundle still runs everything else.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Atom, Block, Cell } from '../src/parsers/pageobj.js';
import { MemoryIsinDb, setIsinProvider } from '../src/isin.js';

/** A `Cell` with one synthetic atom behind it. */
export function cell(text, xLeft = 0, xRight = 10, yTop = 0, yBot = 0) {
  const atom = new Atom(xLeft, xRight, yTop, yBot, text, 'Helvetica', 0);
  return new Cell({ xLeft, xRight, yTop, yBot, text, atoms: [atom] });
}

/** A `Block` of cells. */
export function block(cells, page = 8) {
  return new Block(page, cells);
}

/** A synthetic `Atom`, for the column-join tests. */
export function atom(text, xLeft = 100, xRight = 200, yTop = 500, yBot = 490) {
  return new Atom(xLeft, xRight, yTop, yBot, text, 'Helvetica', 0);
}

/**
 * The reference database rows the original suite relied on.
 *
 * The real database is close to fifty megabytes and is published as a separate artefact,
 * so the tests that assert a specific lookup carry the handful of rows they assert on.
 * The lookup logic itself is exercised against a real database in `isin-db.test.js`.
 */
export const SAMPLE_ISIN_ROWS = [
  {
    id: 1,
    isin: 'INF846K01EW2',
    amfi_code: '120503',
    type: 'EQUITY',
    rta: 'KFINTECH',
    rta_code: '128TSDGG',
    scheme: 'Axis Long Term Equity Fund - Direct Growth',
    name: 'AXIS LONG TERM EQUITY FUND - DIRECT PLAN - GROWTH OPTION',
    nav: '44.6503',
  },
  {
    id: 2,
    isin: 'INF174V01317',
    amfi_code: '141224',
    type: 'EQUITY',
    rta: 'KFINTECH',
    rta_code: 'PPFCDG',
    scheme: 'Parag Parikh Flexi Cap Fund - Direct Growth',
    name: 'PARAG PARIKH FLEXI CAP FUND - DIRECT PLAN - GROWTH',
  },
  {
    id: 3,
    isin: 'INE002A01018',
    name: 'RELIANCE INDUSTRIES LIMITED',
    issuer: 'RELIANCE INDUSTRIES LIMITED',
    type: 'EQUITY SHARES',
    status: 'ACTIVE',
    symbol: 'RELIANCE',
    exchange: 'NSE',
  },
];

/** Installs the sample reference rows for the duration of a test file. */
export function useSampleIsinDb(rows = SAMPLE_ISIN_ROWS) {
  setIsinProvider(new MemoryIsinDb(rows));
}

export function clearIsinDb() {
  setIsinProvider(null);
}

/** Splits text into lines the way `str.splitlines` does, tolerating carriage returns. */
export function splitLines(text) {
  return text.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n');
}

/**
 * The environment variable naming a statement fixture, or null when it is not set. The
 * caller skips rather than fails: the fixtures are private.
 */
export function fixturePath(name) {
  const value = process.env[name];
  if (!value) return null;
  return fs.existsSync(value) ? value : null;
}

export function fixtureBytes(name) {
  const path = fixturePath(name);
  return path ? new Uint8Array(fs.readFileSync(path)) : null;
}

/** Runs the command line in-process, capturing what it prints. */
export async function runCli(args) {
  const { main } = await import('../bin/casparser.js');
  const lines = [];
  const original = console.log;
  console.log = (...parts) => lines.push(parts.join(' '));
  try {
    const code = await main(args);
    return { code, output: lines.join('\n') };
  } finally {
    console.log = original;
  }
}

/** A throwaway directory for a test that writes files. */
export function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** Wires up pdf.js, when it is installed. The end-to-end tests skip without it. */
export async function loadPdfBackend() {
  const [{ createPdfjsBackend }, { setPdfBackend }] = await Promise.all([
    import('../src/pdf/pdfjs.js'),
    import('../src/pdf/backend.js'),
  ]);
  const pdfjsLib = await import('pdfjs-dist/legacy/build/pdf.mjs').catch(() => null);
  if (!pdfjsLib) return false;
  setPdfBackend(createPdfjsBackend(pdfjsLib));
  return true;
}
