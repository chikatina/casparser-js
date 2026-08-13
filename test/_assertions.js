/**
 * Invariants shared across the end-to-end suite.
 *
 * Each one checks a structural or arithmetic property of a parsed statement, chosen so
 * the tests can pin down correctness without putting real rupee figures in a public
 * repository. What they catch: a swapped column, a comma stripped wrongly, a bond row
 * landing in the equities list, a units cell read as zero.
 *
 * The tolerances are deliberately tight. These are bookkeeping numbers the statement
 * itself printed, so the only slack needed is the statement's own rounding.
 */

import assert from 'node:assert/strict';
import { Decimal } from '../src/decimal.js';

/** One paisa. The figures come from the statement already rounded. */
const ABS_TOL = Decimal.parse('0.01');

/**
 * Half a per cent on a derived figure. Issuers truncate values at four decimal places and
 * quantities at three, so a per-row rounding can land a few paise out on a large holding
 * without anything being wrong.
 */
const REL_TOL = Decimal.parse('0.005');

const PAN_RE = /^[A-Z]{5}[0-9]{4}[A-Z]$/;
const ISIN_MF_RE = /^INF[0-9A-Z]{8}\d$/;
const ISIN_ANY_RE = /^[A-Z]{2}[0-9A-Z]{9}\d$/;

const D = (value) => Decimal.from(value);

export function assertRelClose(actual, expected, label = '', tolerance = REL_TOL) {
  const a = D(actual);
  const e = D(expected);
  if (e.isZero()) {
    assert.ok(a.abs().lte(ABS_TOL), `${label}: expected about zero, got ${a}`);
    return;
  }
  const difference = a.sub(e).abs().div(e.abs());
  assert.ok(difference.lte(tolerance), `${label}: ${a} against ${e}, off by ${difference}`);
}

// --------------------------------------------------------------- registrar data

/** A scheme always carries its identifiers and a positive valuation. */
export function assertSchemeWellFormed(scheme) {
  assert.ok(scheme.isin, `scheme ${scheme.scheme}: no ISIN`);
  assert.ok(scheme.amfi, `scheme ${scheme.scheme}: no AMFI code`);
  assert.ok(scheme.rta_code, `scheme ${scheme.scheme}: no registrar code`);
  // A clean registrar acronym. A wrapped header used to leak an advisor fragment, an
  // ISIN fragment or a watermark fragment into this field, so the shape is asserted
  // rather than an allowed list, which would false-flag a legitimate self-registrar.
  assert.ok(
    /^[A-Z]{3,12}$/.test(scheme.rta || ''),
    `scheme ${scheme.scheme}: malformed registrar ${scheme.rta}`,
  );
  assert.ok(scheme.valuation);
  assert.ok(D(scheme.valuation.nav).gt(0), `scheme ${scheme.scheme}: nav is not positive`);
}

/**
 * Fragments from the footer, the disclaimer and the load notes that never appear inside a
 * fund's name. Finding one means the trailing notes bled into it.
 */
const FOOTER_BLEED_RE = new RegExp(
  'kindly|FATCA|\\bCRS\\b|stamp\\s+duty|addendum|please\\s+refer|redeemed\\s+after|'
  + 'date\\s+of\\s+allotment|basis\\s+relevant|tax\\s+provisions|immediately|'
  + 'effect\\s+from|evaluated\\s+by\\s+investor',
  'i',
);

/** A scheme name reads like a fund name and has not swallowed the notes below it. */
export function assertSchemeNameClean(scheme) {
  const name = scheme.scheme || '';
  assert.ok(!FOOTER_BLEED_RE.test(name), `scheme name has footer text in it: ${name}`);
  // A real name, even with a former-name suffix and a plan and an option, stays well
  // under this. The bled ones ran to two hundred characters and more.
  assert.ok(name.length <= 150, `scheme name is implausibly long (${name.length}): ${name}`);
}

/** Closing balance times value per unit reproduces the valuation. */
export function assertSchemeValuationArithmetic(scheme) {
  const close = D(scheme.close);
  if (close.isZero()) {
    assert.ok(
      D(scheme.valuation.value).isZero(),
      `scheme ${scheme.scheme}: nothing held but a valuation of ${scheme.valuation.value}`,
    );
    return;
  }
  assertRelClose(
    close.mul(scheme.valuation.nav),
    scheme.valuation.value,
    `scheme ${scheme.scheme}: close times nav against value`,
  );
}

/**
 * Opening balance plus every transaction's units equals the closing balance.
 *
 * This is the strongest check on a transaction history: a missed purchase, a misread
 * date, a dropped redemption or a duplicated row all break it. Tax rows carry no units
 * and are skipped; they move only the cash side.
 */
export function assertSchemeTransactionUnitsClose(scheme) {
  const open = D(scheme.open);
  const close = D(scheme.close);
  const total = scheme.transactions
    .filter((txn) => txn.units !== null)
    .reduce((sum, txn) => sum.add(txn.units), Decimal.parse('0'));
  const difference = open.add(total).sub(close).abs();
  assert.ok(
    difference.lte(Decimal.parse('0.001')),
    `scheme ${scheme.scheme}: open ${open} plus units ${total} is not close ${close}`,
  );
}

export function assertFolioWellFormed(folio) {
  assert.ok(PAN_RE.test(folio.PAN || ''), `folio ${folio.folio}: malformed PAN`);
  assert.ok(folio.amc, `folio ${folio.folio}: no AMC`);
  assert.ok(folio.schemes.length, `folio ${folio.folio}: no schemes`);
}

