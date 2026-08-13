/**
 * The NSDL and CDSL helpers, exercising the corner cases the end-to-end fixtures do not
 * reach: decimal edge cases, the joint-name owner block, the roster-row recognisers, the
 * anomalies in a fund holdings row, and the pension section.
 */

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import * as cdsl from '../src/parsers/cdsl.js';
import * as nsdl from '../src/parsers/nsdl.js';
import { Decimal } from '../src/decimal.js';
import {
  SOFT_HYPHEN, cellsFromBlockAtoms, joinColumnAtoms,
} from '../src/parsers/pageobj.js';
import { MemoryIsinDb, batchEquitySymbols, batchIsinMetadata, isinSearch, setIsinProvider } from '../src/isin.js';
import { enrichDematEquities } from '../src/parsers/index.js';
import { FileType } from '../src/enums.js';
import {
  DematAccount, DematOwner, Equity, InvestorInfo, NSDLCASData, StatementPeriod,
} from '../src/types.js';
import { atom, block, cell, clearIsinDb, useSampleIsinDb } from './_helpers.js';

const D = (value) => Decimal.parse(value);
const eq = (actual, expected, message) => assert.ok(
  Decimal.from(actual).eq(D(expected)),
  `${message || ''} expected ${expected}, got ${actual}`,
);

// ------------------------------------------------------------------- decimals

describe('decimal helpers', () => {
  const modules = [['nsdl', nsdl], ['cdsl', cdsl]];

  for (const [name, module] of modules) {
    it(`${name}: null reads as zero`, () => {
      eq(module.toDecimal(null), '0');
    });

    it(`${name}: placeholders read as zero`, () => {
      for (const placeholder of ['', ' ', '-', '--', 'N.A', 'NA']) {
        eq(module.toDecimal(placeholder), '0', placeholder);
      }
    });

    it(`${name}: strips the grouping commas`, () => {
      eq(module.toDecimal('1,23,456.78'), '123456.78');
    });

    it(`${name}: an unreadable value falls back to zero rather than throwing`, () => {
      eq(module.toDecimal('not a number'), '0');
    });

    it(`${name}: the optional form is null on a placeholder`, () => {
      assert.equal(module.optDecimal(null), null);
      assert.equal(module.optDecimal('--'), null);
      assert.equal(module.optDecimal(''), null);
      assert.equal(module.optDecimal('garbage!'), null);
    });

    it(`${name}: the optional form parses a value`, () => {
      eq(module.optDecimal('1,234.5'), '1234.5');
    });
  }
});

// ----------------------------------------------------------------------- CDSL

