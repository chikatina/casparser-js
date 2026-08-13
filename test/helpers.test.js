/**
 * The small reusable helpers: transaction classification, scheme-name cleanup, the folio
 * header guard, the running-balance validator and the reference lookup.
 */

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { TransactionType } from '../src/enums.js';
import { Decimal } from '../src/decimal.js';
import {
  extractGiftFolio, getParsedSchemeName, getTransactionType,
} from '../src/parsers/classify.js';
import { isinSearch } from '../src/isin.js';
import {
  DATE_CELL_RE, FOLIO_LINE_RE, applyBalanceSignFix, reconcileBalances,
} from '../src/parsers/cams_detailed.js';
import { Scheme, SchemeValuation, TransactionData } from '../src/types.js';
import { clearIsinDb, useSampleIsinDb } from './_helpers.js';

const D = (value) => Decimal.parse(value);

/**
 * The folio-header guard from the detailed reader: a real header matches the folio
 * pattern and is not a dated transaction row.
 */
function isFolioHeader(text) {
  return Boolean(text.includes('Folio No') && !DATE_CELL_RE.test(text)
    && FOLIO_LINE_RE.test(text));
}

/** A minimal scheme built from `[units, balance]` rows, for the reconciliation tests. */
function scheme(open, close, rows) {
  return new Scheme({
    scheme: 'Test Fund - Direct Growth',
    rta_code: 'T123',
    rta: 'CAMS',
    open: D(String(open)),
    close: D(String(close)),
    close_calculated: D(String(close)),
    valuation: new SchemeValuation({ date: '2021-12-31', nav: D('10'), value: D('0') }),
    transactions: rows.map(([units, balance], index) => new TransactionData({
      date: `2021-01-${String(index + 1).padStart(2, '0')}`,
      description: 'txn',
      units,
      balance,
      type: TransactionType.PURCHASE,
    })),
  });
}

describe('transaction type', () => {
  it('classifies the basic shapes', () => {
    assert.deepEqual(getTransactionType('Redemption', D('-100')),
      [TransactionType.REDEMPTION, null]);
    assert.deepEqual(getTransactionType('Address updated', null),
      [TransactionType.MISC, null]);
    assert.deepEqual(getTransactionType('***STT paid ***', null),
      [TransactionType.STT_TAX, null]);
    assert.deepEqual(getTransactionType('***stamp duty***', null),
      [TransactionType.STAMP_DUTY_TAX, null]);
    assert.deepEqual(getTransactionType('*** TDS on Above ***', null),
      [TransactionType.TDS_TAX, null]);
    assert.deepEqual(getTransactionType('Creation of units - Segregated portfolio', D('1')),
      [TransactionType.SEGREGATION, null]);
  });

  it('cannot classify a row with no units either way', () => {
    assert.deepEqual(getTransactionType('***Random text***', D('0')),
      [TransactionType.UNKNOWN, null]);
  });

  it('reads a failed instalment as a reversal, not a redemption', () => {
    assert.deepEqual(
      getTransactionType('Purchase SIPCheque Dishonoured - Instalment No 108', D('-1')),
      [TransactionType.REVERSAL, null],
    );
    assert.deepEqual(
      getTransactionType(
        'SIP Purchase151/Payment not received from investor Banker Physical - Instalment No 1',
        D('-1.365'),
      ),
      [TransactionType.REVERSAL, null],
    );
  });

  it('classifies a gift by its keyword and its sign, not as a redemption', () => {
    assert.deepEqual(
      getTransactionType('Gifting of units-TO Folio No: 12345678901', D('-4085.662')),
      [TransactionType.GIFT_OUT, null],
    );
    assert.deepEqual(
      getTransactionType('Gifting of units - To Folio No.87654321', D('-8224.686')),
      [TransactionType.GIFT_OUT, null],
    );
    assert.deepEqual(
      getTransactionType('Gifting of units-FROM Folio No: 12345678901', D('4085.662')),
      [TransactionType.GIFT_IN, null],
    );
  });

  it('reads a systematic transfer as a switch however the registrar spells it', () => {
    assert.deepEqual(
      getTransactionType(
        'Systematic Transfer Plan Switch Out - To SBI Small Cap Fund Dir Growth-',
        D('-5.938'),
      ),
      [TransactionType.SWITCH_OUT, null],
    );
    assert.deepEqual(
      getTransactionType(
        'Systematic Transfer Plan Switch In - From SBI Liquid Fund Direct Growth-',
        D('126.972'),
      ),
      [TransactionType.SWITCH_IN, null],
    );
    assert.deepEqual(
      getTransactionType(
        'S T P Out (To Axis Mid Cap Fund - Direct Growth F.No:91064932471)',
        D('-24.933'),
      ),
      [TransactionType.SWITCH_OUT, null],
    );
    assert.deepEqual(
      getTransactionType(
        'S T P In (From Axis Liquid Fund - Direct Growth F.No:91064932471)',
        D('571.574'),
      ),
      [TransactionType.SWITCH_IN, null],
    );
  });

  it('keeps a genuine instalment purchase out of the transfer bucket', () => {
    assert.deepEqual(
      getTransactionType('Systematic Investment-Instalment No 12', D('10')),
      [TransactionType.PURCHASE_SIP, null],
    );
  });

  it('separates a reinvested distribution from a paid-out one', () => {
    const cases = [
      ['IDCW Reinvestment @ Rs.2.00 per unit', TransactionType.DIVIDEND_REINVEST, '2.00'],
      ['IDCW Reinvested @ Rs.0.0241 per unit', TransactionType.DIVIDEND_REINVEST, '0.0241'],
      ['IDCW Paid @ Rs.0.06 per unit', TransactionType.DIVIDEND_PAYOUT, '0.06'],
      ['Div. Reinvested @ Rs.0.0241 per unit', TransactionType.DIVIDEND_REINVEST, '0.0241'],
      // The word can sit before the anchor or be split from it by punctuation; both used
      // to leak through as a payout.
      ['Reinvestment of IDCW @ Rs.0.0241 per unit', TransactionType.DIVIDEND_REINVEST, '0.0241'],
      ['IDCW - Reinvest @ Rs.0.06 per unit', TransactionType.DIVIDEND_REINVEST, '0.06'],
    ];
    for (const [description, expectedType, expectedRate] of cases) {
      const [type, rate] = getTransactionType(description, D('1'));
      assert.equal(type, expectedType, description);
      assert.ok(rate.eq(D(expectedRate)), description);
    }
  });
});

