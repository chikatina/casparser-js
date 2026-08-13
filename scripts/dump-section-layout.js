#!/usr/bin/env node
/*
 * Prints the shape of the statement sections the NSDL parser does not read yet.
 *
 * The parser finds a column by where it sits on the page, not by what it says, so adding
 * a section means knowing its geometry: how many cells a row has and the x range each one
 * occupies. That cannot be guessed, and it cannot be taken from a specification, because
 * it is whatever the depository's typesetter did.
 *
 * Nothing here reports what anybody owns. Every character of every cell is replaced
 * before printing: a letter becomes A, a digit becomes 9, and punctuation stays so the
 * shape of a date or an amount survives. That is enough to write a column map against and
 * useless to anybody who reads it.
 *
 *   node scripts/dump-section-layout.js statement.pdf --password SECRET
 *
 * Add --show-headers to print section and column headings unmasked. Those are printed by
 * the depository and are the same for everybody, but it is off by default so that running
 * this without thinking cannot disclose anything.
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import * as pageobj from '../src/parsers/pageobj.js';
import { NPS_SECTION_RE, NPS_TRANSACTIONS_RE, parseNpsRow } from '../src/parsers/nsdl.js';
import { createPdfjsBackend } from '../src/pdf/pdfjs.js';
import { setPdfBackend, getPdfBackend } from '../src/pdf/backend.js';

// The sections nsdl.js currently recognises only in order to skip. These are what we want
// the shape of.
/*
 * The sections worth the shape of, matched on their words rather than their exact
 * wording. An earlier version of this listed the strings the parser skips on, which is how
 * it walked straight past a National Pension System heading: the parser expects
 * "national pension system (n)" and a statement can just as well print "(NPS)".
 */
const WANTED = [
  /national pension|\bnps\b/i,
  /government securit/i,
  /alternate investment/i,
  /preference shares/i,
  /money market/i,
  /securitis(?:ed|ation)/i,
  /postal saving/i,
  /zero coupon/i,
];

// A heading is a short block ending in a bracketed letter code, or one of the two the
// depository prints without one.
const ANY_SECTION = /\([a-z]{1,4}\)\s*$|^equity shares$|^mutual funds units held with the amc$|^mutual fund folios/i;

const wantedBy = (text) => WANTED.find((pattern) => pattern.test(text)) || null;

// The only words a heading may keep. Everything else in a heading is masked, because a
// heading can carry a name or an account number and this output is meant to be shareable.
const SAFE_WORDS = new Set([
  'equity', 'equities', 'shares', 'mutual', 'fund', 'funds', 'folios', 'units', 'held',
  'with', 'the', 'amc', 'corporate', 'bonds', 'government', 'securities', 'preference',
  'alternate', 'investment', 'money', 'market', 'instruments', 'securitised', 'postal',
  'saving', 'scheme', 'national', 'pension', 'system', 'nps', 'zero', 'coupon',
  'principal', 'holding', 'transaction', 'details', 'account', 'statement', 'consolidated',
  'and', 'of', 'in', 'your', 'name', 'pran', 'trust', 'tier', 'direct', 'cas', 'nsdl',
  'cdsl', 'insurance', 'policies', 'none', 'total', 'sub', 'grand',
]);

/** A letter becomes A, a digit 9. Spacing and punctuation are kept, so shape survives. */
function mask(text) {
  return String(text)
    .replace(/[A-Z]/g, 'A')
    .replace(/[a-z]/g, 'a')
    .replace(/[0-9]/g, '9');
}

function round(value) {
  return Math.round(Number(value) || 0);
}