describe('CDSL helpers', () => {
  it('splits an all-digit identifier', () => {
    assert.deepEqual(cdsl.splitBoId('1111222233334444'), ['CDSL', '11112222', '33334444']);
  });

  it('splits an NSDL-style identifier', () => {
    assert.deepEqual(cdsl.splitBoId('IN12345699998888'), ['NSDL', 'IN123456', '99998888']);
  });

  it('refuses one of the wrong length', () => {
    assert.deepEqual(cdsl.splitBoId('12345'), ['', '', '']);
  });

  it('refuses one it cannot classify', () => {
    assert.deepEqual(cdsl.splitBoId('ABCD123412341234'), ['', '', '']);
  });

  it('normalises an account key', () => {
    assert.deepEqual(cdsl.accountKey('cdsl', ' 11112222 ', '33334444 '),
      ['CDSL', '11112222', '33334444']);
  });

  it('expands the account type', () => {
    assert.equal(cdsl.fullType('cdsl'), 'CDSL Demat Account');
  });

  it('recognises numbers and rejects labels', () => {
    assert.ok(cdsl.looksNumeric('1,234.5'));
    assert.ok(cdsl.looksNumeric('-100'));
    assert.ok(!cdsl.looksNumeric('ARN-0005'));
    assert.ok(!cdsl.looksNumeric('DIRECT'));
    assert.ok(!cdsl.looksNumeric(''));
  });

  it('recognises a fraction printed without its leading zero', () => {
    // A small balance prints as `.196`. Misreading that shifts the whole row silently.
    assert.ok(cdsl.looksNumeric('.196'));
    assert.ok(cdsl.looksNumeric('.69'));
    assert.ok(cdsl.looksNumeric('-.5'));
    assert.ok(cdsl.looksNumeric('0.196'));
    assert.ok(!cdsl.looksNumeric('.'));
    assert.ok(!cdsl.looksNumeric('-'));
  });

  it('recognises a total row', () => {
    assert.ok(cdsl.isTotalRow(block([cell('Sub Total'), cell('100.00')])));
    assert.ok(!cdsl.isTotalRow(block([cell('INE000A01001'), cell('100')])));
  });

  it('tells a column header from a data row', () => {
    assert.ok(cdsl.isHoldingsHeader(block([
      cell('ISIN'), cell('Security'), cell('Current Bal'), cell('Market Price'),
    ])));
    assert.ok(!cdsl.isHoldingsHeader(
      block([cell('INE000A01001'), cell('EXAMPLE COMPANY LIMITED')]),
    ));
  });

  it('refuses a holdings row with no ISIN', () => {
    assert.equal(cdsl.parseHoldingsRow(block([cell('Not an ISIN'), cell('name'), cell('100')])), null);
  });

  it('skips the suspended-issue marker between the ISIN and the name', () => {
    const row = cdsl.parseHoldingsRow(block([
      cell('INE000A01001', 20, 60),
      cell('@', 80, 85),
      cell('EXAMPLE COMPANY LIMITED', 90, 200),
      cell('100', 240, 270),
      cell('--', 300, 320),
      cell('--', 340, 360),
      cell('--', 380, 400),
      cell('100', 440, 460),
      cell('450.50', 500, 540),
      cell('45050.00', 560, 620),
    ]));
    assert.ok(row);
    const [isin, name, shares, price, value] = row;
    assert.equal(isin, 'INE000A01001');
    assert.equal(name, 'EXAMPLE COMPANY LIMITED');
    eq(shares, '100');
    eq(price, '450.50');
    eq(value, '45050.00');
  });

  it('still parses a row whose quantities are all dashes', () => {
    const row = cdsl.parseHoldingsRow(block([
      cell('INE000A01002', 20, 60),
      cell('EXAMPLE RIGHTS ENTITL', 80, 200),
      cell('--', 240, 260),
      cell('--', 300, 320),
      cell('--', 340, 360),
      cell('--', 380, 400),
      cell('--', 440, 460),
      cell('6.29', 500, 540),
      cell('0.00', 560, 620),
    ]));
    assert.ok(row);
    eq(row[2], '0');
    eq(row[3], '6.29');
    eq(row[4], '0');
  });

  it('refuses a row too short to hold the data cells', () => {
    assert.equal(
      cdsl.parseHoldingsRow(block([cell('INE000A01001'), cell('name'), cell('100')])),
      null,
    );
  });

  it('reads the full fund template positionally', () => {
    const fund = cdsl.parseMfHoldingsRow(block([
      cell('EXFND - Example Fund', 22, 90),
      cell('INF000A01001', 192, 230),
      cell('12345', 273, 300),
      cell('ARN-1234', 320, 360),
      cell('100.000', 380, 410),
      cell('25.0000', 430, 460),
      cell('2000.00', 480, 510),
      cell('2500.00', 530, 560),
    ]), new Map());
    assert.ok(fund);
    eq(fund.balance, '100.000');
    eq(fund.nav, '25.0000');
    eq(fund.total_cost, '2000.00');
    eq(fund.value, '2500.00');
  });

  it('reads the reduced template, where the third number is the value not the cost', () => {
    const fund = cdsl.parseMfHoldingsRow(block([
      cell('EXFND - Example Fund', 22, 90),
      cell('INF000A01001', 192, 230),
      cell('12345', 273, 300),
      cell('DIR', 320, 360),
      cell('100.000', 380, 410),
      cell('25.0000', 430, 460),
      cell('2500.00', 530, 560),
    ]), new Map());
    assert.ok(fund);
    eq(fund.balance, '100.000');
    eq(fund.nav, '25.0000');
    eq(fund.value, '2500.00');
    assert.equal(fund.total_cost, null);
  });

  it('splices a folio that wrapped onto the next cell', () => {
    const fund = cdsl.parseMfHoldingsRow(block([
      cell('SPGD - Motilal Oswal S&P 500 Index Fund', 22, 120),
      cell('INF247L01AG2', 192, 230),
      cell('910121125', 273, 300),
      cell('82/0', 305, 325),
      cell('DIRECT', 340, 380),
      cell('20037.345', 400, 430),
      cell('28.3293', 450, 480),
      cell('250504.20', 500, 530),
      cell('567643.96', 550, 580),
    ]), new Map());
    assert.ok(fund);
    assert.equal(fund.folio, '91012112582/0');
    eq(fund.balance, '20037.345');
    eq(fund.nav, '28.3293');
    eq(fund.total_cost, '250504.20');
    eq(fund.value, '567643.96');
    assert.ok(fund.balance.mul(fund.nav).sub(fund.value).abs().lte(D('0.01')));
  });

  it('reads the profit and the return off the tail', () => {
    const fund = cdsl.parseMfHoldingsRow(block([
      cell('EXFND - Example Fund', 22, 90),
      cell('INF000A01001', 192, 230),
      cell('12345', 273, 300),
      cell('DIRECT', 320, 360),
      cell('100.000', 380, 410),
      cell('25.0000', 430, 460),
      cell('2000.00', 480, 510),
      cell('2500.00', 530, 560),
      cell('0.10', 570, 590),
      cell('0', 600, 620),
      cell('500.00', 630, 650),
      cell('25.00', 660, 680),
    ]), new Map());
    assert.ok(fund);
    eq(fund.pnl, '500.00');
    eq(fund.return_, '25.00');
  });

  it('keeps a lone return percentage out of the profit field', () => {
    const fund = cdsl.parseMfHoldingsRow(block([
      cell('32Z - Aditya Birla Sun Life Corporate Bond Fund - ', 21.5, 90),
      cell('INF209K01S38', 112.3, 230),
      cell('1040936382', 167.2, 300),
      cell('DIRECT', 219.0, 360),
      cell('ARN', 222.8, 380),
      cell('11.343', 269.4, 410),
      cell('95.6053', 299.6, 460),
      cell('1,000.00', 348.1, 510),
      cell('1,084.45', 398.1, 560),
      cell('0', 469.1, 590),
      cell('.31', 507.9, 620),
      cell('0', 574.1, 650),
    ]), new Map());
    assert.ok(fund);
    eq(fund.value, '1084.45');
    eq(fund.total_cost, '1000.00');
    assert.equal(fund.pnl, null);
    eq(fund.return_, '0.31');
  });
});

// ----------------------------------------------------------------------- NSDL

