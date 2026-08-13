#!/usr/bin/env node
/**
 * Writes the machine-readable contract for the shapes this library emits.
 *
 * The README describes the output for a reader; `schema/*.schema.json` describes it for a
 * program, and both are generated from the same field tables so neither can quietly drift
 * from the code. `test/schema-docs.test.js` fails when the checked-in files fall behind,
 * so a forgotten regeneration is caught rather than shipped.
 *
 *     node scripts/generate-schema.js
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { CASData, MODELS, NSDLCASData } from '../src/types.js';
import { TransactionType } from '../src/enums.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const SCHEMA_DIR = path.join(ROOT, 'schema');

const DIALECT = 'https://json-schema.org/draft/2020-12/schema';

/**
 * Which model each object-valued field holds. The field tables record how to coerce a
 * value, not what shape it is, so the nesting is declared here.
 */
const NESTED = {
  StatementPeriod: {},
  InvestorInfo: {},
  TransactionData: {},
  SchemeValuation: {},
  Scheme: { valuation: 'SchemeValuation', transactions: ['TransactionData'], nominees: ['string'] },
  Folio: { schemes: ['Scheme'] },
  CASData: {
    statement_period: 'StatementPeriod',
    folios: ['Folio'],
    investor_info: 'InvestorInfo',
    parse_warnings: ['string'],
  },
  DematOwner: {},
  Equity: {},
  Bond: {},
  MutualFund: {},
  DematAccount: {
    owners: ['DematOwner'], equities: ['Equity'], mutual_funds: ['MutualFund'], bonds: ['Bond'],
  },
  NPSScheme: {},
  NPSAccount: { schemes: ['NPSScheme'] },
  NSDLCASData: {
    accounts: ['DematAccount'],
    statement_period: 'StatementPeriod',
    investor_info: 'InvestorInfo',
    nps: 'NPSAccount',
    parse_warnings: ['string'],
  },
};

/** A decimal is emitted as a string, so no precision is lost on the way out. */
const KIND_TYPES = {
  dec: { type: 'string', description: 'A decimal number, as a string so nothing is rounded away' },
  str: { type: 'string' },
  int: { type: 'integer' },
  date: { type: 'string', description: 'A calendar date, or the text the statement printed' },
  any: {},
};

function fieldSchema(model, field) {
  const nested = NESTED[model.name] || {};
  const key = field.alias || field.name;
  const shape = nested[field.name] ?? nested[key];

  if (Array.isArray(shape)) {
    const [item] = shape;
    return {
      type: 'array',
      items: item === 'string' ? { type: 'string' } : { $ref: `#/$defs/${item}` },
    };
  }
  if (typeof shape === 'string') return { $ref: `#/$defs/${shape}` };
  if (field.name === 'type' && model.name === 'TransactionData') {
    return { type: 'string', enum: Object.keys(TransactionType) };
  }
  return { ...(KIND_TYPES[field.kind] || {}) };
}

function modelSchema(model) {
  const properties = {};
  const required = [];
  for (const field of model.fields) {
    const key = field.alias || field.name;
    properties[key] = fieldSchema(model, field);
    if (field.default !== undefined && typeof field.default === 'symbol') required.push(key);
  }
  return {
    title: model.name, type: 'object', properties, required,
  };
}

/** Every model reachable from a root, so the definitions are self-contained. */
function collectDefs(root, models, seen = {}) {
  if (seen[root.name]) return seen;
  seen[root.name] = modelSchema(root);
  const nested = NESTED[root.name] || {};
  for (const shape of Object.values(nested)) {
    const name = Array.isArray(shape) ? shape[0] : shape;
    if (name && name !== 'string' && models[name]) collectDefs(models[name], models, seen);
  }
  return seen;
}

/** One schema per public top-level shape, named after it. */
export function buildSchemas() {
  const out = {};
  for (const root of [CASData, NSDLCASData]) {
    const defs = collectDefs(root, MODELS);
    const { [root.name]: rootSchema, ...rest } = defs;
    out[root.name] = { $schema: DIALECT, ...rootSchema, $defs: rest };
  }
  return out;
}

function main() {
  fs.mkdirSync(SCHEMA_DIR, { recursive: true });
  for (const [stem, schema] of Object.entries(buildSchemas())) {
    const file = path.join(SCHEMA_DIR, `${stem}.schema.json`);
    fs.writeFileSync(file, `${JSON.stringify(schema, null, 2)}\n`);
    console.log(`wrote schema/${stem}.schema.json`);
  }
}

if (process.argv[1] && process.argv[1].endsWith('generate-schema.js')) {
  await main();
}