async function main() {
  const args = process.argv.slice(2);
  const file = args.find((a) => !a.startsWith('--'));
  const passwordAt = args.indexOf('--password');
  const password = passwordAt >= 0 ? args[passwordAt + 1] : '';
  const showHeaders = args.includes('--show-headers');

  if (!file) {
    console.error('usage: node scripts/dump-section-layout.js statement.pdf [--password SECRET] [--show-headers]');
    process.exit(2);
  }

  const pdfjsLib = await import('pdfjs-dist/legacy/build/pdf.mjs').catch(() => null);
  if (!pdfjsLib) {
    console.error('pdf.js is not installed here. Run: npm install pdfjs-dist');
    process.exit(2);
  }
  // Without these pdf.js cannot substitute the base fourteen fonts, and a glyph it fails
  // to map is a character missing from the extracted text. Column geometry read from
  // half-decoded text would be worse than useless, so the paths are pointed at the copy
  // that ships in node_modules.
  const here = path.dirname(fileURLToPath(import.meta.url));
  const distributed = path.join(here, '..', 'node_modules', 'pdfjs-dist');
  // pdf.js treats these as URLs, not as paths: they need forward slashes and it rejects
  // one without a trailing slash outright. On Windows path.join gives neither.
  const asUrl = (...parts) => `${path.join(...parts).replace(/\\/g, '/')}/`;
  setPdfBackend(createPdfjsBackend(pdfjsLib, {
    documentOptions: {
      standardFontDataUrl: asUrl(distributed, 'standard_fonts'),
      cMapUrl: asUrl(distributed, 'cmaps'),
      cMapPacked: true,
    },
  }));

  const backend = getPdfBackend();
  // pdf.js wants a Uint8Array, and a Node Buffer is not one as far as it is concerned.
  const document = await backend.open(new Uint8Array(fs.readFileSync(file)), password);
  const atoms = await pageobj.extractAtoms(document);
  const blocks = pageobj.blocksFromAtoms(atoms);

  // An inventory first, so one run answers "what is actually in this statement" before it
  // answers "what shape is it".
  const inventory = [];
  for (const block of blocks) {
    if (block.cells.length > 2) continue;
    const text = block.text().trim().toLowerCase();
    if (ANY_SECTION.test(text) || wantedBy(text)) {
      inventory.push({ name: text, page: block.page, supported: !wantedBy(text) });
    }
  }

  /*
   * Exactly what the reader sees when it looks for the pension section, on exactly the
   * pages it looks at. The reader skips the first two pages, so a heading found here and
   * not there is a heading on a page it never reaches.
   */
  console.log('PENSION TRACE, pages 3 and after');
  console.log('-'.repeat(72));
  let traced = 0;
  for (const block of blocks) {
    if (block.page <= 2) continue;
    const text = block.text();
    if (!/pension|\bnps\b/i.test(text)) continue;
    traced += 1;
    if (traced > 12) continue;
    const starts = NPS_SECTION_RE.test(text.toLowerCase());
    const ledger = NPS_TRANSACTIONS_RE.test(text.toLowerCase());
    const verdict = starts && !ledger ? 'STARTS HOLDINGS' : (ledger ? 'ledger, ignored' : 'no match');
    // Digits masked. The wording is the depository's boilerplate, not anything personal.
    console.log(`  page ${block.page}  cells=${block.cells.length}  ${verdict}`);
    console.log(`    ${JSON.stringify(text.replace(/\d/g, '9').slice(0, 150))}`);
  }
  if (!traced) console.log('  no block on any page after two mentions a pension at all');
  console.log('-'.repeat(72));
  console.log('');

  console.log('SECTIONS PRESENT IN THIS STATEMENT');
  console.log('-'.repeat(72));
  if (!inventory.length) console.log('  none recognised');
  for (const entry of inventory) {
    /*
     * Masked, because a heading is not always boilerplate. This statement prints "your
     * nps account in the name of NAME (pran: NUMBER)" as a section heading, and an
     * earlier version of this printed it verbatim into a file meant to be safe to share.
     * Digits go, and so does any word that is not one of the few this is looking for.
     */
    const safe = entry.name
      .replace(/\d/g, '9')
      .replace(/[A-Za-z][\w'-]*/g, (word) => (SAFE_WORDS.has(word.toLowerCase()) ? word : 'x'.repeat(word.length)));
    console.log(`  page ${String(entry.page).padStart(3)}  ${entry.supported ? 'read already' : 'SKIPPED    '}  ${safe}`);
  }
  console.log('-'.repeat(72));

  let capturing = null;
  let rows = 0;
  let found = 0;

  for (const block of blocks) {
    const text = block.text().trim();
    const lower = text.toLowerCase();

    // A section marker is a short block on its own.
    if (block.cells.length <= 2) {
      if (wantedBy(lower)) {
        capturing = lower;
        rows = 0;
        found += 1;
        console.log(`\n${'='.repeat(72)}`);
        console.log(`SECTION  ${lower}`);
        console.log(`page     ${block.page}`);
        console.log(`${'='.repeat(72)}`);
        continue;
      }
      if (capturing && ANY_SECTION.test(text)) {
        console.log(`\n-- ends at: ${showHeaders ? text : mask(text)}\n`);
        capturing = null;
        continue;
      }
    }

    if (!capturing) continue;
    // Enough to see a column map, and enough for a section that runs over a page break.
    if (rows >= 30) continue;

    rows += 1;
    const looksLikeHeading = block.cells.length > 2
      && !/\d{3}/.test(text)
      && /[a-z]{4}/i.test(text);

    // For the pension section, say whether the reader would take this row as a holding.
    // A row it takes that is not one is exactly the bug being hunted.
    let verdict = '';
    if (/pension|nps/i.test(capturing)) {
      const parsed = parseNpsRow(block);
      verdict = parsed
        ? `  TAKEN  units/nav/value present, tier=${parsed.tier || '?'} class=${parsed.asset_class || '?'}`
        : '  skipped';
    }

    console.log(`row ${String(rows).padStart(2)}  cells=${block.cells.length}${verdict}`);
    for (const cell of block.cells) {
      // Cell.text is a string property. Block.text() is the method, and confusing the two
      // is what stopped this at the first row.
      const raw = String(cell.text ?? '');
      const shown = showHeaders && looksLikeHeading ? raw : mask(raw);
      console.log(`   x=${String(round(cell.xLeft)).padStart(4)}..${String(round(cell.xRight)).padEnd(4)}`
        + `  ${JSON.stringify(shown)}`);
    }
  }

  if (!found) {
    console.log('None of the unsupported sections appear in this statement.');
    console.log('That means this file has no NPS or government securities holdings to read.');
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