describe('NSDL helpers', () => {
  it('expands the account type', () => {
    assert.equal(nsdl.fullType('cdsl'), 'CDSL Demat Account');
    assert.equal(nsdl.fullType('nsdl'), 'NSDL Demat Account');
  });

  it('normalises an account key', () => {
    assert.deepEqual(nsdl.accountKey('nsdl', ' IN301151 ', ' 12241815 '),
      ['NSDL', 'IN301151', '12241815']);
  });

  it('recognises a total row', () => {
    assert.ok(nsdl.isTotalRow(block([cell('Sub Total'), cell('100')])));
    assert.ok(nsdl.isTotalRow(block([cell('Grand Total'), cell('1,00,000')])));
    assert.ok(!nsdl.isTotalRow(block([cell('INE000A01001')])));
  });

  it('recognises the section markers, supported or not', () => {
    assert.equal(nsdl.sectionMarkerKind(block([cell('Equity Shares')])), 'equities');
    assert.equal(nsdl.sectionMarkerKind(block([cell('Mutual Funds (M)')])), 'mfunds');
    assert.equal(nsdl.sectionMarkerKind(block([cell('Corporate Bonds (C)')])), 'bonds');
    // An unsupported one is still a marker, so the rows under it are not misrouted.
    assert.equal(nsdl.sectionMarkerKind(block([cell('Preference Shares (P)')])), 'unsupported');
    assert.equal(
      nsdl.sectionMarkerKind(block([cell('Equity Shares'), cell('A'), cell('B')])),
      null,
    );
    assert.equal(nsdl.sectionMarkerKind(block([cell('Random Caption')])), null);
  });

  it('reads the table mode off a column header', () => {
    const fundHoldings = block([
      cell('ISIN'), cell('ISIN Description'), cell('Folio No.'), cell('No. of Units'),
      cell('Average'), cell('Total Cost'),
    ]);
    assert.equal(nsdl.detectModeFromHeader(fundHoldings), 'mf_holdings');

    const detailed = block([
      cell('ISIN'), cell('Security'), cell('Current Bal'), cell('Market Price'),
      cell('Value in'),
    ]);
    assert.equal(nsdl.detectModeFromHeader(detailed), 'equities_detailed');
    assert.equal(nsdl.detectModeFromHeader(detailed, 'bonds'), 'bonds_detailed');
    assert.equal(nsdl.detectModeFromHeader(detailed, 'mfunds'), 'mfunds_detailed');

    const bondSummary = block([
      cell('ISIN'), cell('Company Name'), cell('Coupon Rate'), cell('Frequency'),
      cell('Maturity Date'), cell('Face Value'),
    ]);
    assert.equal(nsdl.detectModeFromHeader(bondSummary), 'bonds_summary');

    assert.equal(
      nsdl.detectModeFromHeader(block([cell('Stock Symbol'), cell('ISIN'), cell('Company Name')])),
      'equities_summary',
    );
    assert.equal(
      nsdl.detectModeFromHeader(block([cell('ISIN'), cell('ISIN Description'), cell('NAV')])),
      'mfunds_summary',
    );
    assert.equal(
      nsdl.detectModeFromHeader(block([cell('INE000A01001'), cell('Some Stock')])),
      null,
    );
    assert.equal(nsdl.detectModeFromHeader(block([cell('Foo'), cell('Bar')])), null);
  });

  it('tells a table header from a data row', () => {
    assert.ok(nsdl.isTableHeader(block([
      cell('ISIN Description    No. of\nUnits    Stock Symbol    Market Price    Value in'),
    ])));
    assert.ok(!nsdl.isTableHeader(block([cell('INE000A01001 some stock')])));
  });

  it('reads a summary equity row from its last three numbers', () => {
    const equity = nsdl.parseEquityRow(block([
      cell('INE000A01001\nEXAMPLECO.NSE'),
      cell('EXAMPLE COMPANY LIMITED'),
      cell('1.00'),
      cell('100'),
      cell('450.50'),
      cell('45,050.00'),
    ]), false);
    assert.ok(equity);
    assert.equal(equity.isin, 'INE000A01001');
    eq(equity.num_shares, '100');
    eq(equity.price, '450.50');
    eq(equity.value, '45050.00');
  });

  it('reads a detailed equity row, quantity first', () => {
    const equity = nsdl.parseEquityRow(block([
      cell('INE000A01001'), cell('EXAMPLE COMPANY LIMITED'),
      cell('100'), cell('100'), cell('0'), cell('0'), cell('0'), cell('0'),
      cell('0'), cell('0'), cell('0'), cell('450.50'), cell('45,050.00'),
    ]), true);
    assert.ok(equity);
    eq(equity.num_shares, '100');
    eq(equity.price, '450.50');
    eq(equity.value, '45050.00');
  });

  it('picks the quantity that closes the arithmetic on a pledged row', () => {
    const equity = nsdl.parseEquityRow(block([
      cell('INE552Z01027\nABDL.NSE'),
      cell('ALLIED BLENDERS AND DISTILLERS LIMITED'),
      cell('2.00'),
      cell('300'),
      cell('300'),
      cell('558.30'),
      cell('1,67,490.00'),
    ]), false);
    assert.ok(equity);
    eq(equity.num_shares, '300');
    eq(equity.price, '558.30');
    eq(equity.value, '167490.00');
  });

  it('refuses an equity row with no ISIN or too few numbers', () => {
    assert.equal(nsdl.parseEquityRow(block([
      cell('not-an-isin'), cell('name'), cell('1'), cell('2'), cell('3'),
    ])), null);
    assert.equal(nsdl.parseEquityRow(block([
      cell('INE000A01001'), cell('name'), cell('1'), cell('2'),
    ])), null);
  });

  it('reads a summary fund row', () => {
    const fund = nsdl.parseSummaryMfRow(block([
      cell('INF000A01002'),
      cell('NIPPON INDIA ETF LIQUID BeES'),
      cell('100.001'),
      cell('1000.00'),
      cell('100,000.00'),
    ]));
    assert.ok(fund);
    assert.equal(fund.isin, 'INF000A01002');
    eq(fund.balance, '100.001');
    eq(fund.value, '100000.00');
  });

  it('refuses a fund row with no ISIN', () => {
    assert.equal(nsdl.parseSummaryMfRow(block([cell('not-an-isin'), cell('name')])), null);
  });

  it('picks the balance that closes the arithmetic on a pledged fund row', () => {
    const fund = nsdl.parseSummaryMfRow(block([
      cell('INF846K016E3'),
      cell('AXIS MULTICAP FUND-REGULAR PLAN GROWTH'),
      cell('5,628.000'),
      cell('7,589.734'),
      cell('18.20'),
      cell('1,38,133.15'),
    ]));
    assert.ok(fund);
    eq(fund.balance, '7589.734');
    eq(fund.nav, '18.20');
    eq(fund.value, '138133.15');
  });

  it('chooses the closing balance from several candidates', () => {
    const nav = D('18.20');
    const value = D('138133.15');
    eq(nsdl.pickBalanceClosing([D('5628.000'), D('7589.734')], nav, value), '7589.734');
    eq(nsdl.pickBalanceClosing([D('100.001')], nav, value), '100.001');
    eq(nsdl.pickBalanceClosing([D('10'), D('20')], D('0'), D('0')), '20');
    eq(nsdl.pickBalanceClosing([], nav, value), '0');
  });

  it('folds a misplaced client code out of the numbers', () => {
    const fund = nsdl.parseMfHoldingsRow(block([
      cell('INF000A01003\nNOT AVAILABLE', 20.0, 75.0),
      cell('ICICI Prudential\nCorporate Bond', 80.0, 145.0),
      cell('26777337', 167.0, 198.0),
      cell('89,935.20', 204.0, 235.0),
      cell('8', 231.9, 235.2),
      cell('27.7978', 280.0, 305.0),
      cell('25,00,000.00', 320.0, 360.0),
      cell('29.3146', 393.0, 418.0),
      cell('26,36,414.65', 433.0, 473.0),
      cell('1,36,414.65', 486.0, 522.0),
      cell('8.61', 561.0, 574.0),
    ]));
    assert.ok(fund);
    assert.equal(fund.isin, 'INF000A01003');
    assert.equal(fund.folio, '26777337');
    eq(fund.balance, '89935.20');
    assert.equal(fund.ucc, '8');
    eq(fund.nav, '29.3146');
    eq(fund.value, '2636414.65');
    eq(fund.pnl, '136414.65');
    eq(fund.return_, '8.61');
  });

  it('reads the same row shifted right', () => {
    const fund = nsdl.parseMfHoldingsRow(block([
      cell('INF000A01003\nNOT AVAILABLE', 20.0, 75.0),
      cell('ICICI Prudential\nCorporate Bond', 80.0, 145.0),
      cell('26777337', 167.0, 198.0),
      cell('89,935.20', 204.0, 235.0),
      cell('8', 231.9, 235.2),
      cell('27.7978', 313.0, 338.0),
      cell('25,00,000.00', 353.0, 393.0),
      cell('29.3146', 426.0, 451.0),
      cell('26,36,414.65', 484.0, 524.0),
      cell('1,36,414.65', 555.0, 591.0),
      cell('8.61', 630.0, 643.0),
    ]));
    assert.ok(fund);
    eq(fund.nav, '29.3146');
    eq(fund.value, '2636414.65');
    eq(fund.pnl, '136414.65');
    eq(fund.return_, '8.61');
  });

  it('reads a row with no cost columns at all', () => {
    const fund = nsdl.parseMfHoldingsRow(block([
      cell('INF000A01004', 20.0, 75.0),
      cell('Liquid Fund', 80.0, 145.0),
      cell('12345678', 167.0, 198.0),
      cell('100.001', 204.0, 235.0),
      cell('1000.00', 393.0, 418.0),
      cell('100,000.00', 433.0, 473.0),
    ]));
    assert.ok(fund);
    eq(fund.balance, '100.001');
    eq(fund.nav, '1000.00');
    eq(fund.value, '100000.00');
    assert.equal(fund.avg_cost, null);
    assert.equal(fund.total_cost, null);
    assert.equal(fund.pnl, null);
    assert.equal(fund.return_, null);
  });

  it('reads a tail that ends with the profit and no percentage', () => {
    const fund = nsdl.parseMfHoldingsRow(block([
      cell('INF2JJD01169', 20.0, 75.0),
      cell('Some Scheme', 80.0, 145.0),
      cell('6653121493', 167.0, 198.0),
      cell('194.410', 204.0, 235.0),
      cell('10.2875', 280.0, 305.0),
      cell('2000', 320.0, 360.0),
      cell('10.2280', 393.0, 418.0),
      cell('1988.43', 433.0, 473.0),
      cell('-11.57', 486.0, 522.0),
    ]));
    assert.ok(fund);
    eq(fund.nav, '10.2280');
    eq(fund.value, '1988.43');
    eq(fund.total_cost, '2000');
    eq(fund.pnl, '-11.57');
    assert.equal(fund.return_, null);
  });

  it('keeps a value that sits just below its cost', () => {
    const fund = nsdl.parseMfHoldingsRow(block([
      cell('INF2JJD01169', 20.0, 75.0),
      cell('Near Par Fund', 80.0, 145.0),
      cell('6653121493', 167.0, 198.0),
      cell('194.410', 204.0, 235.0),
      cell('10.2875', 280.0, 305.0),
      cell('2000', 320.0, 360.0),
      cell('10.2280', 393.0, 418.0),
      cell('1988.43', 433.0, 473.0),
    ]));
    assert.ok(fund);
    eq(fund.value, '1988.43');
    eq(fund.total_cost, '2000');
  });

  it('reads a real near-par row', () => {
    const fund = nsdl.parseMfHoldingsRow(block([
      cell('INF090I01WX1\nFIMCFGP', 20.6, 75.0),
      cell('Franklin India Multi\nCap Fund - Growth', 82.3, 145.0),
      cell('34463878', 165.3, 198.0),
      cell('999.950', 236.3, 235.0),
      cell('10.0005', 298.9, 305.0),
      cell('10,000.00', 361.1, 360.0),
      cell('10.2603', 426.2, 451.0),
      cell('10,259.79', 482.5, 524.0),
      cell('259.79', 553.8, 574.0),
    ]));
    assert.ok(fund);
    eq(fund.balance, '999.950');
    eq(fund.nav, '10.2603');
    eq(fund.value, '10259.79');
    eq(fund.total_cost, '10000.00');
    eq(fund.pnl, '259.79');
    assert.equal(fund.return_, null);
  });

  it('does not let a truncated copy of the value become the value', () => {
    const fund = nsdl.parseMfHoldingsRow(block([
      cell('INF179K01CR2\nMFHDFC0078', 20.5, 75.0),
      cell('HDFC Mid Cap\nFund - Regular Plan\n- Growth', 82.2, 145.0),
      cell('31627597', 165.3, 198.0),
      cell('300.762', 236.3, 235.0),
      cell('199.4933', 297.0, 305.0),
      cell('60,000.00', 360.6, 360.0),
      cell('199.8970', 424.3, 451.0),
      cell('60,121.42', 482.0, 524.0),
      cell('121.42', 554.4, 574.0),
    ]));
    assert.ok(fund);
    eq(fund.nav, '199.8970');
    eq(fund.value, '60121.42');
    eq(fund.pnl, '121.42');
  });

  it('ignores a spurious cost pair to the left of the real numbers', () => {
    const fund = nsdl.parseMfHoldingsRow(block([
      cell('INF194KB1AJ8\nNOT AVAILABLE', 20.5, 75.0),
      cell('Bandhan Small Cap\nFund-Regular Plan Growth', 82.3, 145.0),
      cell('8841793', 167.2, 198.0),
      cell('62.931', 240.1, 235.0),
      cell('47.6713', 298.3, 305.0),
      cell('3,000.00', 362.6, 360.0),
      cell('47.9400', 425.6, 451.0),
      cell('3,016.91', 484.0, 524.0),
      cell('16.91', 558.3, 574.0),
    ]));
    assert.ok(fund);
    eq(fund.balance, '62.931');
    eq(fund.nav, '47.9400');
    eq(fund.value, '3016.91');
    eq(fund.pnl, '16.91');
  });

  it('keeps the full amount when a truncated copy sits beside it', () => {
    const fund = nsdl.parseMfHoldingsRow(block([
      cell('INF740KA1RB9', 20.0, 75.0),
      cell('Lakh Fragment Fund', 80.0, 145.0),
      cell('12345678', 167.0, 198.0),
      cell('13,619.00', 204.0, 235.0),
      cell('100.00', 280.0, 305.0),
      cell('13,619.00', 320.0, 360.0),
      cell('152.70', 393.0, 418.0),
      cell('20,77,622.00', 433.0, 473.0),
      cell('77,622.00', 492.0, 522.0),
      cell('258.00', 557.0, 574.0),
      cell('7.49', 600.0, 613.0),
    ]));
    assert.ok(fund);
    eq(fund.value, '2077622.00');
    eq(fund.pnl, '258.00');
    eq(fund.return_, '7.49');
  });

  it('ignores a zero placeholder in the return column', () => {
    const fund = nsdl.parseMfHoldingsRow(block([
      cell('INF000A01005', 20.0, 75.0),
      cell('Zero Return Fund', 80.0, 145.0),
      cell('12345678', 167.0, 198.0),
      cell('100', 204.0, 235.0),
      cell('10', 280.0, 305.0),
      cell('1000', 320.0, 360.0),
      cell('11', 393.0, 418.0),
      cell('1100', 433.0, 473.0),
      cell('100', 486.0, 522.0),
      cell('0.000', 561.0, 574.0),
    ]));
    assert.ok(fund);
    eq(fund.pnl, '100');
    assert.equal(fund.return_, null);
  });

  it('refuses a holdings row with no ISIN', () => {
    assert.equal(nsdl.parseMfHoldingsRow(block([cell('not-an-isin', 20.0, 75.0)])), null);
  });

  it('every row reader refuses an empty block', () => {
    const empty = block([]);
    assert.equal(nsdl.parseEquityRow(empty), null);
    assert.equal(nsdl.parseSummaryMfRow(empty), null);
    assert.equal(nsdl.parseMfHoldingsRow(empty), null);
    assert.equal(cdsl.parseHoldingsRow(empty), null);
    assert.equal(cdsl.parseMfHoldingsRow(empty, new Map()), null);
  });

  it('refuses a summary fund row with too few numbers', () => {
    assert.equal(nsdl.parseSummaryMfRow(block([
      cell('INF000A01002'), cell('Some Fund'), cell('1'), cell('2'),
    ])), null);
  });

  it('reports no period when no block carries one', () => {
    const blocks = [block([cell('nothing about a period here')])];
    assert.equal(nsdl.findPeriod(blocks), null);
    assert.equal(cdsl.findPeriod(blocks), null);
  });

  it('rejects empty text as numeric in both readers', () => {
    for (const fn of [nsdl.looksNumeric, cdsl.looksNumeric]) {
      assert.ok(!fn(''));
      assert.ok(!fn('   '));
      assert.ok(fn('.196'));
      assert.ok(fn('-.5'));
      assert.ok(!fn('.'));
    }
  });

  it('resolves a joint-name section header spread over three blocks', () => {
    const blocks = [
      block([cell('NSDL Demat Account'), cell('ACCOUNT HOLDERS')], 11),
      block([cell('ACME BROKER LIMITED'), cell('Holder One (PAN:ABCDE1234F)')], 11),
      block([cell('DP ID: IN123456 Client ID: 99998888'), cell('Holder Two (PAN:GHIJK5678L)')], 11),
    ];
    const [key, consumed] = nsdl.tryPerAccountHeader(blocks, 0);
    assert.deepEqual(key, ['NSDL', 'IN123456', '99998888']);
    assert.equal(consumed, 3);
  });

  it('gives up when no identifiers follow the header', () => {
    const blocks = [
      block([cell('NSDL Demat Account')], 11),
      block([cell('Random unrelated text')], 11),
      block([cell('Another random line')], 11),
    ];
    const [key, consumed] = nsdl.tryPerAccountHeader(blocks, 0);
    assert.equal(key, null);
    assert.equal(consumed, 1);
  });

  it('ignores a block that is not a section header at all', () => {
    const [key, consumed] = nsdl.tryPerAccountHeader([block([cell('Just some text')], 3)], 0);
    assert.equal(key, null);
    assert.equal(consumed, 1);
  });

  it('reads the four-cell roster row', () => {
    const row = block([
      cell('NSDL Demat Account'),
      cell('ACME BROKER LIMITED\nDP ID: IN123456 Client ID: 99998888'),
      cell('12'),
      cell('1,04,00,929.50'),
    ], 2);
    assert.ok(nsdl.isSummaryDematRow(row));
    const [account, key] = nsdl.accountFromSummaryRow(row, []);
    assert.deepEqual(key, ['NSDL', 'IN123456', '99998888']);
    assert.equal(account.name, 'ACME BROKER LIMITED');
    assert.equal(account.dp_id, 'IN123456');
    assert.equal(account.client_id, '99998888');
    assert.equal(account.folios, 12);
    eq(account.balance, '10400929.50');
  });

  it('reads the five-cell roster row', () => {
    const row = block([
      cell('CDSL Demat Account'),
      cell('BETA BROKER LIMITED'),
      cell('DP ID:11112222 Client ID:33334444'),
      cell('25'),
      cell('97,34,823.11'),
    ], 2);
    assert.ok(nsdl.isSummaryDematRow(row));
    const [account, key] = nsdl.accountFromSummaryRow(row, []);
    assert.deepEqual(key, ['CDSL', '11112222', '33334444']);
    assert.equal(account.name, 'BETA BROKER LIMITED');
    assert.equal(account.folios, 25);
    eq(account.balance, '9734823.11');
  });

  it('refuses a roster row with the wrong cell count', () => {
    assert.ok(!nsdl.isSummaryDematRow(block([
      cell('NSDL Demat Account'),
      cell('BROKER\nDP ID: IN123456 Client ID: 99998888'),
      cell('12'),
    ], 2)));
  });

  it('reads a summary bond row, telling the frequency from the rate', () => {
    const bond = nsdl.parseBondSummaryRow(block([
      cell('INE000A07001', 20.7, 67.1),
      cell('EXAMPLE BOND\nISSUER\nLIMITED', 93.2, 168.2),
      cell('Once a year', 185.8, 223.7),
      cell('8.10', 198.0, 211.0),
      cell('05-Mar-2022', 250.9, 290.3),
      cell('200', 354.3, 365.4),
      cell('1,000.00', 442.6, 468.7),
      cell('2,00,000.00', 538.2, 574.7),
    ]));
    assert.ok(bond);
    assert.equal(bond.isin, 'INE000A07001');
    assert.equal(bond.name, 'EXAMPLE BOND ISSUER LIMITED');
    eq(bond.coupon_rate, '8.10');
    assert.equal(bond.coupon_frequency, 'Once a year');
    assert.equal(bond.maturity_date, '05-Mar-2022');
    eq(bond.num_bonds, '200');
    eq(bond.face_value, '1000.00');
    eq(bond.value, '200000.00');
    assert.equal(bond.market_price, null);
  });

  it('refuses a bond row with no ISIN, or none at all', () => {
    assert.equal(nsdl.parseBondSummaryRow(block([cell('Not an ISIN'), cell('...')])), null);
    assert.equal(nsdl.parseBondSummaryRow(block([])), null);
  });

  it('reads a detailed bond row', () => {
    const bond = nsdl.parseBondDetailedRow(block([
      cell('INE000A07002'),
      cell('EXAMPLE BOND ISSUER LIMITED 8.71% NCD'),
      cell('100.000'), cell('100.000'), cell('0.000'), cell('0.000'), cell('0.000'),
      cell('0.000'), cell('0.000'), cell('0.000'), cell('0.000'),
      cell('1,276.47'), cell('1,27,647.00'),
    ]));
    assert.ok(bond);
    assert.equal(bond.isin, 'INE000A07002');
    eq(bond.num_bonds, '100.000');
    eq(bond.market_price, '1276.47');
    eq(bond.value, '127647.00');
    assert.equal(bond.coupon_rate, null);
    assert.equal(bond.face_value, null);
    assert.equal(bond.maturity_date, null);
  });

  it('refuses a detailed bond row with no ISIN', () => {
    assert.equal(nsdl.parseBondDetailedRow(block([cell('Subtotal'), cell('...')])), null);
  });

  it('reads a detailed fund row', () => {
    const fund = nsdl.parseDetailedMfRow(block([
      cell('INF000A01001'), cell('EXAMPLE FUND HOUSE'),
      cell('22,994.003'), cell('22,994.003'), cell('0.000'), cell('0.000'), cell('0.000'),
      cell('0.000'), cell('0.000'), cell('0.000'), cell('0.000'),
      cell('22.55'), cell('5,18,399.80'),
    ]));
    assert.ok(fund);
    assert.equal(fund.isin, 'INF000A01001');
    eq(fund.balance, '22994.003');
    eq(fund.nav, '22.55');
    eq(fund.value, '518399.80');
  });

  it('does not read an equity row as a detailed fund row', () => {
    assert.equal(nsdl.parseDetailedMfRow(block([
      cell('INE000A07002'), cell('Some equity'), cell('100'), cell('1000'), cell('100000'),
    ])), null);
  });
});

