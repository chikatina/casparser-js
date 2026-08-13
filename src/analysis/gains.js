/**
 * Realised capital gains from a parsed statement.
 *
 * Units are matched first in, first out, which is what the Income-tax Act requires for
 * mutual fund units and what the registrars' own gains statements do. From that come the
 * per-lot gains, the Schedule 112A rows, and the split of the year's realised gains into
 * the five advance-tax windows.
 *
 * One deliberate difference from the Python original: it compared a scheme's type string
 * against an enum *member*, a comparison that is never true, so the indexation branch for
 * debt schemes could not fire. Here it does. Nothing else in the port diverges.
 */

import { FundType, GainType, TransactionType } from '../enums.js';
import { Decimal, ROUND_HALF_UP, ZERO } from '../decimal.js';
import { CasDate, asDate } from '../dates.js';
import { GainsError, IncompleteCASError } from '../exceptions.js';
import { navSearch } from '../isin.js';
import { CII, getFinYear } from './utils.js';
import { writeCsv } from '../parsers/utils.js';

const PURCHASE_TXNS = new Set([
  TransactionType.DIVIDEND_REINVEST,
  TransactionType.PURCHASE,
  TransactionType.PURCHASE_SIP,
  TransactionType.REVERSAL,
  // A segregated portfolio is classified but not otherwise supported.
  TransactionType.SWITCH_IN,
  TransactionType.SWITCH_IN_MERGER,
]);

const SALE_TXNS = new Set([
  TransactionType.REDEMPTION,
  TransactionType.SWITCH_OUT,
  TransactionType.SWITCH_OUT_MERGER,
]);

/**
 * The Finance (No. 2) Act 2024 split the 2024-25 long-term regime on this date: the
 * equity rate moved from ten per cent to twelve and a half, and the exemption from one
 * lakh to one and a quarter. Schedule 112A from assessment year 2025-26 carries a column
 * flagging which side of it each transfer falls on.
 */
export const LTCG_REGIME_CUTOFF = new CasDate(2024, 7, 23);

/**
 * That column exists only on the 2024-25 form, the single year straddling the change.
 * From 2025-26 there is one regime again and the column is gone.
 */
const TRANSFER_COL_FY_START_YEAR = 2024;

/** From 2025-26 the form takes one consolidated row for all post-2018 acquisitions. */
const CONSOLIDATED_AE_FROM_FY_START_YEAR = 2025;
const CONSOLIDATED_AE_ISIN = 'INNOTREQUIRD';
const CONSOLIDATED_AE_NAME = 'CONSOLIDATED';

const GRANDFATHER_CUTOFF = new CasDate(2018, 1, 31);
const GRANDFATHER_SELL_CUTOFF = new CasDate(2018, 4, 1);

function fyStartYear(fy) {
  const match = /^FY(\d{4})/.exec(fy || '');
  return match ? Number(match[1]) : null;
}

/** `BE` before the rate change, `AE` on or after it. */
export function transferFlag(saleDate) {
  return asDate(saleDate).lt(LTCG_REGIME_CUTOFF) ? 'BE' : 'AE';
}

export function fyNeedsTransferCol(fy) {
  return fyStartYear(fy) === TRANSFER_COL_FY_START_YEAR;
}

export function fyConsolidatesAe(fy) {
  const year = fyStartYear(fy);
  return year !== null && year >= CONSOLIDATED_AE_FROM_FY_START_YEAR;
}

/** Whole rupees: the Schedule 112A utility rejects decimals in its amount fields. */
function rupees(value) {
  return Decimal.from(value).quantize('1', ROUND_HALF_UP).toBigInt().toString();
}

/**
 * Schedule CG section F, and the registrars' own gains statements, split the year's
 * realised gains into the five advance-tax windows by date of transfer, which is what
 * drives the interest calculation for a shortfall. The windows are uneven and the last is
 * a sixteen-day sliver; each boundary date belongs to the window it closes.
 */
