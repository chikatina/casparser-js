/**
 * End-to-end tests for a CDSL statement.
 *
 * The fixture carries a CDSL demat account, an NSDL one (these statements cross-reference
 * the other depository), and the fund-folio pseudo-account.
 */

import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';

import { readCasPdf } from '../src/parsers/index.js';
import {
  assertAccountBalanceCloses, assertDematAccountWellFormed, assertEquityWellFormed,
  assertMutualFundWellFormed,
} from './_assertions.js';
import { fixtureBytes, fixturePath, loadPdfBackend, runCli, tempDir } from './_helpers.js';

const EXPECTED_ACCOUNTS = 3;

/** type, equities, funds, bonds */
const EXPECTED_PER_ACCOUNT = [
  ['CDSL Demat Account', 25, 1, 0],
  ['NSDL Demat Account', 2, 0, 0],
  ['Mutual Fund Folios', 0, 16, 0],
];

const PERIOD_FROM = '01-Apr-2025';
const PERIOD_TO = '31-Mar-2026';

let ready = false;
let fixture = { skip: 'not loaded' };

before(async () => {
  ready = await loadPdfBackend();
  if (!ready) {
    fixture = { skip: 'pdf.js is not installed' };
    return;
  }
  const bytes = fixtureBytes('CDSL_CAS_FILE_1');
  if (!bytes) {
    fixture = { skip: 'CDSL_CAS_FILE_1 is not set' };
    return;
  }
  fixture = { data: await readCasPdf(bytes, process.env.CDSL_CAS_PASSWORD || '') };
});

describe('the statement', () => {
  it('names its issuer and its period', (t) => {
    if (fixture.skip) return t.skip(fixture.skip);
    assert.equal(fixture.data.file_type, 'CDSL');
    assert.equal(fixture.data.statement_period.from_, PERIOD_FROM);
    assert.equal(fixture.data.statement_period.to, PERIOD_TO);
  });

  it('finds every account and its holdings', (t) => {
    if (fixture.skip) return t.skip(fixture.skip);
    assert.equal(fixture.data.accounts.length, EXPECTED_ACCOUNTS);
    EXPECTED_PER_ACCOUNT.forEach(([type, equities, funds, bonds], index) => {
      const account = fixture.data.accounts[index];
      assert.equal(account.type, type, `account ${index}`);
      assert.equal(account.equities.length, equities, `account ${index} equities`);
      assert.equal(account.mutual_funds.length, funds, `account ${index} funds`);
      assert.equal(account.bonds.length, bonds, `account ${index} bonds`);
    });
  });

  it('names the investor', (t) => {
    if (fixture.skip) return t.skip(fixture.skip);
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

  it('fills in the scheme codes a depository does not print', (t) => {
    if (fixture.skip) return t.skip(fixture.skip);
    // Only meaningful with a reference database registered; without one there is nothing
    // to fill in and the check has no subject.
    const funds = fixture.data.accounts.flatMap((account) => account.mutual_funds);
    assert.ok(funds.length, 'the fixture should carry fund holdings');
    if (!funds.some((fund) => fund.amfi)) return t.skip('no reference database registered');
    for (const fund of funds) {
      assert.ok(fund.amfi, `${fund.isin}: no AMFI code`);
      assert.ok(['EQUITY', 'DEBT'].includes(fund.type), `${fund.isin}: type ${fund.type}`);
    }
  });
});

describe('output', () => {
  it('keeps the account schema through a JSON round trip', async (t) => {
    if (fixture.skip) return t.skip(fixture.skip);
    const raw = await readCasPdf(
      fixtureBytes('CDSL_CAS_FILE_1'), process.env.CDSL_CAS_PASSWORD || '', { output: 'json' },
    );
    const data = JSON.parse(raw);
    assert.equal(data.file_type, 'CDSL');
    assert.equal(data.accounts.length, EXPECTED_ACCOUNTS);
    assert.ok(data.investor_info.name);
  });
});

describe('the command line', () => {
  it('renders the table', async (t) => {
    const file = fixturePath('CDSL_CAS_FILE_1');
    if (!ready || !file) return t.skip('CDSL_CAS_FILE_1 is not set, or pdf.js is absent');

    const { code, output } = await runCli([file, '-p', process.env.CDSL_CAS_PASSWORD || '', '-a']);
    assert.equal(code, 0);
    assert.ok(output.includes('Statement Period :'));
    assert.ok(output.includes('CDSL'));
  });
});
