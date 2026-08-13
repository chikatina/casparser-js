/**
 * The parsed shapes a statement reader returns.
 *
 * The Python original used pydantic. The rules that mattered were: coerce numbers to
 * Decimal, strip the Indian-format commas a statement prints inside them, keep date
 * fields as whatever arrived (a real date or the raw text), and serialise a couple of
 * fields under a different name (`from_` as `from`, `return_` as `return`). Those are
 * reproduced here without the dependency.
 */

import { Decimal } from './decimal.js';
import { coerceDateField } from './dates.js';

/** Field kinds a model can declare. */
const REQUIRED = Symbol('required');

function coerceDecimal(value, field) {
  if (value === null || value === undefined) return null;
  if (value instanceof Decimal) return value;
  if (typeof value === 'string') return Decimal.parse(value.replace(/,/g, '').trim());
  if (typeof value === 'number') return Decimal.parse(String(value));
  return Decimal.from(value);
}

function coerceString(value) {
  return value === null || value === undefined ? value : String(value);
}

function coerceInt(value) {
  if (value === null || value === undefined) return value;
  return Math.trunc(Number(value));
}

const COERCERS = {
  dec: coerceDecimal,
  str: coerceString,
  int: coerceInt,
  date: coerceDateField,
  any: (value) => value,
};

/**
 * Builds a model class from a field table.
 *
 * Each entry is `[name, kind, default, alias]`. `REQUIRED` as the default means the
 * field must be supplied, the way a pydantic field with no default does.
 */
function defineModel(name, fields) {
  const byAlias = new Map();
  for (const field of fields) {
    if (field.alias) byAlias.set(field.alias, field.name);
  }

  class Model {
    constructor(data = {}) {
      const source = { ...data };
      for (const [alias, target] of byAlias) {
        if (alias in source && !(target in source)) source[target] = source[alias];
      }
      for (const field of fields) {
        let value = source[field.name];
        if (value === undefined) {
          if (field.default === REQUIRED) {
            throw new TypeError(`${name}: missing required field ${field.name}`);
          }
          value = typeof field.default === 'function' ? field.default() : field.default;
        }
        const coerce = COERCERS[field.kind] || COERCERS.any;
        this[field.name] = coerce(value, field);
      }
    }

    /** Plain-object form, using serialisation aliases, for JSON output. */
    dump() {
      const out = {};
      for (const field of fields) {
        const key = field.alias || field.name;
        out[key] = dumpValue(this[field.name]);
      }
      return out;
    }

    toJSON() {
      return this.dump();
    }
  }

  Object.defineProperty(Model, 'name', { value: name });
  Model.fields = fields;
  Model.fieldNames = fields.map((f) => f.alias || f.name);
  return Model;
}

function dumpValue(value) {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map(dumpValue);
  if (typeof value === 'object' && typeof value.dump === 'function') return value.dump();
  if (typeof value === 'object' && typeof value.toJSON === 'function') return value.toJSON();
  return value;
}

const field = (name, kind, def = REQUIRED, alias = null) => ({ name, kind, default: def, alias });
const list = () => [];

export const StatementPeriod = defineModel('StatementPeriod', [
  field('from_', 'str', REQUIRED, 'from'),
  field('to', 'str'),
]);

export const InvestorInfo = defineModel('InvestorInfo', [
  field('name', 'str'),
  field('email', 'str'),
  field('address', 'str'),
  field('mobile', 'str'),
]);

export const TransactionData = defineModel('TransactionData', [
  field('date', 'date'),
  field('description', 'str'),
  field('amount', 'dec', null),
  field('units', 'dec', null),
  field('nav', 'dec', null),
  field('balance', 'dec', null),
  field('type', 'str'),
  field('dividend_rate', 'dec', null),
  // For a gift transfer, the folio named on the other side of it. Lets a donor's
  // statement be linked to the donee's across two files.
  field('gift_folio', 'str', null),
]);

export const SchemeValuation = defineModel('SchemeValuation', [
  field('date', 'date'),
  field('nav', 'dec'),
  field('cost', 'dec', null),
  field('value', 'dec'),
]);

