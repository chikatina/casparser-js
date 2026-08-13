/**
 * The capital-gains engine: unit matching, the cost inflation index, Schedule 112A, the
 * quarterly split, and the treatment of gifts.
 */

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import {
  CapitalGainsReport, FIFOUnits, Fund, GainEntry, GainEntry112A, GiftEntry,
  MergedTransaction, consolidateAe112a, fyConsolidatesAe, fyNeedsTransferCol,
  getFundType, quarterIndex, transferFlag,
} from '../src/analysis/gains.js';
import {
  CII, InvalidFinancialYearError, UnknownFinancialYearError, getFinYear,
} from '../src/analysis/utils.js';
import { CASFileType, FileType, FundType, TransactionType } from '../src/enums.js';
import { GainsError } from '../src/exceptions.js';
import { Decimal } from '../src/decimal.js';
import { CasDate } from '../src/dates.js';
import {
  CASData, Folio, InvestorInfo, Scheme, SchemeValuation, StatementPeriod, TransactionData,
} from '../src/types.js';
import { clearIsinDb, splitLines } from './_helpers.js';

const D = (value) => Decimal.parse(value);
const date = (y, m, d) => new CasDate(y, m, d);
const eq = (actual, expected, message) => assert.ok(
  Decimal.from(actual).eq(D(expected)),
  `${message || ''} expected ${expected}, got ${actual}`,
);

// No reference database, so the 2018 value lookup returns nothing and the fair market
// value falls back to the purchase value, exactly as the Python suite ran it.
before(() => clearIsinDb());
after(() => clearIsinDb());

/** A minimal statement wrapping one scheme, for the report tests. */
function reportFor(transactions, schemeType = 'EQUITY') {
  const scheme = new Scheme({
    scheme: 'Gift Test Fund - Direct Growth',
    rta_code: 'G123',
    rta: 'KFINTECH',
    type: schemeType,
    isin: 'INF123456789',
    open: D('0'),
    close: D('0'),
    close_calculated: D('0'),
    valuation: new SchemeValuation({ date: '2026-03-31', nav: D('10'), value: D('0') }),
    transactions,
  });
  return new CapitalGainsReport(new CASData({
    statement_period: new StatementPeriod({ from: '2021-04-01', to: '2026-03-31' }),
    folios: [new Folio({ folio: '12345', amc: 'Test Mutual Fund', schemes: [scheme] })],
    investor_info: new InvestorInfo({ name: 'X', email: 'x@x', address: 'x', mobile: 'x' }),
    cas_type: CASFileType.DETAILED,
    file_type: FileType.KFINTECH,
  }));
}