export const QUARTER_LABELS = [
  'Upto 15/6',
  '16/6 to 15/9',
  '16/9 to 15/12',
  '16/12 to 15/3',
  '16/3 to 31/3',
];

/**
 * The four categories this can distinguish. Equity and debt come from the fund type and
 * long against short from the holding period; the taxpayer's slab is unknowable here, so
 * debt stays one bucket rather than being split by rate.
 */
export const QUARTERLY_CATEGORIES = ['Equity LTCG', 'Equity STCG', 'Debt LTCG', 'Debt STCG'];

/** Which of the five windows a transfer falls in, in April-to-March order. */
export function quarterIndex(date) {
  const d = asDate(date);
  const month = d.month;
  const day = d.day;
  if (month <= 3) return (month === 3 && day >= 16) ? 4 : 3;
  if (month < 6 || (month === 6 && day <= 15)) return 0;
  if (month < 9 || (month === 9 && day <= 15)) return 1;
  if (month < 12 || (month === 12 && day <= 15)) return 2;
  return 3;
}

/** One row of Schedule 112A. */
export class GainEntry112A {
  constructor(
    acquired, transferred, isin, name, units, saleNav, saleValue, purchaseValue,
    fmvNav, fmv, stt, stampDuty,
  ) {
    this.acquired = acquired;
    this.transferred = transferred;
    this.isin = isin;
    this.name = name;
    this.units = Decimal.from(units);
    this.sale_nav = Decimal.from(saleNav);
    this.sale_value = Decimal.from(saleValue);
    this.purchase_value = Decimal.from(purchaseValue);
    // Without a reference database there is no 31-January-2018 value to record, and the
    // fair market value falls back to the purchase value. Both stay representable.
    this.fmv_nav = Decimal.maybe(fmvNav);
    this.fmv = Decimal.from(fmv);
    this.stt = Decimal.from(stt);
    this.stamp_duty = Decimal.from(stampDuty);
  }

  get consideration_value() {
    if (this.acquired !== 'BE') return Decimal.parse('0.00');
    return this.fmv.lt(this.sale_value) ? this.fmv : this.sale_value;
  }

  /** Stamp duty paid on acquisition forms part of the cost. */
  get actual_coa() {
    const consideration = this.consideration_value;
    const base = this.purchase_value.gt(consideration) ? this.purchase_value : consideration;
    return base.add(this.stamp_duty);
  }

  /**
   * Securities transaction tax is explicitly not deductible under section 112A, and stamp
   * duty is already inside the cost, so there is no separate transfer expenditure.
   */
  get expenditure() {
    return Decimal.parse('0.00');
  }

  get deductions() {
    return this.actual_coa.add(this.expenditure);
  }

  get balance() {
    return this.sale_value.sub(this.deductions);
  }
}

/**
 * Collapses the post-2018 rows into one, keeping the grandfathered rows itemised because
 * each needs its own 31-January-2018 value.
 */
export function consolidateAe112a(rows) {
  const ae = rows.filter((row) => row.acquired !== 'BE');
  if (!ae.length) return rows;
  const be = rows.filter((row) => row.acquired === 'BE');

  const sum = (pick) => ae.reduce((total, row) => total.add(pick(row)), ZERO);
  const merged = new GainEntry112A(
    'AE', 'AE', CONSOLIDATED_AE_ISIN, CONSOLIDATED_AE_NAME,
    ZERO, ZERO,
    sum((row) => row.sale_value),
    sum((row) => row.purchase_value),
    ZERO, ZERO,
    sum((row) => row.stt),
    sum((row) => row.stamp_duty),
  );
  return [...be, merged];
}

/** The net of everything that happened to one scheme on one date. */
export class MergedTransaction {
  constructor(date) {
    this.dt = date;
    this.nav = ZERO;
    this.purchase = ZERO;
    this.purchase_units = ZERO;
    this.sale = ZERO;
    this.sale_units = ZERO;
    this.stamp_duty = ZERO;
    this.stt = ZERO;
    this.tds = ZERO;
  }

