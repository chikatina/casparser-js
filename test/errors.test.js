/**
 * The error paths and the back-compatibility shims.
 *
 * A wrong password, a file that is not a PDF at all, an input of the wrong type, and a
 * valid PDF that carries no statement: each has to fail in its own recognisable way,
 * because they need entirely different advice.
 */

import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import process from 'node:process';

import { readCasPdf } from '../src/parsers/index.js';
import { CASParseError, IncorrectPasswordError } from '../src/exceptions.js';
import { fixtureBytes, loadPdfBackend } from './_helpers.js';

let backendReady = false;
before(async () => {
  backendReady = await loadPdfBackend();
});

/** A valid one-page PDF with nothing on it. */
const BLANK_PDF = new TextEncoder().encode(
  '%PDF-1.4\n'
  + '1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n'
  + '2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n'
  + '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]>>endobj\n'
  + 'trailer<</Root 1 0 R>>\n',
);

describe('password errors', () => {
  it('reports a rejected password as its own failure', async (t) => {
    const bytes = fixtureBytes('CAMS_CAS_FILE');
    if (!bytes || !backendReady) return t.skip('CAMS_CAS_FILE not set, or pdf.js absent');

    await assert.rejects(
      () => readCasPdf(bytes, ''),
      (error) => error instanceof IncorrectPasswordError
        && error.message.includes('Incorrect PDF password!'),
    );
  });
});

describe('input validation', () => {
  it('reports a file that is not a PDF', async (t) => {
    if (!backendReady) return t.skip('pdf.js is not installed');
    await assert.rejects(
      () => readCasPdf(new TextEncoder().encode('this is not a pdf'), ''),
      (error) => error instanceof CASParseError
        && (error.message.includes('Unhandled error while opening')
          || error.message.includes('Could not')),
    );
  });

  it('reports an input of the wrong type rather than throwing a type error', async (t) => {
    if (!backendReady) return t.skip('pdf.js is not installed');
    await assert.rejects(() => readCasPdf(1, ''), CASParseError);
  });

  it('reports a valid PDF that is not a statement', async (t) => {
    if (!backendReady) return t.skip('pdf.js is not installed');
    await assert.rejects(
      () => readCasPdf(BLANK_PDF, ''),
      (error) => error instanceof CASParseError && error.message.includes('Could not identify'),
    );
  });
});

describe('back-compatibility', () => {
  it('accepts the retired backend switch and warns about it', async (t) => {
    if (!backendReady) return t.skip('pdf.js is not installed');

    const warnings = [];
    const capture = (warning) => warnings.push(warning);
    process.on('warning', capture);
    try {
      // The parse itself fails, which is fine: the point is that the argument is still
      // accepted and still says it is going away.
      await readCasPdf(BLANK_PDF, '', { forcePdfminer: true }).catch(() => {});
      await new Promise((resolve) => setImmediate(resolve));
    } finally {
      process.off('warning', capture);
    }

    assert.ok(
      warnings.some((warning) => warning.name === 'DeprecationWarning'
        && warning.message.includes('force_pdfminer')),
      'expected a deprecation warning naming the retired argument',
    );
  });
});