describe('the engine', () => {
  it('reads the cost inflation index, clamping outside the published range', () => {
    assert.throws(() => CII.get('2000-01'), InvalidFinancialYearError);
    assert.throws(() => CII.get('FY2001-05'), UnknownFinancialYearError);
    assert.ok(Math.abs(CII.get('FY2020-21') / CII.get('FY2001-02') - 3.01) <= 1e-3);

    assert.equal(CII.get('FY2023-24'), 348);
    assert.equal(CII.get('FY2024-25'), 363);
    assert.equal(CII.get('FY2025-26'), 376);
    assert.equal(CII.get('FY2026-27'), 384);

    const today = CasDate.today();
    const future = new CasDate(today.year + 3, today.month, today.day);
    assert.equal(CII.get('FY1990-91'), 100);
    assert.equal(CII.get(getFinYear(future)), CII.get(CII.maxYear));
  });

  it('works out the fund type from what the statement shows', () => {
    const transactions = [new TransactionData({
      date: '2020-01-01',
      description: 'Purchase',
      amount: 10000.00,
      units: 1000,
      nav: 10,
      balance: 1000.00,
      type: TransactionType.PURCHASE,
    })];
    assert.equal(getFundType(transactions), FundType.UNKNOWN);

    transactions.push(new TransactionData({
      date: '2020-01-01',
      description: 'Redemption',
      amount: -5100.00,
      units: -100,
      nav: 11,
      balance: 900.00,
      type: TransactionType.REDEMPTION,
    }));
    assert.equal(getFundType(transactions), FundType.DEBT);

    transactions.push(new TransactionData({
      date: '2020-02-01',
      description: '***STT paid***',
      amount: 0.26,
      type: TransactionType.STT_TAX,
    }));
    assert.equal(getFundType(transactions), FundType.EQUITY);
  });

  it('does not read an outgoing gift as a redemption', () => {
    const transactions = [
      new TransactionData({
        date: '2022-01-01',
        description: 'Purchase',
        amount: D('10000.00'),
        units: D('1000.000'),
        nav: D('10'),
        balance: D('1000.000'),
        type: TransactionType.PURCHASE,
      }),
      new TransactionData({
        date: '2025-11-14',
        description: 'Gifting of units-TO Folio No: 12345678901',
        amount: D('-50000.00'),
        units: D('-1000.000'),
        nav: D('50'),
        balance: D('0.000'),
        type: TransactionType.GIFT_OUT,
      }),
    ];
    // No real disposal, so the fund type cannot be inferred.
    assert.equal(getFundType(transactions), FundType.UNKNOWN);
    const fifo = new FIFOUnits(new Fund('Gift Fund', '123', 'INF123456789', 'EQUITY'), transactions);
    assert.deepEqual(fifo.gains, []);
  });

  it('merges a day into one net movement', () => {
    const dt = date(2000, 1, 1);
    const merged = new MergedTransaction(dt);

    merged.add(new TransactionData({
      date: dt,
      description: 'Segregation',
      amount: null,
      units: D('1000.000'),
      nav: null,
      balance: D('1000.000'),
      type: TransactionType.SEGREGATION,
    }));
    eq(merged.sale_units, '0.00');
    eq(merged.purchase_units, '1000.000');
    eq(merged.nav, '0.00');
    eq(merged.purchase, '0.00');
    eq(merged.sale, '0.00');
    eq(merged.tds, '0.00');

    merged.add(new TransactionData({
      date: dt,
      description: '***TDS on above***',
      amount: D('1.25'),
      balance: D('1000.000'),
      type: TransactionType.TDS_TAX,
    }));
    eq(merged.tds, '1.25');
  });

  it('refuses to match a sale with nothing to match it against', () => {
    assert.throws(() => new FIFOUnits(
      new Fund('demo fund', '123', 'INF123456789', 'EQUITY'),
      [new TransactionData({
        date: date(2000, 1, 1),
        description: '***Redemption***',
        amount: D('-5000.00'),
        units: D('-100.000'),
        nav: D('50.000'),
        balance: D('500.00'),
        type: TransactionType.REDEMPTION,
      })],
    ), GainsError);
  });

  it('never claims more stamp duty than was paid, however the lot splits', () => {
    // A three-way split of a 300-unit lot carrying 1.25 in stamp duty: 0.42, then 0.42
    // on the remainder, then the last 0.41. Re-queueing the full original instead would
    // let each disposal claim the whole amount again.
    const purchaseDate = date(2020, 1, 1);
    const transactions = [
      new TransactionData({
        date: purchaseDate,
        description: 'Purchase',
        amount: D('3000.00'),
        units: D('300.000'),
        nav: D('10.000'),
        balance: D('300.000'),
        type: TransactionType.PURCHASE,
      }),
      new TransactionData({
        date: purchaseDate,
        description: '*** Stamp Duty ***',
        amount: D('1.25'),
        type: TransactionType.STAMP_DUTY_TAX,
      }),
      ...[[2022, 1, '200.000'], [2022, 2, '100.000'], [2022, 3, '0.000']].map(
        ([year, month, balance]) => new TransactionData({
          date: date(year, month, 1),
          description: 'Redemption',
          amount: D('-2000.00'),
          units: D('-100.000'),
          nav: D('20.000'),
          balance: D(balance),
          type: TransactionType.REDEMPTION,
        }),
      ),
    ];

    const fifo = new FIFOUnits(new Fund('Split-Lot Fund', 'SL', 'INF000SL0001', 'EQUITY'), transactions);
    assert.equal(fifo.gains.length, 3);

    const total = fifo.gains.reduce((sum, gain) => sum.add(gain.stamp_duty), D('0'));
    assert.ok(total.lte(D('1.25')), `total stamp ${total} exceeds 1.25`);
    // The rounding residual lands on the last disposal, so the total is exact.
    eq(total, '1.25');
  });

  it('nets a failed instalment to nothing, units and stamp duty alike', () => {
    const dt = date(2025, 9, 26);
    const transactions = [
      new TransactionData({
        date: dt,
        description: 'SIP Purchase - Instalment 1/7 - via an online portal',
        amount: D('2999.85'),
        units: D('1.365'),
        nav: D('2198.255'),
        balance: D('3.843'),
        type: TransactionType.PURCHASE_SIP,
      }),
      new TransactionData({
        date: dt,
        description: '*** Stamp Duty ***',
        amount: D('0.15'),
        type: TransactionType.STAMP_DUTY_TAX,
      }),
      new TransactionData({
        date: dt,
        description: 'SIP Purchase151/Payment not received from investor Banker Physical - Instalment No 1',
        amount: D('-2999.85'),
        units: D('-1.365'),
        nav: D('2198.255'),
        balance: D('2.478'),
        type: TransactionType.REVERSAL,
      }),
      new TransactionData({
        date: dt,
        description: '*** Stamp Duty ***',
        amount: D('-0.15'),
        type: TransactionType.STAMP_DUTY_TAX,
      }),
    ];

    const fifo = new FIFOUnits(new Fund('Failed-SIP Fund', 'FS', 'INF000FS0001', 'EQUITY'), transactions);
    const merged = fifo._mergedTransactions.get('2025-09-26');
    eq(merged.purchase_units, '0.000');
    eq(merged.sale_units, '0');
    eq(merged.stamp_duty, '0.00');

    assert.deepEqual(fifo.gains, []);
    eq(fifo.balance, '0');
  });
});