  add(txn) {
    const type = txn.type;
    if (PURCHASE_TXNS.has(type) && txn.units !== null) {
      this.nav = txn.nav;
      this.purchase_units = this.purchase_units.add(txn.units);
      this.purchase = this.purchase.add(txn.amount);
    } else if (SALE_TXNS.has(type) && txn.units !== null) {
      this.nav = txn.nav;
      this.sale_units = this.sale_units.add(txn.units);
      this.sale = this.sale.add(txn.amount);
    } else if (type === TransactionType.STT_TAX) {
      this.stt = this.stt.add(txn.amount);
    } else if (type === TransactionType.STAMP_DUTY_TAX) {
      this.stamp_duty = this.stamp_duty.add(txn.amount);
    } else if (type === TransactionType.TDS_TAX) {
      this.tds = this.tds.add(txn.amount);
    } else if (type === TransactionType.SEGREGATION) {
      this.nav = ZERO;
      this.purchase_units = this.purchase_units.add(txn.units);
      this.purchase = ZERO;
    }
  }
}

/** Which scheme, in which folio. */
export class Fund {
  constructor(scheme, folio, isin, type) {
    this.scheme = scheme;
    this.folio = folio;
    this.isin = isin;
    this.type = type;
  }

  get name() {
    return `${this.scheme} [${this.folio}]`;
  }

  /** Funds are ordered by scheme name, which is how the reports group them. */
  static compare(a, b) {
    if (a.scheme < b.scheme) return -1;
    if (a.scheme > b.scheme) return 1;
    return 0;
  }

  equals(other) {
    return other instanceof Fund
      && this.scheme === other.scheme && this.folio === other.folio
      && this.isin === other.isin && this.type === other.type;
  }
}

/** One realised disposal: a lot bought on one date and sold on another. */
export class GainEntry {
  constructor({
    fy, fund, type, purchase_date: purchaseDate, purchase_nav: purchaseNav,
    purchase_value: purchaseValue, stamp_duty: stampDuty, sale_date: saleDate,
    sale_nav: saleNav, sale_value: saleValue, stt, units,
  }) {
    this.fy = fy;
    this.fund = fund;
    this.type = type;
    this.purchase_date = asDate(purchaseDate);
    this.purchase_nav = Decimal.from(purchaseNav);
    this.purchase_value = Decimal.from(purchaseValue);
    this.stamp_duty = Decimal.from(stampDuty);
    this.sale_date = asDate(saleDate);
    this.sale_nav = Decimal.from(saleNav);
    this.sale_value = Decimal.from(saleValue);
    this.stt = Decimal.from(stt);
    this.units = Decimal.from(units);
    this._cachedIsin = fund.isin;
    this._cachedNav = navSearch(fund.isin);
  }

  /** Long term after a year for equity, three for debt. */
  get gain_type() {
    const threshold = this.type === FundType.EQUITY
      ? this.purchase_date.addYears(1)
      : this.purchase_date.addYears(3);
    if (this.type !== FundType.EQUITY && this.type !== FundType.DEBT) {
      throw new GainsError(`Cannot decide the holding period for fund type ${this.type}`);
    }
    return this.sale_date.gt(threshold) ? GainType.LTCG : GainType.STCG;
  }

  /**
   * The cost of acquisition, including the stamp duty paid on the purchase. Both
   * registrars report cost inclusive of it, and under the Act it forms part of the cost,
   * so leaving it out overstates the gain by exactly that amount.
   */
  get acquisition_value() {
    return this.purchase_value.add(this.stamp_duty);
  }

  get gain() {
    return this.sale_value.sub(this.acquisition_value).round(2);
  }

  /** The scheme's value on 31 January 2018, for a grandfathered lot. */
  get fmv_nav() {
    if (this.fund.isin !== this._cachedIsin) {
      this._cachedIsin = this.fund.isin;
      this._cachedNav = navSearch(this.fund.isin);
    }
    return this._cachedNav;
  }

