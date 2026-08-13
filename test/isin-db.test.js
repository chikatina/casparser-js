/**
 * The reference-database lookups, run against a real SQLite database.
 *
 * The shipped database is close to fifty megabytes, so the fixture here is a handful of
 * rows in the same schema. What is being tested is the lookup logic: the ISIN-first
 * order, the registrar special cases, and the fuzzy fallback that picks between several
 * candidates.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  SqlIsinDb, defaultProcess, extractOne, ratio, tokenSortRatio,
} from '../src/isin-db.js';
import { Decimal } from '../src/decimal.js';

let DatabaseSync = null;
try {
  ({ DatabaseSync } = await import('node:sqlite'));
} catch {
  // Older runtimes have no built-in SQLite; the database-backed tests skip.
}

const SCHEMES = [
  [1, 'AXIS LONG TERM EQUITY FUND - DIRECT PLAN - GROWTH OPTION', 'INF846K01EW2', '120503', 'EQUITY', 'KARVY', '128TSDGG'],
  [2, 'AXIS LONG TERM EQUITY FUND - GROWTH OPTION', 'INF846K01131', '112323', 'EQUITY', 'KARVY', '128TSGG'],
  [3, 'HDFC TOP 100 FUND - DIRECT PLAN - GROWTH OPTION', 'INF179K01WK9', '118989', 'EQUITY', 'CAMS', 'HTHUNG'],
  [4, 'HDFC TOP 100 FUND - GROWTH OPTION', 'INF179K01BE2', '101762', 'EQUITY', 'CAMS', 'HTHUG'],
  [5, 'FRANKLIN INDIA FLEXI CAP FUND - GROWTH', 'INF090I01239', '100471', 'EQUITY', 'FRANKLIN', 'FTI2306'],
  // Two rows sharing one ISIN, which is what a renamed scheme leaves behind.
  [6, 'BANDHAN LIQUID FUND - GROWTH', 'INF194K01Y29', '119075', 'DEBT', 'CAMS', 'IDFCLFG'],
  [7, 'IDFC CASH FUND - GROWTH', 'INF194K01Y29', '119075', 'DEBT', 'CAMS', 'IDFCLFG'],
];

const SECURITIES = [
  ['INE002A01018', 'RELIANCE INDUSTRIES LIMITED', 'RELIANCE INDUSTRIES LIMITED', 'EQUITY SHARES', 'ACTIVE', 'RELIANCE', 'NSE'],
  ['INE111A07011', 'SOVEREIGN GOLD BOND', 'RBI', 'SOVEREIGN GOLD BOND', 'ACTIVE', null, null],
];

const NAVS = [['INF846K01EW2', '44.6503'], ['INF179K01WK9', '469.9210']];

/** A database in the shipped schema, with the rows above. */
function buildDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE scheme(id INTEGER NOT NULL PRIMARY KEY, name, isin, amfi_code, type,
                        rta, rta_code, amc_code, sebi_category, last_seen);
    CREATE TABLE nav20180131(isin NOT NULL PRIMARY KEY, nav);
    CREATE TABLE isin(isin NOT NULL PRIMARY KEY, name, issuer, type, status, symbol,
                      exchange, last_seen);
    CREATE INDEX idx_scheme_rta_code ON scheme(rta_code);
    CREATE INDEX idx_scheme_isin ON scheme(isin);
  `);

  const scheme = db.prepare(
    'INSERT INTO scheme(id, name, isin, amfi_code, type, rta, rta_code) VALUES (?, ?, ?, ?, ?, ?, ?)',
  );
  for (const row of SCHEMES) scheme.run(...row);

  const nav = db.prepare('INSERT INTO nav20180131(isin, nav) VALUES (?, ?)');
  for (const row of NAVS) nav.run(...row);

  const security = db.prepare(
    'INSERT INTO isin(isin, name, issuer, type, status, symbol, exchange) VALUES (?, ?, ?, ?, ?, ?, ?)',
  );
  for (const row of SECURITIES) security.run(...row);

  return new SqlIsinDb({
    query: (sql, params) => db.prepare(sql).all(params || {}),
  });
}

describe('string similarity', () => {
  it('reduces punctuation and case away', () => {
    assert.equal(defaultProcess('HDFC Top 100 Fund - Direct Plan'), 'hdfc top 100 fund   direct plan');
    assert.equal(defaultProcess(null), '');
  });

  it('scores identical strings at a hundred', () => {
    assert.equal(ratio('abc', 'abc'), 100);
    assert.equal(ratio('', ''), 100);
  });

  it('scores nothing in common at zero', () => {
    assert.equal(ratio('abc', 'xyz'), 0);
  });

  it('ignores word order once the words are sorted', () => {
    assert.equal(tokenSortRatio('direct growth axis', 'axis direct growth'), 100);
    assert.ok(tokenSortRatio('axis long term equity', 'axis long term debt') < 100);
  });

  it('picks the closest of several choices', () => {
    const best = extractOne('HDFC Top 100 Fund - Direct Growth', [
      'HDFC TOP 100 FUND - GROWTH OPTION',
      'HDFC TOP 100 FUND - DIRECT PLAN - GROWTH OPTION',
    ]);
    assert.equal(best.choice, 'HDFC TOP 100 FUND - DIRECT PLAN - GROWTH OPTION');
  });

  it('has nothing to pick from an empty list', () => {
    assert.equal(extractOne('anything', []), null);
  });
});

describe('database lookups', { skip: !DatabaseSync && 'node:sqlite is unavailable' }, () => {
  it('resolves a scheme from its registrar and code', () => {
    const db = buildDb();
    const found = db.isinLookup('Axis Long Term Equity Fund - Direct Growth', 'KFINTECH', '128TSDGG');
    assert.equal(found.isin, 'INF846K01EW2');
    assert.equal(found.amfi_code, '120503');
    assert.equal(found.type, 'EQUITY');
    assert.equal(found.score, 100);
  });

  it('prefers the ISIN when one is supplied', () => {
    const db = buildDb();
    const found = db.isinLookup('a name that matches nothing', 'BAD', 'nonsense', 'INF846K01EW2');
    assert.equal(found, null, 'an unknown registrar is refused outright');

    const viaIsin = db.isinLookup('a name that matches nothing', 'CAMS', 'nonsense', 'INF846K01EW2');
    assert.equal(viaIsin.isin, 'INF846K01EW2');
  });

  it('disambiguates two rows sharing an ISIN by name', () => {
    const db = buildDb();
    const found = db.isinLookup('IDFC Cash Fund - Growth', 'CAMS', 'IDFCLFG', 'INF194K01Y29');
    assert.equal(found.name, 'IDFC CASH FUND - GROWTH');
    assert.ok(found.score > 60);
  });

  it('narrows an HDFC code by plan, because the code is only a prefix', () => {
    const db = buildDb();
    const direct = db.isinLookup('HDFC Top 100 Fund - Direct Plan - Growth', 'CAMS', 'HTH');
    assert.equal(direct.isin, 'INF179K01WK9');

    const regular = db.isinLookup('HDFC Top 100 Fund - Growth', 'CAMS', 'HTH');
    assert.equal(regular.isin, 'INF179K01BE2');
  });

  it('looks a Franklin-shaped code up against that registrar first', () => {
    const db = buildDb();
    const found = db.isinLookup('Franklin India Flexi Cap Fund - Growth', 'CAMS', 'FTI2306');
    assert.equal(found.isin, 'INF090I01239');
  });

  it('retries once with the last character of the code trimmed', () => {
    const db = buildDb();
    const found = db.isinLookup('Axis Long Term Equity Fund - Direct Growth', 'KFINTECH', '128TSDGGX');
    assert.equal(found.isin, 'INF846K01EW2');
  });

  it('finds nothing when nothing matches', () => {
    const db = buildDb();
    assert.equal(db.isinLookup('', 'KARVY', ''), null);
    assert.equal(db.isinLookup('Unknown Fund', 'CAMS', 'NOSUCHCODE'), null);
  });

  it('refuses a registrar it does not know', () => {
    assert.equal(buildDb().isinLookup('anything', 'NOTANRTA', 'CODE'), null);
  });

  it('reads the 31 January 2018 value', () => {
    const db = buildDb();
    assert.ok(db.navLookup('INF846K01EW2').eq(Decimal.parse('44.6503')));
    assert.equal(db.navLookup('INF000X00X00'), null);
  });

  it('resolves security symbols in a batch, ignoring blanks and duplicates', () => {
    const db = buildDb();
    const found = db.batchIsinLookup(['INE002A01018', 'INE002A01018', '', 'INE111A07011', 'INE000X00X00']);
    assert.equal(found.get('INE002A01018').symbol, 'RELIANCE');
    assert.equal(found.get('INE002A01018').exchange, 'NSE');
    // A bond resolves, but with no symbol; the caller filters those out.
    assert.equal(found.get('INE111A07011').symbol, null);
    assert.ok(!found.has('INE000X00X00'));
  });
});