/** A long-term equity disposal, for the Schedule 112A tests. */
function ltcgEntry(fy, fund, purchaseDate, saleDate, units = '100.000') {
  return new GainEntry({
    fy,
    fund,
    type: 'EQUITY',
    purchase_date: purchaseDate,
    purchase_nav: D('10.0'),
    purchase_value: D('1000.00'),
    stamp_duty: D('1.00'),
    sale_date: saleDate,
    sale_nav: D('20.0'),
    sale_value: D('2000.00'),
    stt: D('2.00'),
    units: D(units),
  });
}

describe('schedule 112A', () => {
  it('flags a transfer by which side of the rate change it falls on', () => {
    assert.equal(transferFlag(date(2024, 7, 22)), 'BE');
    assert.equal(transferFlag(date(2024, 7, 23)), 'AE');
    assert.equal(transferFlag(date(2024, 9, 1)), 'AE');
    assert.equal(transferFlag(date(2020, 1, 1)), 'BE');
  });

  it('emits the transfer column only for the year that straddles the change', () => {
    assert.equal(fyNeedsTransferCol('FY2024-25'), true);
    for (const fy of ['FY2025-26', 'FY2026-27', 'FY2023-24', 'FY2020-21', '']) {
      assert.equal(fyNeedsTransferCol(fy), false, fy);
    }
  });

  it('consolidates from the year the form started accepting one row', () => {
    assert.equal(fyConsolidatesAe('FY2025-26'), true);
    assert.equal(fyConsolidatesAe('FY2026-27'), true);
    assert.equal(fyConsolidatesAe('FY2024-25'), false);
    assert.equal(fyConsolidatesAe('FY2023-24'), false);
    assert.equal(fyConsolidatesAe(''), false);
  });

  it('merges the post-2018 rows and leaves the grandfathered ones alone', () => {
    const ae = (isin, sale, cost, stt, stamp) => new GainEntry112A(
      'AE', 'AE', isin, isin, D('10'), D('5'), D(sale), D(cost), D('0'), D('0'), D(stt), D(stamp),
    );
    const be = new GainEntry112A(
      'BE', 'AE', 'INF000A01001', 'Grandfathered Fund', D('5'), D('100'), D('500'),
      D('300'), D('80'), D('400'), D('1'), D('2'),
    );
    const out = consolidateAe112a([
      be,
      ae('INF000A01002', '1000', '800', '1', '3'),
      ae('INF000A01003', '2000', '1500', '2', '4'),
    ]);

    assert.equal(out.length, 2);
    assert.equal(out[0], be);
    const merged = out[1];
    assert.equal(merged.acquired, 'AE');
    assert.equal(merged.isin, 'INNOTREQUIRD');
    assert.equal(merged.name, 'CONSOLIDATED');
    eq(merged.units, '0');
    eq(merged.sale_nav, '0');
    eq(merged.sale_value, '3000');
    eq(merged.purchase_value, '2300');
    // Stamp duty joins the cost; the transaction tax does not.
    eq(merged.deductions, '2307');
    eq(merged.balance, '693');
  });

  it('leaves a list with nothing to consolidate untouched', () => {
    const be = new GainEntry112A(
      'BE', 'AE', 'INF000A01001', 'F', D('5'), D('100'), D('500'), D('300'),
      D('80'), D('400'), D('1'), D('2'),
    );
    assert.deepEqual(consolidateAe112a([be]), [be]);
  });

  it('splits one fund across the cutoff into a row per side', () => {
    const fund = new Fund('Equity Fund', 'F1', 'INF000A01001', 'EQUITY');
    const rows = CapitalGainsReport.fromGains([
      ltcgEntry('FY2024-25', fund, date(2022, 1, 1), date(2024, 6, 1)),
      ltcgEntry('FY2024-25', fund, date(2022, 2, 1), date(2024, 9, 1)),
    ]).generate112a('FY2024-25');

    assert.equal(rows.length, 2);
    assert.deepEqual(new Set(rows.map((row) => row.transferred)), new Set(['BE', 'AE']));
    assert.ok(rows.every((row) => row.acquired === 'AE'));
  });

  it('keeps a grandfathered lot as its own row with its own flag', () => {
    const fund = new Fund('Equity Fund', 'F1', 'INF000A01001', 'EQUITY');
    const rows = CapitalGainsReport.fromGains([
      ltcgEntry('FY2024-25', fund, date(2017, 1, 1), date(2024, 9, 1)),
    ]).generate112a('FY2024-25');

    assert.equal(rows.length, 1);
    assert.equal(rows[0].acquired, 'BE');
    assert.equal(rows[0].transferred, 'AE');
  });

  it('writes the transfer column in the right place for 2024-25', () => {
    const fund = new Fund('Equity Fund', 'F1', 'INF000A01001', 'EQUITY');
    const csv = CapitalGainsReport
      .fromGains([ltcgEntry('FY2024-25', fund, date(2022, 1, 1), date(2024, 9, 1))])
      .generate112aCsvData('FY2024-25');

    const lines = splitLines(csv);
    const columns = lines[0].split(',');
    assert.ok(lines[0].includes('Share/Unit Transferred(1b)'));
    assert.equal(columns[0], 'Share/Unit acquired(1a)');
    assert.equal(columns[1], 'Share/Unit Transferred(1b)');
    assert.equal(columns[2], 'ISIN Code(2)');
    assert.equal(lines[1].split(',')[1], 'AE');
  });

  it('leaves the transfer column out of an older year', () => {
    const fund = new Fund('Equity Fund', 'F1', 'INF000A01001', 'EQUITY');
    const csv = CapitalGainsReport
      .fromGains([ltcgEntry('FY2021-22', fund, date(2019, 1, 1), date(2021, 6, 1))])
      .generate112aCsvData('FY2021-22');

    const columns = splitLines(csv)[0].split(',');
    assert.ok(!columns.join(',').includes('Transferred(1b)'));
    assert.equal(columns[0], 'Share/Unit acquired(1a)');
    assert.equal(columns[1], 'ISIN Code(2)');
  });

  it('writes one consolidated whole-rupee row from 2025-26', () => {
    const csv = CapitalGainsReport.fromGains([
      ltcgEntry('FY2025-26', new Fund('Fund A', 'A', 'INF000A01001', 'EQUITY'), date(2022, 1, 1), date(2025, 6, 1)),
      ltcgEntry('FY2025-26', new Fund('Fund B', 'B', 'INF000A01002', 'EQUITY'), date(2023, 1, 1), date(2025, 7, 1)),
    ]).generate112aCsvData('FY2025-26');

    const lines = splitLines(csv);
    assert.ok(!lines[0].includes('Transferred(1b)'));
    const data = lines.slice(1);
    assert.equal(data.length, 1);

    const columns = data[0].split(',');
    assert.equal(columns[0], 'AE');
    assert.equal(columns[1], 'INNOTREQUIRD');
    assert.equal(columns[2], 'CONSOLIDATED');
    assert.equal(columns[3], '0');
    assert.equal(columns[4], '0');
    assert.equal(columns[5], '4000');
    assert.equal(columns[6], '2002');
    assert.equal(columns[7], '2002');
    assert.deepEqual(columns.slice(8, 11), ['0', '0', '0']);
    assert.equal(columns[11], '0');
    assert.equal(columns[12], '2002');
    assert.equal(columns[13], '1998');
    assert.ok(!data[0].includes('.'));
  });
});