  get fmv() {
    const nav = this.fmv_nav;
    if (nav === null) return this.purchase_value;
    return nav.mul(this.units);
  }

  get index_ratio() {
    const ratio = CII.get(getFinYear(this.sale_date)) / CII.get(getFinYear(this.purchase_date));
    return Decimal.from(Number(Decimal.from(ratio).round(2).toString()));
  }

  /** The deductible cost, after indexation or grandfathering where either applies. */
  get coa() {
    if (this.fund.type === FundType.DEBT) {
      return this.acquisition_value.mul(this.index_ratio).round(2);
    }
    if (this.purchase_date.lt(GRANDFATHER_CUTOFF)) {
      if (this.sale_date.lt(GRANDFATHER_SELL_CUTOFF)) return this.sale_value;
      const substituted = this.fmv.lt(this.sale_value) ? this.fmv : this.sale_value;
      return this.acquisition_value.gt(substituted) ? this.acquisition_value : substituted;
    }
    return this.acquisition_value;
  }

  get ltcg_taxable() {
    if (this.gain_type === GainType.LTCG) return this.sale_value.sub(this.coa).round(2);
    return ZERO;
  }

  get ltcg() {
    return this.gain_type === GainType.LTCG ? this.gain : ZERO;
  }

  get stcg() {
    return this.gain_type === GainType.STCG ? this.gain : ZERO;
  }
}

/**
 * The taxable equity long-term gain for one lot, on the same measure Schedule 112A uses,
 * so the quarterly split reconciles with the 112A report exactly. Consolidation there is
 * linear, so summing this over a fund's lots equals that fund's consolidated row.
 */
function taxable112a(gain) {
  const consideration = gain.purchase_date.lte(GRANDFATHER_CUTOFF)
    ? (gain.fmv.lt(gain.sale_value) ? gain.fmv : gain.sale_value)
    : ZERO;
  const base = gain.purchase_value.gt(consideration) ? gain.purchase_value : consideration;
  return gain.sale_value.sub(base.add(gain.stamp_duty));
}

/**
 * An inter-folio gift, recorded for disclosure only.
 *
 * Gifts are kept out of the gains computation on purpose: for the donor it is not a
 * transfer, and for the recipient the cost basis and holding period carry over from the
 * donor and do not exist in a single statement.
 */
export class GiftEntry {
  constructor({ fy, fund, direction, date, units, nav, value, counterparty_folio: folio }) {
    this.fy = fy;
    this.fund = fund;
    this.direction = direction;
    this.date = date;
    this.units = units;
    this.nav = nav;
    this.value = value;
    this.counterparty_folio = folio;
  }

  static fromTransaction(fund, txn) {
    const date = asDate(txn.date);
    return new GiftEntry({
      fy: getFinYear(date),
      fund,
      direction: txn.type === TransactionType.GIFT_IN ? 'IN' : 'OUT',
      date,
      units: txn.units,
      nav: txn.nav,
      value: txn.amount,
      counterparty_folio: txn.gift_folio || '',
    });
  }
}

/**
 * Works out whether a scheme is equity or debt.
 *
 * Unknown without a redemption to go on. With one, the presence of a securities
 * transaction tax entry marks it as equity, because that tax is only levied on equity
 * schemes; its absence alongside a redemption marks it as debt.
 */
export function getFundType(transactions) {
  const hasDisposal = transactions.some((txn) => txn.units !== null
    && Decimal.from(txn.units).lt(0)
    && txn.type !== TransactionType.REVERSAL
    && txn.type !== TransactionType.GIFT_OUT);
  if (!hasDisposal) return FundType.UNKNOWN;
  return transactions.some((txn) => txn.type === TransactionType.STT_TAX)
    ? FundType.EQUITY
    : FundType.DEBT;
}

const HUNDREDTH = Decimal.parse('0.01');

