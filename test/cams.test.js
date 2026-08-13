/**
 * End-to-end tests for CAMS statements.
 *
 * Two detailed fixtures, a short-period one and a multi-decade one, plus a summary
 * fixture. The counts are locked in as a regression guard on header, footer and table
 * boundary detection; the rupee figures stay out of the repository and are checked by
 * invariant instead.
 *
 * Every test skips when its fixture is not configured.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { before, describe, it } from 'node:test';

import { readCasPdf } from '../src/parsers/index.js';
import { CASFileType } from '../src/enums.js';

import {
  assertFolioWellFormed, assertInvestorInfoComplete, assertSchemeNameClean,
  assertSchemeTransactionUnitsClose, assertSchemeValuationArithmetic, assertSchemeWellFormed,
} from './_assertions.js';
import { fixtureBytes, fixturePath, loadPdfBackend, runCli, tempDir } from './_helpers.js';

const DETAILED = {
  main: { folios: 10, schemes: 14, from: '01-Apr-2018', to: '30-Jun-2018' },
  new: { folios: 14, schemes: 30, from: '01-Jan-2000', to: '31-Aug-2023' },
};
const SUMMARY = { folios: 4, schemes: 6 };

let ready = false;
before(async () => {
  ready = await loadPdfBackend();
});

/** Parses a fixture once, or reports why it cannot. */
async function load(fileVar, passwordVar) {
  if (!ready) return { skip: 'pdf.js is not installed' };
  const bytes = fixtureBytes(fileVar);
  if (!bytes) return { skip: `${fileVar} is not set` };
  const data = await readCasPdf(bytes, process.env[passwordVar] || '');
  return { data };
}

describe('CAMS detailed', () => {
  let fixture;
  before(async () => { fixture = await load('CAMS_CAS_FILE', 'CAMS_CAS_PASSWORD'); });

  it('has the expected shape', (t) => {
    if (fixture.skip) return t.skip(fixture.skip);
    const { data } = fixture;
    assert.equal(data.file_type, 'CAMS');
    assert.equal(data.cas_type, CASFileType.DETAILED);
    assert.equal(data.statement_period.from_, DETAILED.main.from);
    assert.equal(data.statement_period.to, DETAILED.main.to);
    assert.equal(data.folios.length, DETAILED.main.folios);
    assert.equal(
      data.folios.reduce((total, folio) => total + folio.schemes.length, 0),
      DETAILED.main.schemes,
    );
  });

  it('carries the whole investor block', (t) => {
    if (fixture.skip) return t.skip(fixture.skip);
    assertInvestorInfoComplete(fixture.data.investor_info);
  });

  it('has a well-formed folio and scheme everywhere', (t) => {
    if (fixture.skip) return t.skip(fixture.skip);
    for (const folio of fixture.data.folios) {
      assertFolioWellFormed(folio);
      for (const scheme of folio.schemes) assertSchemeWellFormed(scheme);
    }
  });

  it('reproduces every valuation from its closing balance', (t) => {
    if (fixture.skip) return t.skip(fixture.skip);
    for (const folio of fixture.data.folios) {
      for (const scheme of folio.schemes) assertSchemeValuationArithmetic(scheme);
    }
  });

  it('accounts for every unit between the opening and closing balances', (t) => {
    if (fixture.skip) return t.skip(fixture.skip);
    for (const folio of fixture.data.folios) {
      for (const scheme of folio.schemes) assertSchemeTransactionUnitsClose(scheme);
    }
  });

  it('keeps the identifiers through a JSON round trip', async (t) => {
    if (fixture.skip) return t.skip(fixture.skip);
    const raw = await readCasPdf(
      fixtureBytes('CAMS_CAS_FILE'), process.env.CAMS_CAS_PASSWORD || '', { output: 'json' },
    );
    const data = JSON.parse(raw);
    assert.equal(data.file_type, 'CAMS');
    assert.equal(data.cas_type, CASFileType.DETAILED);
    assert.equal(data.folios.length, DETAILED.main.folios);
    for (const folio of data.folios) {
      for (const scheme of folio.schemes) {
        assert.ok(scheme.isin, `no ISIN after serialisation: ${scheme.scheme}`);
        assert.ok(scheme.amfi, `no AMFI code after serialisation: ${scheme.scheme}`);
      }
    }
  });

  it('releases the document once parsing returns', async (t) => {
    if (fixture.skip) return t.skip(fixture.skip);
    // Holding the document open leaks its page handles. The backend is wrapped so the
    // document it hands back can be watched.
    const { getPdfBackend, setPdfBackend } = await import('../src/pdf/backend.js');
    const backend = getPdfBackend();
    const opened = [];
    setPdfBackend({
      async open(source, password) {
        const document = await backend.open(source, password);
        opened.push(document);
        const close = document.close.bind(document);
        document.close = async () => { document.closed = true; return close(); };
        return document;
      },
    });
    try {
      await readCasPdf(fixtureBytes('CAMS_CAS_FILE'), process.env.CAMS_CAS_PASSWORD || '');
    } finally {
      setPdfBackend(backend);
    }
    assert.equal(opened.length, 1);
    assert.ok(opened[0].closed, 'the document was left open');
  });
});