/** A generic disposal for the quarterly tests: cost 1000 plus 1 stamp, sale 2000. */
function entry(fy, type, purchaseDate, saleDate) {
  return new GainEntry({
    fy,
    fund: new Fund(`${type} Fund`, 'X', 'INF000X01001', type),
    type,
    purchase_date: purchaseDate,
    purchase_nav: D('10.0'),
    purchase_value: D('1000.00'),
    stamp_duty: D('1.00'),
    sale_date: saleDate,
    sale_nav: D('20.0'),
    sale_value: D('2000.00'),
    stt: D('2.00'),
    units: D('100.000'),
  });
}

describe('quarterly split', () => {
  it('places a transfer in the right advance-tax window', () => {
    assert.equal(quarterIndex(date(2025, 4, 1)), 0);
    assert.equal(quarterIndex(date(2025, 6, 15)), 0);
    assert.equal(quarterIndex(date(2025, 6, 16)), 1);
    assert.equal(quarterIndex(date(2025, 9, 15)), 1);
    assert.equal(quarterIndex(date(2025, 9, 16)), 2);
    assert.equal(quarterIndex(date(2025, 12, 15)), 2);
    assert.equal(quarterIndex(date(2025, 12, 16)), 3);
    assert.equal(quarterIndex(date(2026, 1, 31)), 3);
    assert.equal(quarterIndex(date(2026, 3, 15)), 3);
    assert.equal(quarterIndex(date(2026, 3, 16)), 4);
    assert.equal(quarterIndex(date(2026, 3, 31)), 4);
  });

  it('reconciles the equity long-term row with the 112A total', () => {
    const report = CapitalGainsReport.fromGains([
      ltcgEntry('FY2025-26', new Fund('Fund A', 'A', 'INF000A01001', 'EQUITY'), date(2022, 1, 1), date(2025, 5, 1)),
      ltcgEntry('FY2025-26', new Fund('Fund B', 'B', 'INF000A01002', 'EQUITY'), date(2023, 1, 1), date(2026, 3, 20)),
    ]);
    const buckets = report.quarterlyGains('FY2025-26');
    // Per lot: 2000 - (1000 + 1 stamp).
    eq(buckets['Equity LTCG'][0], '999.00');
    eq(buckets['Equity LTCG'][4], '999.00');
    eq(buckets['Equity LTCG'][1], '0');

    const balanceTotal = report.generate112a('FY2025-26')
      .reduce((total, row) => total.add(row.balance), D('0'));
    const bucketTotal = buckets['Equity LTCG'].reduce((total, q) => total.add(q), D('0'));
    assert.ok(bucketTotal.eq(balanceTotal), `${bucketTotal} vs ${balanceTotal}`);
  });

  it('sorts gains into equity and debt, long and short', () => {
    const buckets = CapitalGainsReport.fromGains([
      entry('FY2025-26', 'EQUITY', date(2025, 4, 1), date(2025, 8, 1)),
      entry('FY2025-26', 'DEBT', date(2024, 1, 1), date(2025, 6, 1)),
      entry('FY2025-26', 'DEBT', date(2020, 1, 1), date(2025, 10, 1)),
    ]).quarterlyGains('FY2025-26');

    eq(buckets['Equity STCG'][1], '999.00');
    eq(buckets['Equity STCG'].reduce((t, q) => t.add(q), D('0')), '999.00');
    eq(buckets['Debt STCG'][0], '999.00');
    assert.ok(buckets['Debt LTCG'][2].gt(D('0')));
    eq(buckets['Equity LTCG'].reduce((t, q) => t.add(q), D('0')), '0');
  });

  it('includes only the year asked for', () => {
    const fund = new Fund('Fund A', 'A', 'INF000A01001', 'EQUITY');
    const buckets = CapitalGainsReport.fromGains([
      ltcgEntry('FY2024-25', fund, date(2022, 1, 1), date(2024, 5, 1)),
      ltcgEntry('FY2025-26', fund, date(2022, 1, 1), date(2025, 5, 1)),
    ]).quarterlyGains('FY2025-26');

    const total = Object.values(buckets)
      .flat()
      .reduce((sum, amount) => sum.add(amount), D('0'));
    eq(total, '999.00');
  });
});