/** First in, first out unit matching for one scheme. */
export class FIFOUnits {
  constructor(fund, transactions) {
    this._fund = fund;
    this._originalTransactions = transactions;
    this.fund_type = (fund.type === FundType.EQUITY || fund.type === FundType.DEBT)
      ? fund.type
      : getFundType(transactions);
    this._mergedTransactions = this.mergeTransactions();

    this.transactions = [];
    this.invested = ZERO;
    this.balance = ZERO;
    this.gains = [];

    this.process();
  }

  /** Rows with no amount carry no cash effect and are dropped. */
  get cleanTransactions() {
    return this._originalTransactions.filter((txn) => txn.amount !== null);
  }

  /** Groups a scheme's transactions by date, taxes kept apart from the units. */
  mergeTransactions() {
    const merged = new Map();
    const ordered = [...this.cleanTransactions].sort((a, b) => {
      const byDate = asDate(a.date).ordinal - asDate(b.date).ordinal;
      if (byDate !== 0) return byDate;
      // Largest amount first, so a same-day purchase settles before its reversal.
      return Decimal.from(b.amount).cmp(a.amount);
    });

    for (const txn of ordered) {
      const key = asDate(txn.date).toString();
      if (!merged.has(key)) merged.set(key, new MergedTransaction(asDate(txn.date)));
      merged.get(key).add(txn);
    }
    return merged;
  }

  process() {
    this.gains = [];
    const keys = [...this._mergedTransactions.keys()].sort();
    for (const key of keys) {
      const txn = this._mergedTransactions.get(key);
      if (txn.purchase_units.gt(0)) {
        this.buy(txn.dt, txn.purchase_units, txn.nav, txn.stamp_duty);
      }
      if (txn.sale_units.lt(0)) {
        this.sell(txn.dt, txn.sale_units, txn.nav, txn.stt);
      }
    }
    return this.gains;
  }

  buy(date, quantity, nav, tax) {
    const rate = nav === null ? ZERO : Decimal.from(nav);
    this.transactions.push([date, quantity, rate, tax]);
    this.invested = this.invested.add(quantity.mul(rate));
    this.balance = this.balance.add(quantity);
  }

  sell(saleDate, quantity, nav, tax) {
    const fy = getFinYear(saleDate);
    const originalQuantity = Decimal.from(quantity).abs();
    let pending = originalQuantity;
    const rate = nav === null ? ZERO : Decimal.from(nav);

    while (pending.gte(HUNDREDTH)) {
      const lot = this.transactions.shift();
      if (!lot) {
        throw new GainsError(`FIFOUnits mismatch for ${this._fund.name}. Please contact support.`);
      }
      const [purchaseDate, units, purchaseNav, purchaseTax] = lot;
      const gainUnits = units.lte(pending) ? units : pending;

      const purchaseValue = gainUnits.mul(purchaseNav).round(2);
      const saleValue = gainUnits.mul(rate).round(2);
      const stampDuty = purchaseTax.mul(gainUnits).div(units).round(2);
      const stt = Decimal.from(tax).mul(gainUnits).div(originalQuantity).round(2);

      this.gains.push(new GainEntry({
        fy,
        fund: this._fund,
        type: this.fund_type,
        purchase_date: purchaseDate,
        purchase_nav: purchaseNav,
        purchase_value: purchaseValue,
        stamp_duty: stampDuty,
        sale_date: saleDate,
        sale_nav: rate,
        sale_value: saleValue,
        stt,
        units: gainUnits,
      }));

      this.balance = this.balance.sub(gainUnits);
      this.invested = this.invested.sub(purchaseValue);

      pending = pending.sub(units);
      if (pending.lt(0)) {
        // The sale only partly consumed the lot. Put the rest back with the stamp duty
        // that has *not* been allocated yet: re-queueing the full original would let a lot
        // split across several disposals claim the same stamp on each one, overstating the
        // deduction by a factor that grows with the split depth.
        this.transactions.unshift([
          purchaseDate, pending.neg(), purchaseNav, purchaseTax.sub(stampDuty),
        ]);
      }
    }
  }
}

