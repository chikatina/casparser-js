/**
 * Works out who issued a statement, and for the registrars whether it lists transactions.
 *
 * Only the first page or two are read. The issuer and the statement kind are declared up
 * front, and reading a whole statement to identify it is wasted work.
 */

import { CASFileType, FileType } from '../enums.js';

const CAS_TYPE_RE = /consolidated\s+account\s+(statement|summary)/i;

/**
 * The text of the first `maxPages` pages, plus a whitespace-collapsed copy.
 *
 * The collapsed copy matters because the markers below are phrases, and a statement is
 * free to break one across two text-show operations. Matching the collapsed text as well
 * costs nothing and stops a line break deciding that a statement has no issuer.
 */
async function readTextSample(document, maxPages = 2) {
  const parts = [];
  const limit = Math.min(maxPages, document.numPages);
  for (let page = 1; page <= limit; page += 1) {
    // eslint-disable-next-line no-await-in-loop
    parts.push(await document.getText(page));
  }
  const text = parts.join('\n');
  return { text, flat: text.replace(/\s+/g, ' ') };
}

function contains(sample, needle) {
  return sample.text.includes(needle) || sample.flat.includes(needle);
}

/** The issuer, or `UNKNOWN` when nothing matches. */
export async function detectFileType(document) {
  const sample = await readTextSample(document);
  if (contains(sample, 'CAMSCASWS')) return FileType.CAMS;
  if (contains(sample, 'KFINCASWS')) return FileType.KFINTECH;
  if (contains(sample, 'NSDL Consolidated Account Statement') || contains(sample, 'About NSDL')) {
    return FileType.NSDL;
  }
  if (contains(sample, 'Central Depository Services (India) Limited')) return FileType.CDSL;
  return FileType.UNKNOWN;
}

/** For CAMS and KFin only: a detailed statement or a summary one. */
export async function detectCasType(document) {
  const sample = await readTextSample(document, 1);
  const match = CAS_TYPE_RE.exec(sample.text) || CAS_TYPE_RE.exec(sample.flat);
  if (match) {
    const kind = match[1].toLowerCase().trim();
    if (kind === 'statement') return CASFileType.DETAILED;
    if (kind === 'summary') return CASFileType.SUMMARY;
  }
  return CASFileType.UNKNOWN;
}
