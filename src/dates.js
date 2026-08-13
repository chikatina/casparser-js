/**
 * A calendar date with no time and no zone, matching Python's `datetime.date`.
 *
 * `Date` is the wrong tool here: it carries a time and a zone, so a statement date of
 * 31-Mar-2026 read on a machine west of UTC becomes 30-Mar, which silently moves a
 * transaction into the previous financial year. Statements only ever carry calendar
 * dates, so that is what this holds.
 */

const MONTHS = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

const MONTH_NAMES = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

function isLeap(year) {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

function daysInMonth(year, month) {
  if (month === 2) return isLeap(year) ? 29 : 28;
  return [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
}

export class CasDate {
  constructor(year, month, day) {
    this.year = year;
    this.month = month;
    this.day = day;
  }

  static today() {
    const now = new Date();
    return new CasDate(now.getFullYear(), now.getMonth() + 1, now.getDate());
  }

  /**
   * Reads the date formats consolidated statements actually use: ISO, `25-Oct-2021`,
   * `25 Oct 2021`, `25/10/2021`. Anything else throws, rather than guessing.
   */
  static parse(value) {
    if (value instanceof CasDate) return value;
    if (value instanceof Date) {
      return new CasDate(value.getFullYear(), value.getMonth() + 1, value.getDate());
    }
    const text = String(value).trim();

    let match = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(text);
    if (match) return new CasDate(Number(match[1]), Number(match[2]), Number(match[3]));

    match = /^(\d{1,2})[-\s/]([A-Za-z]{3,})[-\s/](\d{4})$/.exec(text);
    if (match) {
      const month = MONTHS[match[2].slice(0, 3).toLowerCase()];
      if (month) return new CasDate(Number(match[3]), month, Number(match[1]));
    }

    match = /^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/.exec(text);
    if (match) return new CasDate(Number(match[3]), Number(match[2]), Number(match[1]));

    match = /^([A-Za-z]{3,})[-\s](\d{1,2}),?\s*(\d{4})$/.exec(text);
    if (match) {
      const month = MONTHS[match[1].slice(0, 3).toLowerCase()];
      if (month) return new CasDate(Number(match[3]), month, Number(match[2]));
    }

    throw new Error(`Unrecognised date: ${JSON.stringify(text)}`);
  }

  /** `parse`, but `null` for anything unreadable. */
  static tryParse(value) {
    try {
      return CasDate.parse(value);
    } catch {
      return null;
    }
  }

  /** Days since the epoch, so two dates can be compared or subtracted as integers. */
  get ordinal() {
    const y = this.month <= 2 ? this.year - 1 : this.year;
    const era = Math.floor(y / 400);
    const yearOfEra = y - era * 400;
    const monthShift = this.month > 2 ? this.month - 3 : this.month + 9;
    const dayOfYear = Math.floor((153 * monthShift + 2) / 5) + this.day - 1;
    const dayOfEra = yearOfEra * 365 + Math.floor(yearOfEra / 4)
      - Math.floor(yearOfEra / 100) + dayOfYear;
    return era * 146097 + dayOfEra - 719468;
  }

  static fromOrdinal(days) {
    let z = days + 719468;
    const era = Math.floor(z / 146097);
    const dayOfEra = z - era * 146097;
    const yearOfEra = Math.floor(
      (dayOfEra - Math.floor(dayOfEra / 1460) + Math.floor(dayOfEra / 36524)
        - Math.floor(dayOfEra / 146096)) / 365,
    );
    const year = yearOfEra + era * 400;
    const dayOfYear = dayOfEra - (365 * yearOfEra + Math.floor(yearOfEra / 4)
      - Math.floor(yearOfEra / 100));
    const monthShift = Math.floor((5 * dayOfYear + 2) / 153);
    const day = dayOfYear - Math.floor((153 * monthShift + 2) / 5) + 1;
    const month = monthShift < 10 ? monthShift + 3 : monthShift - 9;
    return new CasDate(month <= 2 ? year + 1 : year, month, day);
  }

  addDays(days) {
    return CasDate.fromOrdinal(this.ordinal + days);
  }

  /** Calendar-aware month arithmetic, clamping 31-Jan + 1 month to 28/29-Feb. */
  addMonths(months) {
    const total = (this.year * 12 + (this.month - 1)) + months;
    const year = Math.floor(total / 12);
    const month = (total % 12) + 1;
    return new CasDate(year, month, Math.min(this.day, daysInMonth(year, month)));
  }

  /** What `relativedelta(years=n)` does: same day next year, 29-Feb clamped to 28. */
  addYears(years) {
    const year = this.year + years;
    return new CasDate(year, this.month, Math.min(this.day, daysInMonth(year, this.month)));
  }

  cmp(other) {
    const a = this.ordinal;
    const b = CasDate.parse(other).ordinal;
    return a < b ? -1 : a > b ? 1 : 0;
  }

  lt(other) { return this.cmp(other) < 0; }
  lte(other) { return this.cmp(other) <= 0; }
  gt(other) { return this.cmp(other) > 0; }
  gte(other) { return this.cmp(other) >= 0; }
  eq(other) { return this.cmp(other) === 0; }

  /** Days from `other` to this date. */
  minus(other) {
    return this.ordinal - CasDate.parse(other).ordinal;
  }

  /** ISO, which is what `str(datetime.date)` gives. */
  toString() {
    const pad = (n) => String(n).padStart(2, '0');
    return `${String(this.year).padStart(4, '0')}-${pad(this.month)}-${pad(this.day)}`;
  }

  toJSON() {
    return this.toString();
  }

  /** `25-Oct-2021`, the shape statements print. */
  toStatementString() {
    return `${String(this.day).padStart(2, '0')}-${MONTH_NAMES[this.month - 1]}-${this.year}`;
  }
}

/**
 * A date field on a parsed model. Statements hand us both real dates and raw strings, and
 * the Python models kept whichever arrived (`Union[date, str]`), so this does too.
 */
export function coerceDateField(value) {
  if (value === null || value === undefined) return value;
  if (value instanceof CasDate) return value;
  if (value instanceof Date) return CasDate.parse(value);
  return String(value);
}

/** The date value as a `CasDate`, whether it was stored as one or as text. */
export function asDate(value) {
  return value instanceof CasDate ? value : CasDate.parse(value);
}