/** Groups consecutive items sharing a key, the way `itertools.groupby` does. */
function groupBy(items, keyOf, sameKey = (a, b) => a === b) {
  const groups = [];
  for (const item of items) {
    const key = keyOf(item);
    const last = groups[groups.length - 1];
    if (last && sameKey(last.key, key)) {
      last.items.push(item);
    } else {
      groups.push({ key, items: [item] });
    }
  }
  return groups;
}

/** The whole capital-gains picture for one parsed statement. */
export class CapitalGainsReport {
  constructor(data) {
    this._data = data;
    this._gains = [];
    this._gifts = [];
    this.errors = [];
    this.invested_amount = ZERO;
    this.current_value = ZERO;
    if (data) this.processData();
  }

  /** A report built from ready-made gain entries, bypassing the matching engine. */
  static fromGains(gains) {
    const report = new CapitalGainsReport(null);
    report._gains = gains;
    report.errors = [];
    return report;
  }

  get gains() {
    return [...this._gains].sort((a, b) => {
      if (a.fy !== b.fy) return a.fy < b.fy ? -1 : 1;
      const byFund = Fund.compare(a.fund, b.fund);
      if (byFund !== 0) return byFund;
      return a.sale_date.ordinal - b.sale_date.ordinal;
    });
  }

  get gifts() {
    return [...this._gifts].sort((a, b) => {
      if (a.fy !== b.fy) return a.fy < b.fy ? -1 : 1;
      const byFund = Fund.compare(a.fund, b.fund);
      if (byFund !== 0) return byFund;
      return a.date.ordinal - b.date.ordinal;
    });
  }

  hasGains() { return this.gains.length > 0; }
  hasGifts() { return this._gifts.length > 0; }
  hasError() { return this.errors.length > 0; }

  getFyList() {
    return [...new Set(this.gains.map((gain) => gain.fy))].sort().reverse();
  }

  processData() {
    this._gains = [];
    this._gifts = [];

    for (const folio of this._data.folios) {
      for (const scheme of folio.schemes) {
        const transactions = scheme.transactions;
        const fund = new Fund(scheme.scheme, folio.folio, scheme.isin, scheme.type);

        // Every gift is disclosed, whichever way it went. None of them are gains.
        const gifts = transactions.filter((txn) => txn.type === TransactionType.GIFT_IN
          || txn.type === TransactionType.GIFT_OUT);
        for (const txn of gifts) this._gifts.push(GiftEntry.fromTransaction(fund, txn));

        const hasGiftIn = transactions.some((txn) => txn.type === TransactionType.GIFT_IN);
        if (!transactions.length) continue;

        if (Decimal.from(scheme.open).gte(HUNDREDTH)) {
          throw new IncompleteCASError(
            'Incomplete CAS found. For gains computation, all folios should have zero '
            + 'opening balance',
          );
        }

        try {
          const fifo = new FIFOUnits(fund, transactions);
          this.invested_amount = this.invested_amount.add(fifo.invested);
          this.current_value = this.current_value.add(scheme.valuation.value);
          this._gains.push(...fifo.gains);
        } catch (error) {
          if (!(error instanceof GainsError)) throw error;
          // A shortfall on a scheme that received gifted-in units means a later sale is
          // consuming units whose cost basis lives in the donor's statement, not this
          // one. Say so, rather than reporting a generic mismatch.
          if (hasGiftIn) {
            this.errors.push([
              fund.name,
              'Scheme received gifted-in units; capital gains on their later sale require '
              + "the donor's cost basis and holding period, which are not present in this "
              + 'statement. Scheme excluded from gains, see the Gift transactions section.',
            ]);
          } else {
            this.errors.push([fund.name, error.message]);
          }
        }
      }
    }
  }

