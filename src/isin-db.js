/**
 * The ISIN database lookups, ported from `casparser-isin`.
 *
 * This is the half of the problem a statement cannot answer on its own. A registrar
 * prints a scheme's name and its own internal code but not the ISIN, the AMFI code or
 * whether the scheme is equity or debt; a depository prints the ISIN and nothing else.
 * The reference database closes both gaps, and it also carries each scheme's value on 31
 * January 2018, which is what the grandfathering rule for long-term equity gains needs.
 *
 * No storage engine is assumed. Supply a `query(sql, params)` that runs a statement with
 * named parameters and returns rows as plain objects, and this works against whatever
 * holds the data: SQLite in a browser or a WebView, better-sqlite3 under Node, or a
 * prepared in-memory table.
 *
 * The tables it expects are the ones the reference database defines:
 *
 *   scheme(id, name, isin, amfi_code, type, rta, rta_code)
 *   nav20180131(isin, nav)
 *   isin(isin, name, issuer, type, status, symbol, exchange)
 */

import { Decimal } from './decimal.js';

/**
 * Registrar names as the database stores them. A statement writes the current trading
 * name; the database kept the older one for two of them.
 */
const RTA_MAP = {
  CAMS: 'CAMS',
  FTAMIL: 'FRANKLIN',
  FRANKLIN: 'FRANKLIN',
  KFINTECH: 'KARVY',
  KARVY: 'KARVY',
};

/**
 * Lowercase, and everything that is not a letter or a digit becomes a space.
 *
 * This is what makes the fuzzy match work on names that differ only in punctuation:
 * "HDFC Top 100 Fund - Direct Plan" and "HDFC TOP 100 FUND-DIRECT PLAN" reduce to the
 * same token stream.
 */
export function defaultProcess(text) {
  return String(text ?? '').replace(/[^a-zA-Z0-9]/g, ' ').trim().toLowerCase();
}

/** The length of the longest common subsequence of two strings. */
function longestCommonSubsequence(a, b) {
  if (!a.length || !b.length) return 0;
  let previous = new Uint32Array(b.length + 1);
  let current = new Uint32Array(b.length + 1);

  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      current[j] = a[i - 1] === b[j - 1]
        ? previous[j - 1] + 1
        : Math.max(previous[j], current[j - 1]);
    }
    const swap = previous;
    previous = current;
    current = swap;
    current.fill(0);
  }
  return previous[b.length];
}

/**
 * Similarity of two strings on a nought-to-a-hundred scale, as the ratio of the longest
 * common subsequence to the combined length. Two identical strings score a hundred.
 */
export function ratio(a, b) {
  if (!a.length && !b.length) return 100;
  const common = longestCommonSubsequence(a, b);
  return (2 * common * 100) / (a.length + b.length);
}

/**
 * Similarity after sorting each side's words.
 *
 * Registrar-emitted scheme names reorder their modifiers freely: "Direct Growth" against
 * "Growth - Direct Plan" is the same scheme written two ways, and comparing them in
 * order would score them apart.
 */
export function tokenSortRatio(a, b) {
  const sorted = (text) => text.split(/\s+/).filter(Boolean).sort().join(' ');
  return ratio(sorted(a), sorted(b));
}

/** The best of `choices` against `query`, or null when the list is empty. */
export function extractOne(query, choices, scorer = tokenSortRatio) {
  const processed = defaultProcess(query);
  let best = null;
  for (const choice of choices) {
    const score = scorer(processed, defaultProcess(choice));
    if (best === null || score > best.score) best = { choice, score };
  }
  return best;
}

/** A scheme could not be resolved. */
export class SchemeNotFoundError extends Error {}

export class SqlIsinDb {
  /**
   * @param {object} options
   * @param {(sql: string, params: object) => Array<object>} options.query runs a
   *   statement with named `:parameters` and returns rows as objects
   * @param {number} [options.minScore] the fuzzy score a name match must reach
   */
  constructor({ query, minScore = 60 }) {
    if (typeof query !== 'function') throw new TypeError('SqlIsinDb needs a query function');
    this._query = query;
    this.minScore = minScore;
  }

  /**
   * Runs a statement with only the parameters it actually names.
   *
   * The registrar special cases build their `WHERE` clause conditionally, so the
   * parameter object can carry names the final statement never mentions. Some drivers
   * shrug at that and some refuse outright, so the extras are dropped here rather than
   * left for the adapter to cope with.
   */
  query(sql, params = {}) {
    const named = new Set((sql.match(/:[A-Za-z_][A-Za-z0-9_]*/g) || []).map((m) => m.slice(1)));
    const used = {};
    for (const [key, value] of Object.entries(params)) {
      if (named.has(key)) used[key] = value;
    }
    return this._query(sql, used) || [];
  }

