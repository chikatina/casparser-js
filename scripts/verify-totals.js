#!/usr/bin/env node
/*
 * Adds up what the parser read and checks it against what the statement says.
 *
 * Only totals are printed. No holding is named, no ISIN, no account number, so the output
 * is safe to paste. If a figure is wrong this says which bucket is wrong and by how much,
 * which is the whole diagnosis.
 *
 *   node scripts/verify-totals.js statement.pdf --password SECRET
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { readCasPdf } from '../src/parsers/index.js';
import { createPdfjsBackend } from '../src/pdf/pdfjs.js';
import { setPdfBackend } from '../src/pdf/backend.js';

// What the statement itself prints, for comparison.
const EXPECTED = {
  Equities: 1259694.68,
  'Mutual funds (demat)': 1916941,
  'Government securities': 156935.68,
  'Mutual fund folios': 128275.06,
  NPS: 201956.61,
};
const EXPECTED_TOTAL = 3663803.11;

const num = (value) => Number(value ?? 0);
const money = (value) => value.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const isGovernment = (isin) => /^IN[0-9]/i.test(String(isin || ''));

async function main() {
  const args = process.argv.slice(2);
  const file = args.find((a) => !a.startsWith('--'));
  const at = args.indexOf('--password');
  const password = at >= 0 ? args[at + 1] : '';

  if (!file) {
    console.error('usage: node scripts/verify-totals.js statement.pdf --password SECRET');
    process.exit(2);
  }

  const pdfjsLib = await import('pdfjs-dist/legacy/build/pdf.mjs').catch(() => null);
  if (!pdfjsLib) {
    console.error('pdf.js is not installed here. Run: npm install pdfjs-dist');
    process.exit(2);
  }

  const here = path.dirname(fileURLToPath(import.meta.url));
  const distributed = path.join(here, '..', 'node_modules', 'pdfjs-dist');
  const asUrl = (...parts) => `${path.join(...parts).replace(/\\/g, '/')}/`;
  setPdfBackend(createPdfjsBackend(pdfjsLib, {
    documentOptions: {
      standardFontDataUrl: asUrl(distributed, 'standard_fonts'),
      cMapUrl: asUrl(distributed, 'cmaps'),
      cMapPacked: true,
    },
  }));

  const data = await readCasPdf(new Uint8Array(fs.readFileSync(file)), password);

  const got = {
    Equities: 0,
    'Mutual funds (demat)': 0,
    'Government securities': 0,
    'Corporate bonds': 0,
    'Mutual fund folios': 0,
    NPS: 0,
  };
  const counts = { ...got };

  for (const account of data.accounts || []) {
    // The folio pseudo-account holds the units sitting with the AMC rather than in a
    // depository, which the statement totals separately.
    const isFolios = /folio/i.test(account.name || '') || /folio/i.test(account.type || '');

    for (const fund of account.mutual_funds || []) {
      const bucket = isFolios ? 'Mutual fund folios' : 'Mutual funds (demat)';
      got[bucket] += num(fund.value);
      counts[bucket] += 1;
    }
    for (const equity of account.equities || []) {
      got.Equities += num(equity.value);
      counts.Equities += 1;
    }
    for (const bond of account.bonds || []) {
      const bucket = isGovernment(bond.isin) ? 'Government securities' : 'Corporate bonds';
      got[bucket] += num(bond.value);
      counts[bucket] += 1;
    }
  }

  if (data.nps) {
    for (const scheme of data.nps.schemes || []) {
      got.NPS += num(scheme.value);
      counts.NPS += 1;
    }
  }

  const total = Object.values(got).reduce((sum, value) => sum + value, 0);

  console.log('BUCKET                    HOLDINGS            PARSED          EXPECTED   ');
  console.log('-'.repeat(78));
  let bad = 0;
  for (const [name, parsed] of Object.entries(got)) {
    const want = EXPECTED[name];
    const wrong = want !== undefined && Math.abs(parsed - want) > 1;
    if (wrong) bad += 1;
    console.log(`${name.padEnd(24)}  ${String(counts[name]).padStart(5)}  ${money(parsed).padStart(16)}`
      + `  ${want === undefined ? '(not expected)'.padStart(16) : money(want).padStart(16)}`
      + `  ${want === undefined ? (parsed > 0 ? 'UNEXPECTED' : '') : (wrong ? 'WRONG' : 'ok')}`);
  }
  console.log('-'.repeat(78));
  const totalWrong = Math.abs(total - EXPECTED_TOTAL) > 1;
  console.log(`${'TOTAL'.padEnd(24)}  ${' '.repeat(5)}  ${money(total).padStart(16)}`
    + `  ${money(EXPECTED_TOTAL).padStart(16)}  ${totalWrong ? 'WRONG' : 'ok'}`);
  if (totalWrong) console.log(`${' '.repeat(24)}  difference ${money(total - EXPECTED_TOTAL)}`);

  console.log(`\nNPS section: ${data.nps ? `found, PRAN ${data.nps.pran ? 'read' : 'NOT read'}` : 'NOT FOUND'}`);
  if (data.nps) {
    // Tier and asset class only. A real account has one row per tier per asset class, so
    // a repeated pair means a subtotal is being read as a holding.
    const seen = new Map();
    for (const scheme of data.nps.schemes || []) {
      const key = `tier ${scheme.tier || '?'} / class ${scheme.asset_class || '?'}`;
      seen.set(key, (seen.get(key) || 0) + 1);
    }
    console.log(`  ${data.nps.schemes.length} rows read:`);
    for (const [key, count] of [...seen].sort()) {
      console.log(`    ${key}${count > 1 ? `  x${count}  <- repeated, suspicious` : ''}`);
    }
  }
  if (data.parse_warnings?.length) {
    console.log(`parse warnings: ${data.parse_warnings.length}`);
  }
  console.log(bad || totalWrong ? '\nSOMETHING IS STILL WRONG' : '\nEVERY BUCKET MATCHES');
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