  /** One row per financial year and fund, with the totals for each. */
  getSummary() {
    const groups = groupBy(
      this.gains,
      (gain) => [gain.fy, gain.fund],
      (a, b) => a[0] === b[0] && a[1].equals(b[1]),
    );
    return groups.map(({ key, items }) => {
      const [fy, fund] = key;
      let ltcg = ZERO;
      let stcg = ZERO;
      let ltcgTaxable = ZERO;
      for (const gain of items) {
        ltcg = ltcg.add(gain.ltcg);
        stcg = stcg.add(gain.stcg);
        ltcgTaxable = ltcgTaxable.add(gain.ltcg_taxable);
      }
      return [fy, fund.name, fund.isin, fund.type, ltcg, ltcgTaxable, stcg];
    });
  }

  getSummaryCsvData() {
    return writeCsv(
      ['FY', 'Fund', 'ISIN', 'Type', 'LTCG(Realized)', 'LTCG(Taxable)', 'STCG'],
      this.getSummary(),
    );
  }

  getGainsCsvData() {
    const header = [
      'FY', 'Fund', 'ISIN', 'Type', 'Units', 'Purchase Date', 'Purchase Value',
      'Stamp Duty', 'Acquisition Value', 'Sale Date', 'Sale Value', 'STT',
      'LTCG Realized', 'LTCG Taxable', 'STCG',
    ];
    const rows = this.gains.map((gain) => [
      gain.fy, gain.fund.name, gain.fund.isin, gain.type, gain.units,
      gain.purchase_date, gain.purchase_value, gain.stamp_duty, gain.coa,
      gain.sale_date, gain.sale_value, gain.stt, gain.ltcg, gain.ltcg_taxable, gain.stcg,
    ]);
    return writeCsv(header, rows);
  }

  getGiftsCsvData() {
    const header = [
      'FY', 'Fund', 'ISIN', 'Direction', 'Date', 'Units', 'NAV', 'Value',
      'Counterparty Folio',
    ];
    const rows = this.gifts.map((gift) => [
      gift.fy, gift.fund.name, gift.fund.isin, gift.direction, gift.date,
      gift.units, gift.nav, gift.value, gift.counterparty_folio,
    ]);
    return writeCsv(header, rows);
  }

  /**
   * Schedule 112A rows for a financial year.
   *
   * A grandfathered lot stays its own row because it needs its own 2018 value. Everything
   * else is consolidated per fund, but keyed on the transfer flag as well, so a fund sold
   * both before and after the July 2024 change yields one row per side: the form taxes
   * them at different rates.
   */
  generate112a(fy) {
    const eligible = this.gains
      .filter((gain) => gain.fy === fy && gain.fund.type === FundType.EQUITY
        && gain.gain_type === GainType.LTCG)
      .sort((a, b) => Fund.compare(a.fund, b.fund));

    const rows = [];
    for (const { key: fund, items } of groupBy(eligible, (gain) => gain.fund, (a, b) => a.equals(b))) {
      const entries = [];
      const consolidated = new Map();

      for (const gain of items) {
        const transferred = transferFlag(gain.sale_date);
        if (gain.purchase_date.lte(GRANDFATHER_CUTOFF)) {
          entries.push(new GainEntry112A(
            'BE', transferred, fund.isin, fund.scheme, gain.units, gain.sale_nav,
            gain.sale_value, gain.purchase_value, gain.fmv_nav, gain.fmv, gain.stt,
            gain.stamp_duty,
          ));
        } else if (!consolidated.has(transferred)) {
          consolidated.set(transferred, new GainEntry112A(
            'AE', transferred, fund.isin, fund.scheme, gain.units, gain.sale_nav,
            gain.sale_value, gain.purchase_value, ZERO, ZERO, gain.stt, gain.stamp_duty,
          ));
        } else {
          const row = consolidated.get(transferred);
          row.purchase_value = row.purchase_value.add(gain.purchase_value);
          row.stt = row.stt.add(gain.stt);
          row.stamp_duty = row.stamp_duty.add(gain.stamp_duty);
          row.units = row.units.add(gain.units);
          row.sale_value = row.sale_value.add(gain.sale_value);
          row.sale_nav = gain.sale_value.div(gain.units).round(3);
        }
      }
      rows.push(...entries, ...consolidated.values());
    }
    return fyConsolidatesAe(fy) ? consolidateAe112a(rows) : rows;
  }