describe('CAMS detailed, multi-decade', () => {
  let fixture;
  before(async () => { fixture = await load('CAMS_CAS_FILE_NEW', 'CAMS_CAS_PASSWORD'); });

  it('has the expected shape', (t) => {
    if (fixture.skip) return t.skip(fixture.skip);
    const { data } = fixture;
    assert.equal(data.file_type, 'CAMS');
    assert.equal(data.cas_type, CASFileType.DETAILED);
    assert.equal(data.statement_period.from_, DETAILED.new.from);
    assert.equal(data.statement_period.to, DETAILED.new.to);
    assert.equal(data.folios.length, DETAILED.new.folios);
    assert.equal(
      data.folios.reduce((total, folio) => total + folio.schemes.length, 0),
      DETAILED.new.schemes,
    );
  });

  it('holds the invariants across every scheme', (t) => {
    if (fixture.skip) return t.skip(fixture.skip);
    for (const folio of fixture.data.folios) {
      for (const scheme of folio.schemes) {
        assertSchemeWellFormed(scheme);
        assertSchemeValuationArithmetic(scheme);
        assertSchemeTransactionUnitsClose(scheme);
      }
    }
  });
});

describe('CAMS summary', () => {
  let fixture;
  before(async () => { fixture = await load('CAMS_CAS_SUMMARY', 'CAMS_CAS_PASSWORD'); });

  it('has the expected shape', (t) => {
    if (fixture.skip) return t.skip(fixture.skip);
    const { data } = fixture;
    assert.equal(data.file_type, 'CAMS');
    assert.equal(data.cas_type, CASFileType.SUMMARY);
    assert.equal(data.folios.length, SUMMARY.folios);
    assert.equal(
      data.folios.reduce((total, folio) => total + folio.schemes.length, 0),
      SUMMARY.schemes,
    );
  });

  it('carries the whole investor block', (t) => {
    if (fixture.skip) return t.skip(fixture.skip);
    assertInvestorInfoComplete(fixture.data.investor_info);
  });

  it('keeps the footer out of the last scheme name', (t) => {
    if (fixture.skip) return t.skip(fixture.skip);
    for (const folio of fixture.data.folios) {
      for (const scheme of folio.schemes) {
        assertSchemeWellFormed(scheme);
        assertSchemeNameClean(scheme);
        assertSchemeValuationArithmetic(scheme);
      }
    }
  });
});

describe('the command line', () => {
  it('writes JSON when asked for a .json file', async (t) => {
    const file = fixturePath('CAMS_CAS_FILE');
    if (!ready || !file) return t.skip('CAMS_CAS_FILE is not set, or pdf.js is absent');

    const directory = tempDir('casparser-cli-');
    const output = path.join(directory, 'out.json');
    const { code, out } = await runCli([file, '-p', process.env.CAMS_CAS_PASSWORD || '', '-o', output])
      .then((result) => ({ code: result.code, out: result.output }));

    assert.equal(code, 0, out);
    assert.ok(out.includes('File saved'));
    assert.equal(JSON.parse(fs.readFileSync(output, 'utf-8')).file_type, 'CAMS');
  });

  it('writes the detailed columns when asked for a .csv file', async (t) => {
    const file = fixturePath('CAMS_CAS_FILE');
    if (!ready || !file) return t.skip('CAMS_CAS_FILE is not set, or pdf.js is absent');

    const output = path.join(tempDir('casparser-cli-'), 'out.csv');
    const { code, output: printed } = await runCli([
      file, '-p', process.env.CAMS_CAS_PASSWORD || '', '-o', output,
    ]);
    assert.equal(code, 0, printed);
    const content = fs.readFileSync(output, 'utf-8');
    for (const column of ['amc', 'folio', 'isin', 'amfi', 'scheme']) {
      assert.ok(content.includes(column), `missing column ${column}`);
    }
  });

  it('prints the statement period to the terminal', async (t) => {
    const file = fixturePath('CAMS_CAS_FILE');
    if (!ready || !file) return t.skip('CAMS_CAS_FILE is not set, or pdf.js is absent');

    const { code, output } = await runCli([file, '-p', process.env.CAMS_CAS_PASSWORD || '', '-a']);
    assert.equal(code, 0);
    assert.ok(output.includes('Statement Period :'));
  });
});
