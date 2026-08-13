/**
 * The seam between the parsers and whatever reads the PDF.
 *
 * The parsers need three things from a page: the text of each show operation, where it
 * sits, and which font drew it. Everything downstream — line clustering, column
 * assignment, block grouping — is built from those. Keeping that behind a small
 * interface means the PDF reader is a choice the caller makes: pdf.js in a browser or a
 * WebView, pdf.js under Node for the tests, something else entirely if it comes to that.
 *
 * A backend implements:
 *
 *   open(source, password) -> Promise<PdfDocument>
 *
 * and a `PdfDocument` provides:
 *
 *   numPages          number of pages
 *   getAtoms(page)    Promise<RawAtom[]>, in content-stream order
 *   getText(page)     Promise<string>, the page's text for issuer sniffing
 *   close()           releases the document
 *
 * A `RawAtom` is one text-show operation:
 *
 *   { text, xLeft, xRight, yTop, yBottom, baseline, font, vertical, streamSeq, chars? }
 *
 * `chars` is optional. A backend that can report per-glyph positions should; one that
 * cannot leaves it out and `extract.js` spreads the atom's width across its characters.
 */

/** Registered default, so callers configure the reader once rather than per call. */
let defaultBackend = null;

export function setPdfBackend(backend) {
  defaultBackend = backend || null;
}

export function getPdfBackend() {
  return defaultBackend;
}

/**
 * Resolves the backend for a call: an explicit one wins, otherwise the registered
 * default.
 */
export function resolveBackend(explicit) {
  const backend = explicit || defaultBackend;
  if (!backend) {
    throw new Error(
      'No PDF backend configured. Call setPdfBackend(createPdfjsBackend(pdfjsLib)) first.',
    );
  }
  return backend;
}

/**
 * Fonts dropped wholesale. Mangal is the Devanagari face NSDL and CDSL statements use to
 * lay a Hindi translation over the English text; discarding it at extraction time is what
 * keeps line clustering from interleaving two scripts.
 */
export const NON_LATIN_FONT_KEYWORDS = ['Mangal'];

export function isNonLatinFont(fontName) {
  const base = String(fontName || '');
  const stripped = base.includes('+') ? base.split('+').slice(1).join('+') : base;
  return NON_LATIN_FONT_KEYWORDS.some((keyword) => stripped.includes(keyword));
}

/** Drops the six-character `<XXXXXX>+` subset prefix a PDF puts on an embedded font. */
export function stripFontSubsetPrefix(name) {
  const text = String(name || '');
  const at = text.indexOf('+');
  return at >= 0 ? text.slice(at + 1) : text;
}