// ------------------------------------------------------------ reference lookups

describe('reference lookups', () => {
  before(() => useSampleIsinDb());
  after(() => clearIsinDb());

  it('falls back to the ISIN when the name and code miss', () => {
    const [isin, amfi, type] = isinSearch(
      "scheme name doesn't matter", 'BAD_RTA', 'bogus_code', 'INF846K01EW2',
    );
    assert.equal(isin, 'INF846K01EW2');
    assert.equal(amfi, '120503');
    assert.equal(type, 'EQUITY');
  });

  it('returns nothing for an ISIN it does not know', () => {
    const [isin, amfi, type] = isinSearch('', 'BAD', 'bogus', 'INF000X00X00');
    assert.equal(isin, null);
    assert.equal(amfi, null);
    assert.equal(type, null);
  });

  it('resolves a batch, ignoring duplicates and blanks', () => {
    const metadata = batchIsinMetadata(['INF846K01EW2', 'INF846K01EW2', '', 'INF174V01317']);
    assert.deepEqual(metadata.get('INF846K01EW2'), ['120503', 'EQUITY']);
    assert.deepEqual(metadata.get('INF174V01317'), ['141224', 'EQUITY']);
  });

  it('maps an unknown ISIN to nothing rather than omitting it', () => {
    assert.deepEqual(batchIsinMetadata(['INF000X00X00']).get('INF000X00X00'), [null, null]);
  });

  it('returns an empty map for empty input', () => {
    assert.equal(batchIsinMetadata([]).size, 0);
    assert.equal(batchIsinMetadata(['', null]).size, 0);
  });
});