describe('folio header guard', () => {
  it('accepts a genuine header', () => {
    assert.ok(isFolioHeader('Folio No: 12345678901 PAN: ABCDE1234F KYC: OK PAN: OK'));
    assert.ok(isFolioHeader('Folio No: 12124203 / 63 KYC: OK'));
  });

  it('rejects a gift row that names the other folio', () => {
    assert.ok(!isFolioHeader(
      '14-Nov-2025 Gifting of units-TO Folio No: 12345678901 (547,682.99) (4,085.662) 134.05 0.000',
    ));
    assert.ok(!isFolioHeader(
      '20-Nov-2025 Gifting of units - To Folio No.87654321 (776,558.40) (8,224.686) 94.4180 0.000',
    ));
  });
});

describe('gift folio extraction', () => {
  it('reads either punctuation', () => {
    assert.equal(extractGiftFolio('Gifting of units-TO Folio No: 12345678901'), '12345678901');
    assert.equal(extractGiftFolio('Gifting of units - To Folio No.87654321'), '87654321');
    assert.equal(extractGiftFolio('Gifting of units-FROM Folio No: 99887766554'), '99887766554');
  });

  it('is null when there is none', () => {
    assert.equal(extractGiftFolio('Purchase'), null);
    assert.equal(extractGiftFolio(''), null);
  });
});

describe('scheme name cleanup', () => {
  it('leaves a clean name alone', () => {
    assert.equal(
      getParsedSchemeName('Axis Long Term Equity Fund - Direct Growth'),
      'Axis Long Term Equity Fund - Direct Growth',
    );
  });

  it('trims trailing whitespace', () => {
    assert.equal(
      getParsedSchemeName('Axis Bluechip Fund - Regular Growth '),
      'Axis Bluechip Fund - Regular Growth',
    );
  });

  it('drops a former-name trailer', () => {
    assert.equal(
      getParsedSchemeName(
        'HSBC Corporate Bond Fund - Regular Growth '
        + '(Formerly known as L&T Triple Ace Bond Fund - Growth)',
      ),
      'HSBC Corporate Bond Fund - Regular Growth',
    );
  });

  it('drops an erstwhile-name trailer', () => {
    assert.equal(
      getParsedSchemeName(
        'Bandhan ELSS Tax saver Fund-Growth-(Regular Plan)'
        + '(erstwhile Bandhan Tax Advantage ELSS Fund-Growth-Regular Plan)',
      ),
      'Bandhan ELSS Tax saver Fund-Growth-(Regular Plan)',
    );
  });

  it('drops a demat qualifier', () => {
    assert.equal(
      getParsedSchemeName(
        'Bandhan Liquid Fund-Growth-(Regular Plan) '
        + '(erstwhile IDFC Cash Fund-Growth-Regular Plan) (Non-Demat) ',
      ),
      'Bandhan Liquid Fund-Growth-(Regular Plan)',
    );
  });
});