export const Scheme = defineModel('Scheme', [
  field('scheme', 'str'),
  field('advisor', 'str', null),
  field('rta_code', 'str'),
  field('rta', 'str'),
  field('type', 'str', null),
  field('isin', 'str', null),
  field('amfi', 'str', null),
  field('nominees', 'any', list),
  field('open', 'dec'),
  field('close', 'dec'),
  field('close_calculated', 'dec'),
  field('valuation', 'any'),
  field('transactions', 'any', list),
]);

export const Folio = defineModel('Folio', [
  field('folio', 'str'),
  field('amc', 'str'),
  field('PAN', 'str', null),
  field('KYC', 'str', null),
  field('PANKYC', 'str', null),
  field('schemes', 'any', list),
]);

export const CASData = defineModel('CASData', [
  field('statement_period', 'any'),
  field('folios', 'any', list),
  field('investor_info', 'any'),
  field('cas_type', 'str'),
  field('file_type', 'str'),
  // Non-fatal data-quality warnings raised while parsing. A non-empty list means a
  // transaction row was probably dropped or mis-read: the parse still returns, but the
  // affected scheme should not be trusted without a look.
  field('parse_warnings', 'any', list),
]);

export const DematOwner = defineModel('DematOwner', [
  field('name', 'str'),
  field('PAN', 'str'),
]);

export const Equity = defineModel('Equity', [
  field('name', 'str', null),
  field('isin', 'str'),
  field('num_shares', 'dec'),
  field('price', 'dec'),
  field('value', 'dec'),
  // Depository statements name an equity by ISIN alone. The trading symbol and its
  // exchange are filled in afterwards from the ISIN database, so a holding can be priced
  // from a symbol-keyed feed.
  field('symbol', 'str', null),
  field('exchange', 'str', null),
]);

export const Bond = defineModel('Bond', [
  field('name', 'str', null),
  field('isin', 'str'),
  field('num_bonds', 'dec'),
  field('value', 'dec'),
  field('face_value', 'dec', null),
  field('coupon_rate', 'dec', null),
  field('coupon_frequency', 'str', null),
  field('maturity_date', 'str', null),
  field('market_price', 'dec', null),
]);

export const MutualFund = defineModel('MutualFund', [
  field('name', 'str', null),
  field('isin', 'str'),
  // Depository statements carry no AMFI code or scheme type for a fund holding, only its
  // ISIN. Both are filled in from the ISIN database after parsing so the holding lines up
  // with the same scheme read from a registrar statement.
  field('amfi', 'str', null),
  field('type', 'str', null),
  field('balance', 'dec'),
  field('nav', 'dec'),
  field('value', 'dec'),
  field('avg_cost', 'dec', null),
  field('total_cost', 'dec', null),
  field('ucc', 'str', null),
  field('folio', 'str', null),
  field('pnl', 'dec', null),
  field('return_', 'dec', null, 'return'),
]);

export const DematAccount = defineModel('DematAccount', [
  field('name', 'str'),
  field('type', 'str'),
  field('dp_id', 'str', ''),
  field('client_id', 'str', ''),
  field('folios', 'int'),
  field('balance', 'dec'),
  field('owners', 'any', list),
  field('equities', 'any', list),
  field('mutual_funds', 'any', list),
  field('bonds', 'any', list),
]);

export const NPSScheme = defineModel('NPSScheme', [
  field('scheme', 'str'),
  field('fund_manager', 'str', null),
  field('tier', 'str', null),
  field('asset_class', 'str', null),
  field('units', 'dec'),
  field('nav', 'dec'),
  field('value', 'dec'),
]);

export const NPSAccount = defineModel('NPSAccount', [
  field('pran', 'str', null),
  field('nps_sp', 'str', null),
  field('value', 'dec'),
  field('schemes', 'any', list),
]);

export const NSDLCASData = defineModel('NSDLCASData', [
  field('accounts', 'any', list),
  field('statement_period', 'any'),
  field('investor_info', 'any'),
  field('file_type', 'str'),
  // National Pension System holdings, when the statement carries an NPS section. The
  // holdings only; the transaction ledger is deliberately not read.
  field('nps', 'any', null),
  field('parse_warnings', 'any', list),
]);

export const MODELS = {
  StatementPeriod,
  InvestorInfo,
  TransactionData,
  SchemeValuation,
  Scheme,
  Folio,
  CASData,
  DematOwner,
  Equity,
  Bond,
  MutualFund,
  DematAccount,
  NPSScheme,
  NPSAccount,
  NSDLCASData,
};
