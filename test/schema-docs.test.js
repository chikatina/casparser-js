/**
 * Guards against the documentation drifting from the code.
 *
 * Two contracts: the generated schema files match what the field tables produce, and the
 * README names every enumeration member and every field it claims to describe. Both fail
 * loudly rather than quietly going stale.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { TransactionType } from '../src/enums.js';
import { MODELS } from '../src/types.js';
import { SCHEMA_DIR, buildSchemas } from '../scripts/generate-schema.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const README = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf-8');

/** The models the README sketches out, and so has to keep up with. */
const DOCUMENTED = [
  'StatementPeriod', 'InvestorInfo', 'TransactionData', 'SchemeValuation', 'Scheme',
  'Folio', 'CASData', 'DematOwner', 'Equity', 'Bond', 'MutualFund', 'DematAccount',
  'NSDLCASData',
];

/** A whole-word search, so a longer name does not satisfy a shorter one. */
function mentions(text, word) {
  return new RegExp(`(^|[^A-Za-z0-9_])${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^A-Za-z0-9_]|$)`)
    .test(text);
}

describe('the schema files', () => {
  it('match what the models produce', () => {
    for (const [stem, schema] of Object.entries(buildSchemas())) {
      const file = path.join(SCHEMA_DIR, `${stem}.schema.json`);
      assert.ok(fs.existsSync(file), `${stem}.schema.json is missing, run npm run schema`);
      assert.deepEqual(
        JSON.parse(fs.readFileSync(file, 'utf-8')),
        schema,
        `schema/${stem}.schema.json is stale, run npm run schema`,
      );
    }
  });
});

describe('the README', () => {
  it('lists every transaction type', () => {
    const missing = Object.keys(TransactionType).filter((name) => !mentions(README, name));
    assert.deepEqual(missing, [], `the transaction-type table is missing: ${missing}`);
  });

  for (const name of DOCUMENTED) {
    it(`documents every field of ${name}`, () => {
      const missing = MODELS[name].fieldNames.filter((field) => !mentions(README, field));
      assert.deepEqual(missing, [], `${name} fields missing from the README: ${missing}`);
    });
  }
});
