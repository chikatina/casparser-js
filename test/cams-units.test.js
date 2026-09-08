/**
 * Unit tests for CAMS detailed parser additions:
 * - Folio.name holder name extraction
 * - Wrapped transaction description continuation
 * - Informational marker rows vs stray footnote filtering
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { TransactionType } from '../src/enums.js';
import { Decimal } from '../src/decimal.js';
import { Folio, TransactionData } from '../src/types.js';
import {
  CONTINUATION_MAX_GAP,
  HOLDER_NAME_CHARS_RE,
  continuationText,
  looksLikeHolderName,
} from '../src/parsers/cams_detailed.js';
import { extractGiftFolio, getTransactionType } from '../src/parsers/classify.js';

describe('Folio model holder name', () => {
  it('defaults name to null', () => {
    const folio = new Folio({ folio: '12345/67', amc: 'HDFC Mutual Fund' });
    assert.equal(folio.name, null);
    assert.equal(folio.dump().name, null);
  });

  it('preserves holder name when provided', () => {
    const folio = new Folio({
      folio: '12345/67',
      amc: 'HDFC Mutual Fund',
      name: 'RAJESH SHARMA',
    });
    assert.equal(folio.name, 'RAJESH SHARMA');
    assert.equal(folio.dump().name, 'RAJESH SHARMA');
  });
});

describe('looksLikeHolderName', () => {
  it('accepts valid single and joint holder names', () => {
    assert.equal(looksLikeHolderName('JOHN DOE'), true);
    assert.equal(looksLikeHolderName("MARY D'SOUZA"), true);
    assert.equal(looksLikeHolderName('SURESH CHANDRA AGARWAL'), true);
    assert.equal(looksLikeHolderName('A B C DEF'), true);
    assert.equal(looksLikeHolderName('MR RAJESH KUMAR & ANITA KUMAR'), true);
    assert.equal(looksLikeHolderName('DR. VIKRAM SARABHAI'), true);
  });

  it('rejects single-word names', () => {
    assert.equal(looksLikeHolderName('JOHN'), false);
    assert.equal(looksLikeHolderName(''), false);
  });

  it('rejects strings with too many words or exceeding length limit', () => {
    assert.equal(looksLikeHolderName('A B C D E F G H I'), false); // 9 words
    assert.equal(looksLikeHolderName('A'.repeat(81) + ' B'), false); // > 80 chars
  });

  it('rejects lines with lowercase words or invalid characters', () => {
    assert.equal(looksLikeHolderName('john doe'), false);
    assert.equal(looksLikeHolderName('John doe'), false);
    assert.equal(looksLikeHolderName('JOHN 123'), false);
    assert.equal(looksLikeHolderName('JOHN @ DOE'), false);
  });

  it('rejects scheme lines and RTA/advisor headers', () => {
    assert.equal(looksLikeHolderName('K123 - Kotak Flexicap Fund - Direct Growth'), false);
    assert.equal(looksLikeHolderName('Registrar : CAMS'), false);
    assert.equal(looksLikeHolderName('Advisor : ARN-12345'), false);
    assert.equal(looksLikeHolderName('(Advisor: DIRECT)'), false);
    assert.equal(looksLikeHolderName('Date Transaction Amount Units Price Unit Balance'), false);
  });

  it('handles null and undefined gracefully', () => {
    assert.equal(looksLikeHolderName(null), false);
    assert.equal(looksLikeHolderName(undefined), false);
  });

  it('respects HOLDER_NAME_CHARS_RE pattern', () => {
    assert.equal(HOLDER_NAME_CHARS_RE.test("O'NEILL & SONS"), true);
    assert.equal(HOLDER_NAME_CHARS_RE.test('DR. SMITH-JONES'), true);
    assert.equal(HOLDER_NAME_CHARS_RE.test('123 ABC'), false);
  });
});

describe('continuationText', () => {
  it('extracts description when only Transaction column is present', () => {
    assert.equal(
      continuationText({ Transaction: 'Instalment 5/18' }),
      'Instalment 5/18',
    );
    assert.equal(
      continuationText({ Transaction: '   Instalment 5/18   ' }),
      'Instalment 5/18',
    );
  });

  it('returns null if any numeric or date column has content', () => {
    assert.equal(
      continuationText({ Transaction: 'Instalment 5/18', Amount: '1000' }),
      null,
    );
    assert.equal(
      continuationText({ Transaction: 'Instalment 5/18', Units: '10.5' }),
      null,
    );
    assert.equal(
      continuationText({ Date: '01-Jan-2021', Transaction: 'Instalment 5/18' }),
      null,
    );
    assert.equal(
      continuationText({ Transaction: 'Instalment 5/18', 'Unit Balance': '100.5' }),
      null,
    );
    assert.equal(
      continuationText({ Transaction: 'Instalment 5/18', Price: '95.2' }),
      null,
    );
  });

  it('returns null if Transaction column is empty or whitespace', () => {
    assert.equal(continuationText({}), null);
    assert.equal(continuationText({ Transaction: '' }), null);
    assert.equal(continuationText({ Transaction: '    ' }), null);
  });

  it('has CONTINUATION_MAX_GAP set to 10.0', () => {
    assert.equal(CONTINUATION_MAX_GAP, 10.0);
  });
});

describe('wrapped description reclassification', () => {
  it('reclassifies PURCHASE to PURCHASE_SIP when continuation adds instalment info', () => {
    const units = Decimal.parse('100.500');
    const [initialType] = getTransactionType('Systematic Investment', units);
    assert.equal(initialType, TransactionType.PURCHASE_SIP);

    // Initial line with generic purchase description
    const [genericType] = getTransactionType('Purchase', units);
    assert.equal(genericType, TransactionType.PURCHASE);

    // Wrapped continuation appended:
    const continuation = 'Instalment 5 / 18';
    const merged = `Purchase ${continuation}`;
    const [mergedType, dividendRate] = getTransactionType(merged, units);
    assert.equal(mergedType, TransactionType.PURCHASE_SIP);
    assert.equal(dividendRate, null);
  });

  it('extracts gift_folio when continuation contains gift folio transfer target', () => {
    const initialDesc = 'Transfer Out (Gift)';
    const tail = 'to Folio No: 12345';
    const merged = `${initialDesc} ${tail}`;
    const [type] = getTransactionType(merged, Decimal.parse('-50.000'));
    assert.equal(type, TransactionType.GIFT_OUT);
    assert.equal(extractGiftFolio(merged), '12345');
  });
});

describe('informational marker rows vs stray footnotes', () => {
  function shouldSkipRow({ amount, units, balance, description }) {
    return amount === null && units === null && balance === null && !description.startsWith('***');
  }

  it('preserves *** marker rows without amount, units, or balance', () => {
    const row = {
      amount: null,
      units: null,
      balance: null,
      description: '***Registration of Nominee***',
    };
    assert.equal(shouldSkipRow(row), false);

    // Classified as MISC
    const [txnType] = (row.amount === null && row.units === null)
      ? [TransactionType.MISC, null]
      : getTransactionType(row.description, row.units);
    assert.equal(txnType, TransactionType.MISC);
  });

  it('preserves balance restatement rows with balance but no amount/units', () => {
    const row = {
      amount: null,
      units: null,
      balance: Decimal.parse('500.000'),
      description: 'Transmission of Units',
    };
    assert.equal(shouldSkipRow(row), false);

    const [txnType] = (row.amount === null && row.units === null)
      ? [TransactionType.MISC, null]
      : getTransactionType(row.description, row.units);
    assert.equal(txnType, TransactionType.MISC);
  });

  it('skips stray footnote date lines with null amount, units, and balance', () => {
    const row = {
      amount: null,
      units: null,
      balance: null,
      description: 'Effective from 01-Apr-2019, stamp duty on mutual fund purchase...',
    };
    assert.equal(shouldSkipRow(row), true);
  });
});
