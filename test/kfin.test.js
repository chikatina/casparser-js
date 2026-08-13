/**
 * End-to-end tests for KFintech statements: two detailed fixtures and a summary one,
 * mirroring the CAMS file.
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
  main: { folios: 17, schemes: 30, from: '01-Jan-1990', to: '31-Mar-2021' },
  new: { folios: 14, schemes: 30, from: '01-Jan-2000', to: '03-Sep-2023' },
};
const SUMMARY = { folios: 9, schemes: 13 };

let ready = false;
before(async () => { ready = await loadPdfBackend(); });

async function load(fileVar) {
  if (!ready) return { skip: 'pdf.js is not installed' };
  const bytes = fixtureBytes(fileVar);
  if (!bytes) return { skip: `${fileVar} is not set` };
  return { data: await readCasPdf(bytes, process.env.KFINTECH_CAS_PASSWORD || '') };
}

describe('KFintech detailed', () => {
  let fixture;
  before(async () => { fixture = await load('KFINTECH_CAS_FILE'); });

  it('has the expected shape', (t) => {
    if (fixture.skip) return t.skip(fixture.skip);
    const { data } = fixture;
    assert.equal(data.file_type, 'KFINTECH');
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

  it('holds every invariant', (t) => {
    if (fixture.skip) return t.skip(fixture.skip);
    for (const folio of fixture.data.folios) {
      assertFolioWellFormed(folio);
      for (const scheme of folio.schemes) {
        assertSchemeWellFormed(scheme);
        assertSchemeValuationArithmetic(scheme);
        // Only possible because the overlay duplicates are dropped at extraction: the
        // date overlay used to corrupt instalment rows and break this.
        assertSchemeTransactionUnitsClose(scheme);
      }
    }
  });
});

describe('KFintech detailed, multi-decade', () => {
  let fixture;
  before(async () => { fixture = await load('KFINTECH_CAS_FILE_NEW'); });

  it('has the expected shape', (t) => {
    if (fixture.skip) return t.skip(fixture.skip);
    const { data } = fixture;
    assert.equal(data.file_type, 'KFINTECH');
    assert.equal(data.cas_type, CASFileType.DETAILED);
    assert.equal(data.statement_period.from_, DETAILED.new.from);
    assert.equal(data.statement_period.to, DETAILED.new.to);
    assert.equal(data.folios.length, DETAILED.new.folios);
    assert.equal(
      data.folios.reduce((total, folio) => total + folio.schemes.length, 0),
      DETAILED.new.schemes,
    );
  });

  it('holds every invariant', (t) => {
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

describe('KFintech summary', () => {
  let fixture;
  before(async () => { fixture = await load('KFINTECH_CAS_SUMMARY'); });

  it('has the expected shape', (t) => {
    if (fixture.skip) return t.skip(fixture.skip);
    const { data } = fixture;
    assert.equal(data.file_type, 'KFINTECH');
    assert.equal(data.cas_type, CASFileType.SUMMARY);
    assert.equal(data.folios.length, SUMMARY.folios);
    assert.equal(
      data.folios.reduce((total, folio) => total + folio.schemes.length, 0),
      SUMMARY.schemes,
    );
  });

  it('carries the investor block and keeps the footer out of the names', (t) => {
    if (fixture.skip) return t.skip(fixture.skip);
    assertInvestorInfoComplete(fixture.data.investor_info);
    for (const folio of fixture.data.folios) {
      for (const scheme of folio.schemes) {
        assertSchemeWellFormed(scheme);
        assertSchemeNameClean(scheme);
      }
    }
  });
});

describe('the command line, KFintech paths', () => {
  it('writes JSON', async (t) => {
    const file = fixturePath('KFINTECH_CAS_FILE');
    if (!ready || !file) return t.skip('KFINTECH_CAS_FILE is not set, or pdf.js is absent');

    const output = path.join(tempDir('casparser-kfin-'), 'out.json');
    const { code, output: printed } = await runCli([
      file, '-p', process.env.KFINTECH_CAS_PASSWORD || '', '-o', output,
    ]);
    assert.equal(code, 0, printed);
    assert.equal(JSON.parse(fs.readFileSync(output, 'utf-8')).file_type, 'KFINTECH');
  });

  it('reports a wrong password cleanly', async (t) => {
    const file = fixturePath('KFINTECH_CAS_FILE');
    if (!ready || !file || !process.env.CAMS_CAS_PASSWORD) {
      return t.skip('KFINTECH_CAS_FILE or CAMS_CAS_PASSWORD is not set');
    }
    const { code, output } = await runCli([file, '-p', process.env.CAMS_CAS_PASSWORD]);
    assert.notEqual(code, 0);
    assert.ok(output.includes('Incorrect PDF password!'));
  });
});
