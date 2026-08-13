/**
 * End-to-end tests for an NSDL statement.
 *
 * The one fixture carries an NSDL demat account with equities and summary-form bonds, a
 * CDSL demat account with equities, detailed funds and detailed bonds, and the fund-folio
 * pseudo-account. Counts are locked in; the rupee figures are checked by invariant.
 */

import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';

import { readCasPdf } from '../src/parsers/index.js';
import {
  assertAccountBalanceCloses, assertBondDetailedForm, assertBondSummaryForm,
  assertDematAccountWellFormed, assertEquityWellFormed, assertMutualFundWellFormed,
} from './_assertions.js';
import { fixtureBytes, fixturePath, loadPdfBackend, runCli, tempDir } from './_helpers.js';

const EXPECTED_ACCOUNTS = 3;

/** type, equities, funds, summary-form bonds, detailed-form bonds */
const EXPECTED_PER_ACCOUNT = [
  ['NSDL Demat Account', 5, 0, 7, 0],
  ['CDSL Demat Account', 12, 4, 0, 9],
  ['Mutual Fund Folios', 0, 13, 0, 0],
];

const PERIOD_FROM = '01-Dec-2020';
const PERIOD_TO = '31-Dec-2020';

let ready = false;
let fixture = { skip: 'not loaded' };

before(async () => {
  ready = await loadPdfBackend();
  if (!ready) {
    fixture = { skip: 'pdf.js is not installed' };
    return;
  }
  const bytes = fixtureBytes('NSDL_CAS_FILE_1');
  if (!bytes) {
    fixture = { skip: 'NSDL_CAS_FILE_1 is not set' };
    return;
  }
  // The fixture in the current bundle is not password protected.
  fixture = { data: await readCasPdf(bytes, '') };
});

describe('the statement', () => {
  it('names its issuer and its period', (t) => {
    if (fixture.skip) return t.skip(fixture.skip);
    assert.equal(fixture.data.file_type, 'NSDL');
    assert.equal(fixture.data.statement_period.from_, PERIOD_FROM);
    assert.equal(fixture.data.statement_period.to, PERIOD_TO);
  });

  it('finds every account', (t) => {
    if (fixture.skip) return t.skip(fixture.skip);
    assert.equal(fixture.data.accounts.length, EXPECTED_ACCOUNTS);
  });

  it('reads the right number of holdings into each', (t) => {
    if (fixture.skip) return t.skip(fixture.skip);
    EXPECTED_PER_ACCOUNT.forEach(([type, equities, funds, summaryBonds, detailedBonds], index) => {
      const account = fixture.data.accounts[index];
      assert.equal(account.type, type, `account ${index}`);
      assert.equal(account.equities.length, equities, `account ${index} equities`);
      assert.equal(account.mutual_funds.length, funds, `account ${index} funds`);
      assert.equal(account.bonds.length, summaryBonds + detailedBonds, `account ${index} bonds`);
      assert.equal(
        account.bonds.filter((bond) => bond.face_value !== null).length,
        summaryBonds,
        `account ${index} summary-form bonds`,
      );
      assert.equal(
        account.bonds.filter((bond) => bond.market_price !== null).length,
        detailedBonds,
        `account ${index} detailed-form bonds`,
      );
    });
  });

  it('names the investor', (t) => {
    if (fixture.skip) return t.skip(fixture.skip);
    // These statements do not print an email or a mobile number, so only the name is
    // required.
    assert.ok(fixture.data.investor_info.name);
  });
});

describe('account invariants', () => {
  it('has a well-formed account everywhere', (t) => {
    if (fixture.skip) return t.skip(fixture.skip);
    for (const account of fixture.data.accounts) assertDematAccountWellFormed(account);
  });

  it('adds every holding up to the account balance', (t) => {
    if (fixture.skip) return t.skip(fixture.skip);
    for (const account of fixture.data.accounts) assertAccountBalanceCloses(account);
  });

  it('has well-formed holdings rows', (t) => {
    if (fixture.skip) return t.skip(fixture.skip);
    for (const account of fixture.data.accounts) {
      for (const equity of account.equities) assertEquityWellFormed(equity);
      for (const fund of account.mutual_funds) assertMutualFundWellFormed(fund);
    }
  });
});

describe('bonds', () => {
  const bonds = () => fixture.data.accounts.flatMap((account) => account.bonds);

  it('reads the summary form with its full metadata', (t) => {
    if (fixture.skip) return t.skip(fixture.skip);
    const summary = bonds().filter((bond) => bond.face_value !== null);
    assert.ok(summary.length, 'no summary-form bonds in the fixture');
    for (const bond of summary) assertBondSummaryForm(bond);
  });

  it('reads the detailed form with only what it carries', (t) => {
    if (fixture.skip) return t.skip(fixture.skip);
    const detailed = bonds().filter((bond) => bond.market_price !== null);
    assert.ok(detailed.length, 'no detailed-form bonds in the fixture');
    for (const bond of detailed) assertBondDetailedForm(bond);
  });

  it('puts every bond in exactly one of the two forms', (t) => {
    if (fixture.skip) return t.skip(fixture.skip);
    for (const bond of bonds()) {
      const summary = bond.face_value !== null;
      const detailed = bond.market_price !== null;
      assert.ok(summary !== detailed, `bond ${bond.isin} is neither form or both`);
    }
  });
});

describe('the command line', () => {
  it('renders the table for an unencrypted statement', async (t) => {
    const file = fixturePath('NSDL_CAS_FILE_1');
    if (!ready || !file) return t.skip('NSDL_CAS_FILE_1 is not set, or pdf.js is absent');

    const { code, output } = await runCli([file, '-p', '', '-a']);
    assert.equal(code, 0);
    assert.ok(output.includes('Statement Period :'));
    assert.ok(output.includes('NSDL'));
  });
});