  /** Every scheme row carrying this ISIN, newest first. */
  directIsinLookup(isin) {
    return this.query(
      'SELECT name, isin, amfi_code, type FROM scheme WHERE isin = :isin ORDER BY id DESC',
      { isin },
    );
  }

  /**
   * Scheme rows for a registrar and its internal code.
   *
   * Two houses need special handling. Franklin schemes moved registrar but kept their old
   * codes, so a Franklin-shaped code is tried against that registrar first. HDFC codes are
   * prefixes whose suffix encodes the plan and the option, so they are matched by prefix
   * and the plan is narrowed using the scheme name.
   */
  schemeLookup(rta, schemeName, rtaCode) {
    const code = String(rtaCode).replace(/\s+/g, '');
    const select = 'SELECT name, isin, amfi_code, type FROM scheme';
    const where = ['rta = :rta'];
    const params = {};

    if (/fti\d+/i.test(code) && ['CAMS', 'FRANKLIN', 'FTAMIL'].includes(rta.toUpperCase())) {
      const results = this.query(
        `${select} WHERE rta = :rta AND rta_code = :rta_code`,
        { rta: 'FRANKLIN', rta_code: code },
      );
      if (results.length) return results;
    }

    params.rta = RTA_MAP[rta.toUpperCase()] || '';
    params.rta_code = code;

    if (schemeName.toLowerCase().includes('hdfc')) {
      if (/direct/i.test(schemeName)) {
        where.push('name LIKE :direct_pattern');
        params.direct_pattern = '%direct%';
      } else {
        where.push('name NOT LIKE :direct_pattern');
        params.direct_pattern = '%direct%';
      }
      if (/dividend|idcw/i.test(schemeName)) {
        where.push('name LIKE :payout_pattern');
        params.payout_pattern = /re-*invest/i.test(schemeName) ? '%reinvest%' : '%payout%';
      }
      where.push('rta_code LIKE :rta_code_d');
      params.rta_code_d = `${code}%`;
    } else {
      where.push('rta_code = :rta_code');
    }

    const sql = `${select} WHERE ${where.join(' AND ')} ORDER BY id DESC`;
    let results = this.query(sql, params);
    if (!results.length && params.rta_code) {
      // Older statements sometimes print one character too many on the code.
      params.rta_code = params.rta_code.slice(0, -1);
      results = this.query(sql, params);
    }
    return results;
  }

  /**
   * The closest matching scheme.
   *
   * The ISIN is tried first when there is one, because every statement of the last few
   * years prints it and it is unambiguous. Failing that, the registrar and its code, which
   * is what older statements have. Where either returns several candidates, the scheme
   * name decides between them.
   *
   * @returns {{name, isin, amfi_code, type, score}|null}
   */
  isinLookup(schemeName, rta, rtaCode, isin = null) {
    if (typeof schemeName !== 'string' || typeof rta !== 'string' || typeof rtaCode !== 'string') {
      return null;
    }
    if (!RTA_MAP[rta.toUpperCase()]) return null;

    let results = [];
    if (isin) results = this.directIsinLookup(isin) || [];
    if (!results.length) results = this.schemeLookup(rta, schemeName, rtaCode) || [];

    if (results.length === 1) {
      const row = results[0];
      return { ...row, score: 100 };
    }
    if (results.length > 1) {
      const byName = new Map(results.map((row) => [row.name, row]));
      const best = extractOne(schemeName, byName.keys());
      if (best && best.score >= this.minScore) {
        return { ...byName.get(best.choice), score: best.score };
      }
    }
    return null;
  }

  /** The scheme's value on 31 January 2018, used for grandfathered gains. */
  navLookup(isin) {
    const rows = this.query('SELECT nav FROM nav20180131 WHERE isin = :isin', { isin });
    if (!rows || !rows.length) return null;
    return Decimal.from(rows[0].nav);
  }

  /** One row per resolvable ISIN, for the security table rather than the scheme table. */
  batchIsinLookup(isins) {
    const result = new Map();
    const unique = new Set([...isins].filter(Boolean));
    for (const isin of unique) {
      const rows = this.query(
        'SELECT isin, name, issuer, type, status, symbol, exchange FROM isin WHERE isin = :isin',
        { isin },
      );
      if (rows && rows.length) result.set(isin, rows[0]);
    }
    return result;
  }
}