describe('equity symbols', () => {
  const withSymbols = () => setIsinProvider(new MemoryIsinDb([
    {
      isin: 'INE002A01018',
      name: 'Reliance',
      issuer: 'RIL',
      type: 'EQUITY SHARES',
      status: 'ACTIVE',
      symbol: 'RELIANCE',
      exchange: 'NSE',
    },
    // A bond with no listed symbol must not appear in the map.
    {
      isin: 'INE111A07011',
      name: 'Some SGB',
      issuer: 'RBI',
      type: 'SOVEREIGN GOLD BOND',
      status: 'ACTIVE',
      symbol: null,
      exchange: null,
    },
  ]));

  after(() => clearIsinDb());

  it('resolves the symbols it knows', () => {
    withSymbols();
    const out = batchEquitySymbols(['INE002A01018', 'INE002A01018', '', 'INE111A07011']);
    assert.deepEqual(out.get('INE002A01018'), ['RELIANCE', 'NSE']);
    assert.ok(!out.has('INE111A07011'));
  });

  it('leaves out an ISIN it does not know', () => {
    withSymbols();
    assert.equal(batchEquitySymbols(['INE000X00X00']).size, 0);
  });

  it('degrades quietly when no provider is registered', () => {
    clearIsinDb();
    assert.equal(batchEquitySymbols(['INE002A01018']).size, 0);
  });

  it('returns an empty map for empty input', () => {
    withSymbols();
    assert.equal(batchEquitySymbols([]).size, 0);
    assert.equal(batchEquitySymbols(['', null]).size, 0);
  });
});

