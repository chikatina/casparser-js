/**
 * The capital-gains report driven through a real parsed statement.
 *
 * The unit tests cover the pieces; these exercise the public surface end to end so the
 * import side and the formatting side both get run.
 */

import assert from 'node:assert/strict';
import path from 'node:path';
import { before, describe, it } from 'node:test';

import { readCasPdf } from '../src/parsers/index.js';
import { CapitalGainsReport } from '../src/analysis/index.js';
import { IncompleteCASError } from '../src/exceptions.js';
import { Decimal } from '../src/decimal.js';
import { fixtureBytes, fixturePath, loadPdfBackend, runCli, tempDir } from './_helpers.js';

let ready = false;
let fixture = { skip: 'not loaded' };

before(async () => {
  ready = await loadPdfBackend();
  if (!ready) {
    fixture = { skip: 'pdf.js is not installed' };
    return;
  }
  const bytes = fixtureBytes('KFINTECH_CAS_FILE_NEW');
  if (!bytes) {
    fixture = { skip: 'KFINTECH_CAS_FILE_NEW is not set' };
    return;
  }
  fixture = { data: await readCasPdf(bytes, process.env.KFINTECH_CAS_PASSWORD || '') };
});

describe('the report', () => {
  it('builds from a parsed statement and exposes the documented surface', (t) => {
    if (fixture.skip) return t.skip(fixture.skip);
    const report = new CapitalGainsReport(fixture.data);
    assert.equal(typeof report.hasGains(), 'boolean');
    assert.equal(typeof report.hasError(), 'boolean');
    assert.ok(Array.isArray(report.getFyList()));
    assert.ok(report.invested_amount instanceof Decimal);
    assert.ok(report.current_value instanceof Decimal);
  });

  it('renders the per-year breakdown', (t) => {
    if (fixture.skip) return t.skip(fixture.skip);
    assert.ok(Array.isArray(new CapitalGainsReport(fixture.data).getSummary()));
  });

  it('renders both comma-separated exports even with nothing realised', (t) => {
    if (fixture.skip) return t.skip(fixture.skip);
    const report = new CapitalGainsReport(fixture.data);
    assert.equal(typeof report.getSummaryCsvData(), 'string');
    assert.equal(typeof report.getGainsCsvData(), 'string');
  });

  it('generates the Schedule 112A report for any year, empty or not', (t) => {
    if (fixture.skip) return t.skip(fixture.skip);
    const report = new CapitalGainsReport(fixture.data);
    const years = report.getFyList();
    const target = years.length ? years[0] : 'FY2020-21';
    assert.ok(Array.isArray(report.generate112a(target)));
    assert.equal(typeof report.generate112aCsvData(target), 'string');
  });
});

describe('an incomplete statement', () => {
  it('refuses to compute gains when a scheme opens with a balance', async (t) => {
    if (!ready) return t.skip('pdf.js is not installed');
    const bytes = fixtureBytes('CAMS_CAS_FILE');
    if (!bytes) return t.skip('CAMS_CAS_FILE is not set');

    const data = await readCasPdf(bytes, process.env.CAMS_CAS_PASSWORD || '');
    const hasOpeningBalance = data.folios.some((folio) => folio.schemes.some(
      (scheme) => Decimal.from(scheme.open).gte(Decimal.parse('0.01')) && scheme.transactions.length,
    ));
    if (!hasOpeningBalance) return t.skip('this sample opens at zero everywhere');

    assert.throws(() => new CapitalGainsReport(data), IncompleteCASError);
  });
});

describe('the command line', () => {
  it('runs the whole pipeline through to the Schedule 112A export', async (t) => {
    const file = fixturePath('KFINTECH_CAS_FILE_NEW');
    if (!ready || !file) return t.skip('KFINTECH_CAS_FILE_NEW is not set, or pdf.js is absent');

    const output = path.join(tempDir('casparser-gains-'), 'gains.csv');
    const { code } = await runCli([
      file, '-p', process.env.KFINTECH_CAS_PASSWORD || '', '-g', '--gains-112a', 'FY2020-21',
      '-o', output,
    ]);
    // Nought is success; two is "the statement is incomplete", which is also a valid
    // outcome for a sample that starts mid-history. Either way the pipeline ran.
    assert.ok([0, 2].includes(code), `unexpected exit ${code}`);
  });
});