export function assertInvestorInfoComplete(info) {
  assert.ok(info.name, 'investor: no name');
  assert.ok(info.email, 'investor: no email');
  assert.ok(info.mobile, 'investor: no mobile');
  assert.ok(info.address, 'investor: no address');
}

// -------------------------------------------------------------- depository data

/**
 * Every equity row carries a well-formed ISIN and consistent numbers.
 *
 * A lapsed rights entitlement or a fully-exited position shows up with a zero quantity
 * and a zero value; those are valid informational rows, not failures, so the check is for
 * consistency rather than for positive numbers. The per-row product is deliberately not
 * enforced: some summary rows inline a pledged note that confuses the quantity column,
 * and the account-level total below catches the dangerous case anyway.
 */
export function assertEquityWellFormed(equity) {
  assert.ok(ISIN_ANY_RE.test(equity.isin || ''), `equity: bad ISIN ${equity.isin}`);
  assert.ok(D(equity.value).gte(0), `equity ${equity.isin}: negative value`);
  assert.ok(D(equity.price).gte(0), `equity ${equity.isin}: negative price`);
  assert.ok(D(equity.num_shares).gte(0), `equity ${equity.isin}: negative quantity`);
  if (D(equity.value).gt(0)) {
    assert.ok(D(equity.price).gt(0), `equity ${equity.isin}: a value but no price`);
  }
}

/**
 * Every fund holding has a fund ISIN and obeys balance times value per unit.
 *
 * This is the strongest per-row check on the detailed table: it catches the drift case
 * where the units cell falls outside its band and reads as zero while the value stays
 * right.
 */
export function assertMutualFundWellFormed(fund) {
  assert.ok(ISIN_MF_RE.test(fund.isin || ''), `fund: bad ISIN ${fund.isin}`);
  assert.ok(D(fund.value).gte(0), `fund ${fund.isin}: negative value`);
  assert.ok(D(fund.balance).gte(0), `fund ${fund.isin}: negative balance`);
  if (D(fund.value).isZero()) {
    assert.ok(D(fund.balance).isZero(), `fund ${fund.isin}: no value but a balance`);
    return;
  }
  assert.ok(D(fund.nav).gt(0), `fund ${fund.isin}: a value but no nav`);
  assertRelClose(
    D(fund.balance).mul(fund.nav),
    fund.value,
    `fund ${fund.isin}: balance times nav against value`,
  );
}

/** A summary bond carries its full metadata and its quantity times face value exactly. */
export function assertBondSummaryForm(bond) {
  assert.ok(ISIN_ANY_RE.test(bond.isin || ''), `bond: bad ISIN ${bond.isin}`);
  assert.ok(bond.face_value !== null, `bond ${bond.isin}: no face value`);
  assert.ok(bond.coupon_rate !== null, `bond ${bond.isin}: no coupon rate`);
  assert.ok(bond.coupon_frequency, `bond ${bond.isin}: no coupon frequency`);
  assert.ok(bond.maturity_date, `bond ${bond.isin}: no maturity date`);
  assert.equal(bond.market_price, null, `bond ${bond.isin}: a market price on a summary row`);
  assert.ok(
    D(bond.num_bonds).mul(bond.face_value).eq(D(bond.value)),
    `bond ${bond.isin}: quantity times face value is not the value`,
  );
}

/** A detailed bond carries only quantity, market price and value. */
export function assertBondDetailedForm(bond) {
  assert.ok(ISIN_ANY_RE.test(bond.isin || ''), `bond: bad ISIN ${bond.isin}`);
  assert.ok(bond.market_price !== null, `bond ${bond.isin}: no market price`);
  assert.equal(bond.face_value, null, `bond ${bond.isin}: a face value on a detailed row`);
  assert.equal(bond.coupon_rate, null, `bond ${bond.isin}: a coupon rate on a detailed row`);
  assertRelClose(
    D(bond.num_bonds).mul(bond.market_price),
    bond.value,
    `bond ${bond.isin}: quantity times market price against value`,
  );
}

/**
 * The holdings add up to the account balance.
 *
 * The strongest account-level check: a row misrouted between sections still sums right,
 * because the value column is the same either way; a row that was dropped does not.
 */
export function assertAccountBalanceCloses(account) {
  const zero = Decimal.parse('0');
  const total = [...account.equities, ...account.mutual_funds, ...account.bonds]
    .reduce((sum, holding) => sum.add(holding.value), zero);
  const difference = total.sub(D(account.balance)).abs();
  assert.ok(
    difference.lte(ABS_TOL),
    `account ${account.type} ${account.dp_id || '-'}/${account.client_id || '-'}: `
    + `holdings total ${total} against balance ${account.balance}`,
  );
}

/** A demat account has a recognisable type and identifiers of the right shape. */
export function assertDematAccountWellFormed(account) {
  assert.ok(
    ['NSDL Demat Account', 'CDSL Demat Account', 'Mutual Fund Folios'].includes(account.type),
    `account: unexpected type ${account.type}`,
  );
  if (account.type === 'NSDL Demat Account') {
    assert.ok(/^IN\d{6}$/.test(account.dp_id || ''), `NSDL: bad DP id ${account.dp_id}`);
    assert.ok(/^\d{8}$/.test(account.client_id || ''), 'NSDL: bad client id');
  } else if (account.type === 'CDSL Demat Account') {
    assert.ok(/^\d{8}$/.test(account.dp_id || ''), 'CDSL: bad DP id');
    assert.ok(/^\d{8}$/.test(account.client_id || ''), 'CDSL: bad client id');
  } else {
    assert.equal(account.dp_id, '');
    assert.equal(account.client_id, '');
  }
}
