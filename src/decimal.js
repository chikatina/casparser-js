/**
 * Arbitrary-precision decimal arithmetic, following the same rules as Python's
 * `decimal.Decimal`.
 *
 * Money is the whole subject of this library, so binary floating point is not an option:
 * `0.1 + 0.2` has to be `0.3`, a unit balance printed as `1,000.000` has to compare equal
 * to `1000`, and a NAV quantised to four places has to stay at four places when it is
 * written back out. The Python original leaned on `decimal.Decimal` for all of that, and
 * the ported parsers are full of scale-sensitive arithmetic, so the port needs the same
 * semantics rather than something approximately like them.
 *
 * A value is `sign * coefficient * 10^exponent`, with the coefficient held as a BigInt.
 * That is the representation the General Decimal Arithmetic specification uses, and the
 * scale rules fall out of it:
 *
 *   add / subtract   exponent = min(exponent of the operands)
 *   multiply         exponent = sum of the exponents
 *   divide           exact when it terminates, otherwise 28 significant digits
 *
 * There is no dependency here on purpose. The app that consumes this library forbids
 * third-party JavaScript, and a decimal type is small enough to own.
 */

const PRECISION = 28;

export const ROUND_HALF_EVEN = 'ROUND_HALF_EVEN';
export const ROUND_HALF_UP = 'ROUND_HALF_UP';
export const ROUND_DOWN = 'ROUND_DOWN';
export const ROUND_UP = 'ROUND_UP';

const TEN = 10n;

function pow10(n) {
  return TEN ** BigInt(n);
}

function digitCount(value) {
  const v = value < 0n ? -value : value;
  if (v === 0n) return 1;
  return v.toString().length;
}

/** Splits a JS number into an exact `coefficient * 10^exponent` pair. */
function fromNumberExact(value) {
  if (!Number.isFinite(value)) throw new DecimalError(`cannot convert ${value} to Decimal`);
  if (Number.isInteger(value)) return new Decimal(BigInt(value), 0);

  // IEEE-754 doubles are binary fractions, so the exact decimal expansion is
  // mantissa * 2^exponent. Multiplying by 5^-exponent turns that into a decimal
  // coefficient without losing anything.
  const buffer = new DataView(new ArrayBuffer(8));
  buffer.setFloat64(0, value);
  const bits = buffer.getBigUint64(0);
  const sign = bits >> 63n ? -1n : 1n;
  const rawExponent = Number((bits >> 52n) & 0x7ffn);
  const rawMantissa = bits & 0xfffffffffffffn;

  let mantissa;
  let exponent;
  if (rawExponent === 0) {
    mantissa = rawMantissa;
    exponent = -1074;
  } else {
    mantissa = rawMantissa | (1n << 52n);
    exponent = rawExponent - 1075;
  }

  if (exponent >= 0) return new Decimal(sign * mantissa * (2n ** BigInt(exponent)), 0);
  return new Decimal(sign * mantissa * (5n ** BigInt(-exponent)), exponent);
}

export class DecimalError extends Error {}

export class Decimal {
  /**
   * @param {bigint|number|string|Decimal} coefficient signed coefficient, or a value to parse
   * @param {number} [exponent]
   */
  constructor(coefficient, exponent) {
    if (exponent === undefined) {
      const parsed = Decimal.parse(coefficient);
      this.c = parsed.c;
      this.e = parsed.e;
      return;
    }
    this.c = coefficient;
    this.e = exponent;
  }