describe('stamp duty in the cost of acquisition', () => {
  const sample = () => ltcgEntry(
    'FY2024-25', new Fund('Equity Fund', 'F1', 'INF000A01001', 'EQUITY'),
    date(2022, 1, 1), date(2024, 9, 1),
  );

  it('nets the gain of the stamp duty paid on the purchase', () => {
    const gain = sample();
    eq(gain.acquisition_value, '1001.00');
    eq(gain.gain, '999.00');
    eq(gain.ltcg, '999.00');
  });

  it('carries it into the deductible cost', () => {
    const gain = sample();
    eq(gain.coa, '1001.00');
    eq(gain.ltcg_taxable, '999.00');
  });

  it('keeps the transaction tax out of the 112A deductions', () => {
    const rows = CapitalGainsReport.fromGains([sample()]).generate112a('FY2024-25');
    assert.equal(rows.length, 1);
    eq(rows[0].actual_coa, '1001.00');
    eq(rows[0].expenditure, '0.00');
    eq(rows[0].deductions, '1001.00');
    eq(rows[0].balance, '999.00');
  });
});

describe('gifts', () => {
  const purchase = () => new TransactionData({
    date: '2022-01-01',
    description: 'Purchase',
    amount: D('10000.00'),
    units: D('1000.000'),
    nav: D('10'),
    balance: D('1000.000'),
    type: TransactionType.PURCHASE,
  });

  const giftOut = () => new TransactionData({
    date: '2025-11-14',
    description: 'Gifting of units-TO Folio No: 12345678901',
    amount: D('-50000.00'),
    units: D('-1000.000'),
    nav: D('50'),
    balance: D('0.000'),
    type: TransactionType.GIFT_OUT,
    gift_folio: '12345678901',
  });

  it('records the direction and the folio on the other side', () => {
    const fund = new Fund('F', '12345', 'INF123456789', 'EQUITY');
    const out = GiftEntry.fromTransaction(fund, giftOut());
    assert.equal(out.direction, 'OUT');
    assert.equal(out.counterparty_folio, '12345678901');
    assert.equal(out.date.toString(), '2025-11-14');
    assert.equal(out.fy, 'FY2025-26');

    const incoming = GiftEntry.fromTransaction(fund, new TransactionData({
      date: '2025-11-14',
      description: 'Gifting of units - From Folio No.87654321',
      amount: D('50000.00'),
      units: D('1000.000'),
      nav: D('50'),
      balance: D('1000.000'),
      type: TransactionType.GIFT_IN,
      gift_folio: '87654321',
    }));
    assert.equal(incoming.direction, 'IN');
    assert.equal(incoming.counterparty_folio, '87654321');
  });

  it('discloses an outgoing gift without turning it into a gain', () => {
    const report = reportFor([purchase(), giftOut()]);
    assert.equal(report.hasGifts(), true);
    assert.equal(report.gifts.length, 1);
    assert.equal(report.gifts[0].direction, 'OUT');
    assert.equal(report.hasGains(), false);
    assert.equal(report.hasError(), false);
    assert.ok(report.getGiftsCsvData().includes('Direction'));
  });

  it('explains why a resold gift cannot be priced', () => {
    const report = reportFor([
      new TransactionData({
        date: '2024-01-01',
        description: 'Gifting of units-FROM Folio No: 12345678901',
        amount: D('50000.00'),
        units: D('1000.000'),
        nav: D('50'),
        balance: D('1000.000'),
        type: TransactionType.GIFT_IN,
      }),
      new TransactionData({
        date: '2025-06-01',
        description: 'Redemption',
        amount: D('-60000.00'),
        units: D('-1000.000'),
        nav: D('60'),
        balance: D('0.000'),
        type: TransactionType.REDEMPTION,
      }),
    ]);
    assert.equal(report.hasError(), true);
    assert.equal(report.errors.length, 1);
    const [, message] = report.errors[0];
    assert.ok(message.includes('gifted-in units'));
    assert.ok(message.includes('donor'));
    assert.equal(report.hasGifts(), true);
  });
});