describe('balance reconciliation', () => {
  it('says nothing about a scheme that adds up', () => {
    const s = scheme(0, '150', [[D('100'), D('100')], [D('50'), D('150')]]);
    assert.deepEqual(reconcileBalances(s), []);
  });

  it('skips a row that carries no units', () => {
    const s = scheme(0, '100', [[D('100'), D('100')], [null, D('100')]]);
    assert.deepEqual(reconcileBalances(s), []);
  });

  it('flags a dropped row once and resyncs', () => {
    const s = scheme(0, '300', [[D('100'), D('100')], [D('100'), D('300')]]);
    const warnings = reconcileBalances(s);
    assert.equal(warnings.length, 1);
    assert.ok(warnings[0].includes('discontinuity'));
  });

  it('flags a closing mismatch no printed row would expose', () => {
    const s = scheme(0, '200', [[D('100'), D('100')], [D('50'), null]]);
    const warnings = reconcileBalances(s);
    assert.equal(warnings.length, 1);
    assert.ok(warnings[0].includes('closing unit balance mismatch'));
  });
});

describe('balance sign fix', () => {
  const build = (open, transactions) => new Scheme({
    scheme: 'dummy',
    rta: 'CAMS',
    rta_code: 'X',
    type: 'EQUITY',
    open,
    close: D('0'),
    close_calculated: D('0'),
    valuation: new SchemeValuation({ date: '1970-01-01', nav: D('0'), value: D('0') }),
    transactions,
  });

  const txn = (units, balance, description = 'Payment', amount = null) => new TransactionData({
    date: '2021-03-30',
    description,
    amount,
    units,
    nav: D('1'),
    balance,
    type: TransactionType.REDEMPTION,
  });

  it('flips a sign the running balance contradicts, and reclassifies', () => {
    const s = build(D('558.456'), [
      // Parsed as negative because the statement parenthesised it, but the balance jumps
      // up by the same amount, so the sign is positive.
      txn(D('-171.447'), D('729.903'), 'Payment - Units Extinguished-Reversed', D('-5126.75')),
    ]);
    applyBalanceSignFix(s);
    const t = s.transactions[0];
    assert.ok(t.units.eq(D('171.447')));
    assert.ok(t.amount.eq(D('5126.75')));
    assert.equal(t.type, TransactionType.PURCHASE);
    assert.ok(s.close_calculated.eq(D('729.903')));
  });

  it('leaves a correct redemption alone', () => {
    const s = build(D('1000'), [txn(D('-100'), D('900'), 'Redemption', D('-3000'))]);
    applyBalanceSignFix(s);
    const t = s.transactions[0];
    assert.ok(t.units.eq(D('-100')));
    assert.ok(t.amount.eq(D('-3000')));
    assert.equal(t.type, TransactionType.REDEMPTION);
    assert.ok(s.close_calculated.eq(D('900')));
  });

  it('skips rows with no units and carries the balance forward', () => {
    const s = build(D('1000'), [
      txn(null, D('1000'), '*** Stamp Duty ***'),
      txn(D('-100'), D('900'), 'Redemption'),
    ]);
    applyBalanceSignFix(s);
    assert.equal(s.transactions[0].units, null);
    assert.ok(s.transactions[1].units.eq(D('-100')));
    assert.equal(s.transactions[1].type, TransactionType.REDEMPTION);
  });

  it('leaves a row alone when neither sign fits', () => {
    const s = build(D('1000'), [txn(D('50'), D('999'), 'Mystery')]);
    applyBalanceSignFix(s);
    assert.ok(s.transactions[0].units.eq(D('50')));
  });
});

describe('reference lookup', () => {
  before(() => useSampleIsinDb());
  after(() => clearIsinDb());

  it('resolves a scheme from its registrar code', () => {
    const [isin, amfi, type] = isinSearch(
      'Axis Long Term Equity Fund - Direct Growth', 'KFINTECH', '128TSDGG',
    );
    assert.equal(isin, 'INF846K01EW2');
    assert.equal(amfi, '120503');
    assert.equal(type, 'EQUITY');
  });

  it('returns nothing when nothing matches', () => {
    const [isin, amfi, type] = isinSearch('', 'KARVY', '');
    assert.equal(isin, null);
    assert.equal(amfi, null);
    assert.equal(type, null);
  });
});