  static parse(value) {
    if (value instanceof Decimal) return new Decimal(value.c, value.e);
    if (typeof value === 'bigint') return new Decimal(value, 0);
    if (typeof value === 'number') return fromNumberExact(value);
    if (value === null || value === undefined) throw new DecimalError('cannot convert null');

    const text = String(value).trim();
    const match = /^([+-]?)(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/.exec(text);
    if (!match || (!match[2] && !match[3])) {
      throw new DecimalError(`invalid decimal literal: ${JSON.stringify(text)}`);
    }
    const [, sign, whole, fraction = '', exponent = '0'] = match;
    const digits = `${whole}${fraction}` || '0';
    const scale = fraction.length;
    const coefficient = BigInt(digits) * (sign === '-' ? -1n : 1n);
    return new Decimal(coefficient, Number(exponent) - scale);
  }

  static from(value) {
    return value instanceof Decimal ? value : Decimal.parse(value);
  }

  /** `null` and `undefined` pass through, everything else is coerced. */
  static maybe(value) {
    return value === null || value === undefined ? null : Decimal.from(value);
  }

  get sign() {
    if (this.c > 0n) return 1;
    if (this.c < 0n) return -1;
    return 0;
  }

  isZero() {
    return this.c === 0n;
  }

  /** Rescales both operands to a shared exponent. */
  _align(other) {
    const exponent = Math.min(this.e, other.e);
    return [
      this.c * pow10(this.e - exponent),
      other.c * pow10(other.e - exponent),
      exponent,
    ];
  }

  add(value) {
    const other = Decimal.from(value);
    const [a, b, exponent] = this._align(other);
    return new Decimal(a + b, exponent);
  }

  sub(value) {
    const other = Decimal.from(value);
    const [a, b, exponent] = this._align(other);
    return new Decimal(a - b, exponent);
  }

  mul(value) {
    const other = Decimal.from(value);
    return new Decimal(this.c * other.c, this.e + other.e);
  }

  /**
   * Division, following the specification CPython implements: exact when the quotient
   * terminates, otherwise rounded to 28 significant digits.
   */
  div(value) {
    const other = Decimal.from(value);
    if (other.c === 0n) throw new DecimalError('division by zero');
    if (this.c === 0n) return new Decimal(0n, this.e - other.e);

    const sign = (this.c < 0n ? -1n : 1n) * (other.c < 0n ? -1n : 1n);
    const dividend = this.c < 0n ? -this.c : this.c;
    const divisor = other.c < 0n ? -other.c : other.c;

    const shift = digitCount(divisor) - digitCount(dividend) + PRECISION + 1;
    let exponent = this.e - other.e - shift;
    const scaled = shift >= 0 ? dividend * pow10(shift) : dividend / pow10(-shift);

    let coefficient = scaled / divisor;
    const remainder = scaled % divisor;

    if (remainder !== 0n) {
      // Nudge an exact-half result off the boundary so the rounding step below cannot
      // round the wrong way on a quotient that was never exactly half.
      if (coefficient % 5n === 0n) coefficient += 1n;
    } else {
      const ideal = this.e - other.e;
      while (exponent < ideal && coefficient % TEN === 0n) {
        coefficient /= TEN;
        exponent += 1;
      }
    }
    return new Decimal(sign * coefficient, exponent)._round(PRECISION, ROUND_HALF_EVEN);
  }

  /**
   * Remainder after truncating division, which is what Python's `Decimal %` gives: the
   * sign follows the dividend and the result is exact.
   */
  mod(value) {
    const other = Decimal.from(value);
    const [a, b, exponent] = this._align(other);
    if (b === 0n) throw new DecimalError('modulo by zero');
    return new Decimal(a % b, exponent);
  }

  neg() {
    return new Decimal(-this.c, this.e);
  }

  abs() {
    return this.c < 0n ? this.neg() : new Decimal(this.c, this.e);
  }

  /** -1, 0 or 1. */
  cmp(value) {
    const other = Decimal.from(value);
    const [a, b] = this._align(other);
    if (a < b) return -1;
    if (a > b) return 1;
    return 0;
  }

  eq(value) { return this.cmp(value) === 0; }
  ne(value) { return this.cmp(value) !== 0; }
  lt(value) { return this.cmp(value) < 0; }
  lte(value) { return this.cmp(value) <= 0; }
  gt(value) { return this.cmp(value) > 0; }
  gte(value) { return this.cmp(value) >= 0; }

  /** Rounds to at most `digits` significant digits. */
  _round(digits, rounding) {
    const present = digitCount(this.c);
    if (present <= digits) return this;
    return this._rescale(this.e + (present - digits), rounding);
  }

  /** Restates the value at a given exponent, rounding away whatever no longer fits. */
  _rescale(exponent, rounding = ROUND_HALF_EVEN) {
    if (exponent === this.e) return this;
    if (exponent < this.e) return new Decimal(this.c * pow10(this.e - exponent), exponent);

    const divisor = pow10(exponent - this.e);
    const negative = this.c < 0n;
    const magnitude = negative ? -this.c : this.c;
    let quotient = magnitude / divisor;
    const remainder = magnitude % divisor;

    if (remainder !== 0n) {
      const twice = remainder * 2n;
      switch (rounding) {
        case ROUND_DOWN:
          break;
        case ROUND_UP:
          quotient += 1n;
          break;
        case ROUND_HALF_UP:
          if (twice >= divisor) quotient += 1n;
          break;
        case ROUND_HALF_EVEN:
        default:
          if (twice > divisor || (twice === divisor && quotient % 2n === 1n)) quotient += 1n;
          break;
      }
    }
    return new Decimal(negative ? -quotient : quotient, exponent);
  }

  /**
   * Restates the value with the same exponent as `pattern`, the way
   * `Decimal.quantize` does.
   */
  quantize(pattern, rounding = ROUND_HALF_EVEN) {
    return this._rescale(Decimal.from(pattern).e, rounding);
  }

  /** `round(value, places)`, which for Decimal operands is half-even in Python. */
  round(places = 0, rounding = ROUND_HALF_EVEN) {
    return this._rescale(-places, rounding);
  }

  /** Drops trailing zeros without changing the value. */
  normalize() {
    if (this.c === 0n) return new Decimal(0n, 0);
    let coefficient = this.c;
    let exponent = this.e;
    while (coefficient % TEN === 0n) {
      coefficient /= TEN;
      exponent += 1;
    }
    return new Decimal(coefficient, exponent);
  }

  /** Truncates toward zero. */
  toBigInt() {
    return this._rescale(0, ROUND_DOWN).c;
  }

  toNumber() {
    return Number(this.toString());
  }

  toJSON() {
    return this.toString();
  }

  /** Matches Python's `str(Decimal)`, including its switch to exponential notation. */
  toString() {
    const negative = this.c < 0n;
    const digits = (negative ? -this.c : this.c).toString();
    const adjusted = this.e + digits.length - 1;
    let body;

    if (this.e <= 0 && adjusted >= -6) {
      if (this.e === 0) {
        body = digits;
      } else if (digits.length > -this.e) {
        const split = digits.length + this.e;
        body = `${digits.slice(0, split)}.${digits.slice(split)}`;
      } else {
        body = `0.${'0'.repeat(-this.e - digits.length)}${digits}`;
      }
    } else {
      const mantissa = digits.length > 1 ? `${digits[0]}.${digits.slice(1)}` : digits;
      const sign = adjusted >= 0 ? '+' : '-';
      body = `${mantissa}E${sign}${Math.abs(adjusted)}`;
    }
    return negative ? `-${body}` : body;
  }
}

export const ZERO = new Decimal(0n, 0);
export const ONE = new Decimal(1n, 0);

/** `Decimal(value)` with the terseness the parsers want. */
export function D(value) {
  return Decimal.from(value);
}

/** Sums an iterable of Decimals, starting at zero like Python's `sum(..., Decimal(0))`. */
export function sumDecimals(values, start = ZERO) {
  let total = start;
  for (const value of values) total = total.add(value);
  return total;
}

/** The largest of the given Decimals. */
export function maxDecimal(values) {
  let best = null;
  for (const value of values) {
    if (best === null || value.gt(best)) best = value;
  }
  return best;
}

/** The smallest of the given Decimals. */
export function minDecimal(values) {
  let best = null;
  for (const value of values) {
    if (best === null || value.lt(best)) best = value;
  }
  return best;
}
