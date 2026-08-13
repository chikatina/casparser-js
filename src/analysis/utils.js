/** Cost inflation index lookups and financial-year helpers. */

import { navSearch } from '../isin.js';

export { navSearch };

/** As notified by the Central Board of Direct Taxes. */
export const CII_DATA = {
  'FY2001-02': 100,
  'FY2002-03': 105,
  'FY2003-04': 109,
  'FY2004-05': 113,
  'FY2005-06': 117,
  'FY2006-07': 122,
  'FY2007-08': 129,
  'FY2008-09': 137,
  'FY2009-10': 148,
  'FY2010-11': 167,
  'FY2011-12': 184,
  'FY2012-13': 200,
  'FY2013-14': 220,
  'FY2014-15': 240,
  'FY2015-16': 254,
  'FY2016-17': 264,
  'FY2017-18': 272,
  'FY2018-19': 280,
  'FY2019-20': 289,
  'FY2020-21': 301,
  'FY2021-22': 317,
  'FY2022-23': 331,
  'FY2023-24': 348,
  'FY2024-25': 363,
  'FY2025-26': 376,
  'FY2026-27': 384,
};

/** The argument was not a financial year at all. */
export class InvalidFinancialYearError extends Error {}

/** A well-formed financial year that has no published index. */
export class UnknownFinancialYearError extends Error {}

const FY_RE = /FY\d{4}-\d{2,4}/;

class CostInflationIndex {
  constructor(data) {
    this.data = data;
    this.years = Object.keys(data).sort();
    this.minYear = this.years[0];
    this.maxYear = this.years[this.years.length - 1];
  }

  /**
   * The index for a financial year.
   *
   * A year before the series starts takes the first value and one after it takes the
   * last, so a statement from before indexation began, or from a year not yet notified,
   * still computes. Anything in between that is missing is an error rather than a guess.
   */
  get(key) {
    if (Object.prototype.hasOwnProperty.call(this.data, key)) return this.data[key];
    if (!FY_RE.test(String(key || ''))) {
      throw new InvalidFinancialYearError('Invalid FY year format.');
    }
    if (key <= this.minYear) return this.data[this.minYear];
    if (key >= this.maxYear) return this.data[this.maxYear];
    throw new UnknownFinancialYearError(key);
  }
}

export const CII = new CostInflationIndex(CII_DATA);

/**
 * The financial year a date falls in, as `FY2024-25`. April to March, so anything in the
 * first three months of a calendar year belongs to the year before.
 */
export function getFinYear(date) {
  let year1;
  let year2;
  if (date.month > 3) {
    year1 = date.year;
    year2 = date.year + 1;
  } else {
    year1 = date.year - 1;
    year2 = date.year;
  }
  if (year1 % 100 !== 99) year2 %= 100;
  return `FY${year1}-${String(year2).padStart(2, '0')}`;
}
