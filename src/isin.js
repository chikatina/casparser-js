/**
 * ISIN lookups, behind a provider you supply.
 *
 * The Python original depended on `casparser-isin`, which ships a ~50 MB SQLite database
 * of every Indian mutual-fund scheme. Bundling that into a JavaScript library would put
 * the database in every consumer whether or not it wants one, and the app this was
 * written for cannot afford it at all. So the lookups are an interface: register a
 * provider and schemes get their ISIN, AMFI code, type and 31-Jan-2018 fair market value
 * filled in; register nothing and those fields come back null and everything else still
 * parses.
 *
 * A provider implements as much of this as it can:
 *
 *   isinLookup(schemeName, rta, rtaCode, isin) -> {isin, amfi_code, type} | null
 *   directIsinLookup(isin)                     -> [{isin, amfi_code, type}] | null
 *   navLookup(isin)                            -> Decimal | null
 *   batchIsinLookup(isins)                     -> Map<isin, {symbol, exchange}>
 */

import { Decimal } from './decimal.js';

let provider = null;

/** Installs the ISIN database this process should use. Pass `null` to remove it. */
export function setIsinProvider(next) {
  provider = next || null;
}

export function getIsinProvider() {
  return provider;
}

function callProvider(method, ...args) {
  if (!provider || typeof provider[method] !== 'function') return null;
  try {
    return provider[method](...args);
  } catch {
    return null;
  }
}

/**
 * Resolves `(isin, amfi, type)` for a scheme.
 *
 * The name-and-code lookup comes first. When it misses and the caller parsed an ISIN out
 * of the scheme header, fall back to that: it sidesteps a mis-read `Registrar:` value,
 * which is the usual reason the primary lookup fails.
 */
export function isinSearch(schemeName, rta, rtaCode, isin = null) {
  const direct = callProvider('isinLookup', schemeName, rta, rtaCode, isin);
  if (direct && direct.isin) return [direct.isin, direct.amfi_code ?? null, direct.type ?? null];

  if (isin) {
    const rows = callProvider('directIsinLookup', isin);
    if (rows && rows.length) {
      const row = rows[0];
      return [row.isin ?? null, row.amfi_code ?? null, row.type ?? null];
    }
  }
  return [null, null, null];
}

/**
 * Maps each ISIN to `[amfiCode, schemeType]` in one pass.
 *
 * Used to enrich demat fund holdings, which a depository statement identifies by ISIN
 * alone, so they line up with the same scheme read from a registrar statement.
 */
export function batchIsinMetadata(isins) {
  const result = new Map();
  const unique = new Set();
  for (const isin of isins) {
    if (isin) unique.add(isin);
  }
  if (!unique.size) return result;

  for (const isin of unique) {
    const rows = callProvider('directIsinLookup', isin);
    if (rows && rows.length) {
      const row = rows[0];
      result.set(isin, [row.amfi_code ?? null, row.type ?? null]);
    } else {
      result.set(isin, [null, null]);
    }
  }
  return result;
}

/**
 * Maps each equity ISIN to `[symbol, exchange]`.
 *
 * Only ISINs the database resolves and that carry a symbol appear. A bond, an unlisted
 * instrument, or a database built before the symbol columns existed is simply absent.
 */
export function batchEquitySymbols(isins) {
  const result = new Map();
  const wanted = [...isins].filter(Boolean);
  if (!wanted.length) return result;

  const rows = callProvider('batchIsinLookup', wanted);
  if (!rows) return result;

  const entries = rows instanceof Map ? rows.entries() : Object.entries(rows);
  for (const [isin, data] of entries) {
    if (data && data.symbol) result.set(isin, [data.symbol, data.exchange ?? null]);
  }
  return result;
}

/** The scheme's 31-Jan-2018 net asset value, used for grandfathered capital gains. */
export function navSearch(isin) {
  const value = callProvider('navLookup', isin);
  return value === null || value === undefined ? null : Decimal.from(value);
}

/**
 * A provider backed by plain objects, for tests and for callers that carry a small
 * curated table rather than the full database.
 */
export class MemoryIsinDb {
  /**
   * @param {Array<object>} rows each `{isin, amfi_code, type, scheme, rta, rta_code,
   *   symbol, exchange, nav}`
   */
  constructor(rows = []) {
    this.rows = rows;
    this.byIsin = new Map();
    for (const row of rows) {
      if (row.isin) this.byIsin.set(row.isin, row);
    }
  }

  static normaliseName(name) {
    return String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  }

  isinLookup(schemeName, rta, rtaCode) {
    const wantedName = MemoryIsinDb.normaliseName(schemeName);
    const wantedRta = String(rta || '').toUpperCase();
    const wantedCode = String(rtaCode || '').toUpperCase();
    if (!wantedName && !wantedCode) return null;

    for (const row of this.rows) {
      if (row.rta && String(row.rta).toUpperCase() !== wantedRta) continue;
      const codeMatches = row.rta_code
        && String(row.rta_code).toUpperCase() === wantedCode;
      const nameMatches = row.scheme
        && MemoryIsinDb.normaliseName(row.scheme) === wantedName;
      if (codeMatches || (nameMatches && wantedName)) return row;
    }
    return null;
  }

  directIsinLookup(isin) {
    const row = this.byIsin.get(isin);
    return row ? [row] : null;
  }

  navLookup(isin) {
    const row = this.byIsin.get(isin);
    return row && row.nav !== undefined && row.nav !== null ? Decimal.from(row.nav) : null;
  }

  batchIsinLookup(isins) {
    const out = new Map();
    for (const isin of isins) {
      const row = this.byIsin.get(isin);
      if (row) out.set(isin, { symbol: row.symbol ?? null, exchange: row.exchange ?? null });
    }
    return out;
  }
}