  generate112aCsvData(fy) {
    // The transfer column arrived with the 2024-25 form. Emitting it only from that year
    // keeps an older return at the fourteen columns its utility expects.
    const withTransferCol = fyNeedsTransferCol(fy);
    const header = [
      'Share/Unit acquired(1a)',
      'ISIN Code(2)',
      'Name of the Share/Unit(3)',
      'No. of Shares/Units(4)',
      'Sale-price per Share/Unit(5)',
      'Full Value of Consideration(Total Sale Value)(6) = 4 * 5',
      'Cost of acquisition without indexation(7)',
      'Cost of acquisition(8)',
      'If the long term capital asset was acquired before 01.02.2018(9)',
      'Fair Market Value per share/unit as on 31st January 2018(10)',
      'Total Fair Market Value of capital asset as per section 55(2)(ac)(11) = 4 * 10',
      'Expenditure wholly and exclusively in connection with transfer(12)',
      'Total deductions(13) = 7 + 12',
      'Balance(14) = 6 - 13',
    ];
    if (withTransferCol) header.splice(1, 0, 'Share/Unit Transferred(1b)');

    const rows = [];
    for (const row of this.generate112a(fy)) {
      let values;
      if (row.acquired === 'AE') {
        // For a post-2018 acquisition the utility wants the gross value, the cost and the
        // expenditure; the grandfathering columns do not apply. The derived columns are
        // filled in too, so the file is self-consistent rather than relying on the import
        // to recompute them. Stamp duty is folded into the cost; the transaction tax is
        // not deductible and stays out.
        const sale = BigInt(rupees(row.sale_value));
        const cost = BigInt(rupees(row.purchase_value.add(row.stamp_duty)));
        values = [
          row.acquired, row.isin, row.name,
          '0', '0',
          String(sale), String(cost), String(cost),
          '0', '0', '0', '0',
          String(cost), String(sale - cost),
        ];
      } else {
        // A grandfathered row is itemised with its own 2018 value. Rupee amounts are
        // whole; units and per-unit values keep their precision.
        values = [
          row.acquired, row.isin, row.name,
          String(row.units), String(row.sale_nav),
          rupees(row.sale_value), rupees(row.actual_coa), rupees(row.purchase_value),
          rupees(row.consideration_value),
          row.fmv_nav === null ? '' : String(row.fmv_nav),
          rupees(row.fmv),
          rupees(row.expenditure), rupees(row.deductions), rupees(row.balance),
        ];
      }
      if (withTransferCol) values.splice(1, 0, row.transferred);
      rows.push(values);
    }
    return writeCsv(header, rows);
  }

  /**
   * The year's realised taxable gains, split into the five advance-tax windows by date of
   * transfer.
   *
   * The equity long-term row uses the same measure as Schedule 112A, so its total
   * reconciles with that report exactly. The rest use the realised short-term and indexed
   * long-term figures.
   */
  quarterlyGains(fy) {
    const buckets = {};
    for (const category of QUARTERLY_CATEGORIES) {
      buckets[category] = QUARTER_LABELS.map(() => ZERO);
    }

    for (const gain of this.gains) {
      if (gain.fy !== fy) continue;
      const quarter = quarterIndex(gain.sale_date);
      const isEquity = gain.fund.type === FundType.EQUITY;
      if (gain.gain_type === GainType.LTCG) {
        if (isEquity) {
          buckets['Equity LTCG'][quarter] = buckets['Equity LTCG'][quarter].add(taxable112a(gain));
        } else {
          buckets['Debt LTCG'][quarter] = buckets['Debt LTCG'][quarter].add(gain.ltcg_taxable);
        }
      } else {
        const key = isEquity ? 'Equity STCG' : 'Debt STCG';
        buckets[key][quarter] = buckets[key][quarter].add(gain.stcg);
      }
    }
    return buckets;
  }
}

export { taxable112a as _taxable112a };