describe('equity model', () => {
  it('defaults the symbol fields and still parses the amounts', () => {
    const equity = new Equity({
      isin: 'INE002A01018', num_shares: '1,000', price: '1,234.50', value: '12,34,500',
    });
    assert.equal(equity.symbol, null);
    assert.equal(equity.exchange, null);
    eq(equity.num_shares, '1000');
    eq(equity.price, '1234.50');
  });

  it('accepts a symbol without upsetting the amounts', () => {
    const equity = new Equity({
      isin: 'INE002A01018', num_shares: '5', price: '10', value: '50',
      symbol: 'RELIANCE', exchange: 'NSE',
    });
    assert.equal(equity.symbol, 'RELIANCE');
    assert.equal(equity.exchange, 'NSE');
  });
});

describe('enrichment', () => {
  after(() => clearIsinDb());

  it('fills in an equity symbol and leaves an unknown one alone', () => {
    setIsinProvider(new MemoryIsinDb([{
      isin: 'INE002A01018',
      name: 'Reliance',
      issuer: 'RIL',
      type: 'EQUITY SHARES',
      status: 'ACTIVE',
      symbol: 'RELIANCE',
      exchange: 'NSE',
    }]));

    const data = new NSDLCASData({
      accounts: [new DematAccount({
        name: 'ACME Demat',
        type: 'NSDL',
        folios: 1,
        balance: D('100'),
        owners: [new DematOwner({ name: 'A B', PAN: 'ABCDE1234F' })],
        equities: [
          new Equity({ isin: 'INE002A01018', num_shares: '10', price: '10', value: '100' }),
          new Equity({ isin: 'INE000X00X00', num_shares: '5', price: '2', value: '10' }),
        ],
        mutual_funds: [],
      })],
      statement_period: new StatementPeriod({ from: '2026-01-01', to: '2026-03-31' }),
      investor_info: new InvestorInfo({
        name: 'A B', email: 'a@b.com', address: 'x', mobile: '9',
      }),
      file_type: FileType.NSDL,
    });

    const out = enrichDematEquities(data);
    const byIsin = new Map(out.accounts[0].equities.map((e) => [e.isin, e]));
    assert.equal(byIsin.get('INE002A01018').symbol, 'RELIANCE');
    assert.equal(byIsin.get('INE002A01018').exchange, 'NSE');
    assert.equal(byIsin.get('INE000X00X00').symbol, null);
  });
});

