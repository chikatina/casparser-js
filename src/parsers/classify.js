/**
 * Classification helpers shared by the CAMS and KFin readers.
 *
 * Two pure functions: one maps a transaction description plus its signed unit count to a
 * transaction type (and pulls out the dividend rate where there is one), the other
 * normalises a raw scheme name.
 */

import { TransactionType } from '../enums.js';
import { Decimal } from '../decimal.js';

/**
 * An income-distribution line and the per-unit rupee value in it.
 *
 * The "reinvest" hint is searched for separately rather than as an optional group. With a
 * lazy match on both sides of such a group the engine settles on the first complete match
 * and never backtracks to fill it, so it only ever captured the word when it sat exactly
 * where the minimal expansion stopped: "Reinvestment of IDCW @ Rs..." and "IDCW -
 * Reinvest @ Rs..." both leaked through as payouts. A plain search is unambiguous.
 */
const DIVIDEND_RE = /(?:div\.|dividend|idcw)[\s\S]*?@\s*Rs\.\s*([\d.]+)(?:\s+per\s+unit)?/i;
const REINVEST_RE = /reinvest/i;

/**
 * A systematic transfer: a switch by another name, money moved between two schemes on a
 * schedule. CAMS spells it out, which the "switch" keyword already catches; KFintech
 * prints it letter-spaced as "S T P In/Out", which used to fall through to a plain
 * purchase or redemption.
 */
const STP_RE = /\bs\s*t\s*p\b|systematic\s+transfer/i;

/**
 * The folio on the other side of a gift transfer. The two registrars punctuate it
 * differently — a colon or a full stop — so both are accepted.
 */
const GIFT_FOLIO_RE = /Folio\s+No\s*[:.]\s*(\d+)/i;

const INSTALMENT_RE = /instal+ment/i;
const SYSTEMATIC_INVEST_RE = /sys[\s\S]+?invest/i;
const REVERSAL_RE = /reversal|rejection|dishonoured|mismatch|insufficient\s+balance|payment\s+not\s+received/i;

/** The counterparty folio named in a gift description, or null. */
export function extractGiftFolio(description) {
  const match = GIFT_FOLIO_RE.exec(description || '');
  return match ? match[1] : null;
}

/**
 * Classifies a transaction from its description and the sign of its units.
 *
 * @returns {[string, Decimal|null]} the transaction type and, for an income
 *   distribution, its per-unit rate
 */
export function getTransactionType(description, units) {
  let dividendRate = null;
  const text = String(description || '').toLowerCase();
  const unitsValue = units === null || units === undefined ? null : Decimal.from(units);

  const dividend = DIVIDEND_RE.exec(text);
  if (dividend) {
    dividendRate = Decimal.parse(dividend[1]);
    return [
      REINVEST_RE.test(text) ? TransactionType.DIVIDEND_REINVEST : TransactionType.DIVIDEND_PAYOUT,
      dividendRate,
    ];
  }

  if (unitsValue === null) {
    if (text.includes('stt')) return [TransactionType.STT_TAX, null];
    if (text.includes('stamp')) return [TransactionType.STAMP_DUTY_TAX, null];
    if (text.includes('tds')) return [TransactionType.TDS_TAX, null];
    return [TransactionType.MISC, null];
  }

  if (unitsValue.gt(0)) {
    if (text.includes('gift')) return [TransactionType.GIFT_IN, null];
    if (text.includes('switch') || STP_RE.test(text)) {
      return [
        text.includes('merger') ? TransactionType.SWITCH_IN_MERGER : TransactionType.SWITCH_IN,
        null,
      ];
    }
    if (text.includes('segregat')) return [TransactionType.SEGREGATION, null];
    if (text.includes('sip') || text.includes('systematic')
      || INSTALMENT_RE.test(text) || SYSTEMATIC_INVEST_RE.test(text)) {
      return [TransactionType.PURCHASE_SIP, null];
    }
    return [TransactionType.PURCHASE, null];
  }

  if (unitsValue.lt(0)) {
    if (text.includes('gift')) return [TransactionType.GIFT_OUT, null];
    if (REVERSAL_RE.test(text)) return [TransactionType.REVERSAL, null];
    if (text.includes('switch') || STP_RE.test(text)) {
      return [
        text.includes('merger') ? TransactionType.SWITCH_OUT_MERGER : TransactionType.SWITCH_OUT,
        null,
      ];
    }
    return [TransactionType.REDEMPTION, null];
  }

  return [TransactionType.UNKNOWN, null];
}

/**
 * Strips the `(formerly ...)`, `(erstwhile ...)`, `(Demat ...)` and `(Non-Demat ...)`
 * trailers, collapses whitespace and trims trailing punctuation.
 */
export function getParsedSchemeName(scheme) {
  let name = String(scheme || '');
  name = name.replace(/\((formerly|erstwhile)[\s\S]+?\)/gi, '').trim();
  name = name.replace(/\((Demat|Non-Demat)[\s\S]*/gi, '').trim();
  name = name.replace(/\s+/g, ' ').trim();
  return name.replace(/[^a-zA-Z0-9_)]+$/, '').trim();
}