// ------------------------------------------------------------------ soft hyphen

describe('soft hyphen', () => {
  it('normalises one embedded in a single fragment', () => {
    const out = joinColumnAtoms([atom(`INF179K01${SOFT_HYPHEN}WN9`)]);
    assert.equal(out, 'INF179K01WN9');
    assert.ok(cdsl.INF_ISIN_RE.test(out));
  });

  it('splices a token that wrapped across two fragments', () => {
    const out = joinColumnAtoms([
      atom(`INF179K01${SOFT_HYPHEN}`, 100, 200, 500, 492),
      atom('WN9', 100, 200, 491, 483),
    ]);
    assert.equal(out, 'INF179K01WN9');
    assert.ok(cdsl.INF_ISIN_RE.test(out));
  });

  it('leaves a genuine multi-line cell alone', () => {
    const out = joinColumnAtoms([
      atom('HDFC Small Cap Fund -', 100, 200, 500, 492),
      atom('Direct Growth Plan', 100, 200, 491, 483),
    ]);
    assert.equal(out, 'HDFC Small Cap Fund -\nDirect Growth Plan');
  });

  it('handles a token wrapped across three fragments', () => {
    assert.equal(joinColumnAtoms([
      atom(`INF179${SOFT_HYPHEN}`), atom(`K01${SOFT_HYPHEN}`), atom('WN9'),
    ]), 'INF179K01WN9');
  });

  it('reconstructs the token through the cell builder', () => {
    const cells = cellsFromBlockAtoms([
      atom(`INF179K01${SOFT_HYPHEN}`, 100, 200, 500, 492),
      atom('WN9', 100, 180, 491, 483),
    ]);
    assert.equal(cells.length, 1);
    assert.equal(cells[0].text, 'INF179K01WN9');
    assert.ok(cdsl.INF_ISIN_RE.test(cells[0].text));
  });
});

// ------------------------------------------------------------------------- NPS

describe('pension holdings', () => {
  /** One scheme, spread the way the real layout spreads it. */
  const schemeBlocks = (asset, tier, units, nav, y) => [
    block([
      cell('NPS TRUST- A/C HDFC PENSION FUND', 223, 2000, y, y - 40),
      cell('HDFC PENSION FUND MANAGEMENT', 2223, 3800, y, y - 40),
    ]),
    block([
      cell(units, 4379, 5100, y - 45, y - 85),
      cell(nav, 5457, 5900, y - 45, y - 85),
    ]),
    block([
      cell(`MANAGEMENT LIMITED SCHEME ${asset} - TIER ${tier}`, 223, 2000, y - 90, y - 130),
      cell('LIMITED', 2223, 3000, y - 90, y - 130),
    ]),
  ];

  const npsBlocks = () => {
    const blocks = [
      block([cell('NPS-SP : PROT PRAN ID : 110099887766', 205, 4000, 7000, 6960)]),
      block([cell(
        'STATEMENT OF TRANSACTIONS FOR THE PERIOD FROM 01-04-2025 TO 31-03-2026',
        1048, 5000, 6800, 6760,
      )]),
      // A transaction row that mentions the scheme must not become a holding.
      block([
        cell('02-Feb-2026', 218, 700, 6700, 6660),
        cell(
          'NPS TRUST- A/C HDFC PENSION FUND MANAGEMENT LIMITED SCHEME G - TIER I',
          829, 2000, 6700, 6660,
        ),
        cell('CR', 3551, 3700, 6700, 6660),
        cell('17,828.64', 4177, 4600, 6700, 6660),
      ]),
      block([cell('HOLDING STATEMENT AS ON 31-03-2026', 2044, 4000, 6392, 6352)]),
    ];
    blocks.push(...schemeBlocks('G', 'I', '45,982.3138', '27.6140', 6137));
    blocks.push(...schemeBlocks('E', 'I', '12,000.0000', '50.0000', 5900));
    blocks.push(block([
      cell('Portfolio Value ` 8,69,755.61 as on 31-03-2026', 239, 3000, 5433, 5393),
    ]));
    return blocks;
  };

  it('reads the holdings and skips the transaction row', () => {
    const nps = cdsl.parseNps(npsBlocks());
    assert.ok(nps);
    assert.equal(nps.nps_sp, 'PROT');
    assert.equal(nps.pran, '110099887766');
    eq(nps.value, '869755.61');
    assert.equal(nps.schemes.length, 2);

    const [g, e] = nps.schemes;
    assert.equal(g.asset_class, 'G');
    assert.equal(g.tier, 'I');
    eq(g.units, '45982.3138');
    eq(g.nav, '27.6140');
    eq(g.value, '1269755.61');
    assert.equal(g.fund_manager, 'HDFC PENSION FUND MANAGEMENT LIMITED');
    assert.equal(e.asset_class, 'E');
    eq(e.value, '600000.00');
  });

  it('skips a scheme whose numbers were redacted', () => {
    const nps = cdsl.parseNps([
      block([cell('HOLDING STATEMENT AS ON 31-03-2026', 2044, 4000, 6392, 6352)]),
      block([
        cell('NPS TRUST- A/C HDFC PENSION FUND', 223, 2000, 6137, 6097),
        cell('HDFC PENSION FUND MANAGEMENT', 2223, 3800, 6137, 6097),
      ]),
      block([cell('MANAGEMENT LIMITED SCHEME C - TIER I', 223, 2000, 6046, 6006)]),
      block([cell('Portfolio Value ` 5,00,000.00 as on 31-03-2026', 239, 3000, 5433, 5393)]),
    ]);
    assert.ok(nps);
    eq(nps.value, '500000.00');
    assert.deepEqual(nps.schemes, []);
  });

  it('reports nothing when the statement has no pension section', () => {
    assert.equal(cdsl.parseNps([
      block([cell('HOLDING STATEMENT AS ON 31-03-2026', 2044, 4000, 100, 60)]),
      block([cell('INE000A01001', 20, 75, 50, 10), cell('SOME EQUITY', 80, 200, 50, 10)]),
    ]), null);
  });

  it('keeps page furniture out of a scheme that straddles a page break', () => {
    const nps = cdsl.parseNps([
      block([cell('HOLDING STATEMENT AS ON 31-05-2026', 2044, 4000, 700, 660)]),
      block([
        cell('NPS TRUST A/C HDFC PENSION FUND', 200, 900, 600, 560),
        cell('HDFC PENSION FUND MANAGEMENT', 1000, 1800, 600, 560),
      ]),
      block([
        cell('45,982.3138', 4000, 4600, 555, 515),
        cell('27.6140', 5000, 5400, 555, 515),
      ]),
      block([cell('Central Depository Services (India) Limited', 2000, 3500, 550, 510)]),
      block([cell(
        'CONSOLIDATED ACCOUNT STATEMENT (CAS) FOR SECURITIES HELD IN DEMAT',
        800, 4000, 540, 500,
      )]),
      block([cell('VINEET MENON', 250, 900, 530, 490)]),
      block([
        cell('Scheme Name', 800, 1500, 520, 480),
        cell('Fund Manager', 2000, 2800, 520, 480),
      ]),
      block([cell('Page 18 of 21', 500, 900, 510, 470)]),
      block([
        cell('MANAGEMENT LIMITED SCHEME G - TIER I GS', 200, 900, 500, 460),
        cell('LIMITED', 1000, 1400, 500, 460),
      ]),
      block([cell('Portfolio Value ` 12,69,755.61 as on 31-05-2026', 239, 3000, 440, 400)]),
    ]);
    assert.ok(nps);
    assert.equal(nps.schemes.length, 1);
    const scheme = nps.schemes[0];
    assert.equal(
      scheme.scheme,
      'NPS TRUST A/C HDFC PENSION FUND MANAGEMENT LIMITED SCHEME G - TIER I GS',
    );
    assert.equal(scheme.fund_manager, 'HDFC PENSION FUND MANAGEMENT LIMITED');
    assert.equal(scheme.asset_class, 'G');
    assert.equal(scheme.tier, 'I');
    eq(scheme.units, '45982.3138');
    eq(scheme.nav, '27.6140');
    for (const junk of ['VINEET', 'Central', 'Page', 'CONSOLIDATED', 'Scheme Name']) {
      assert.ok(!scheme.scheme.includes(junk), junk);
    }
  });
});
