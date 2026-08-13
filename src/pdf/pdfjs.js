/**
 * A PDF backend built on Mozilla's pdf.js.
 *
 * pdf.js is passed in rather than imported, because how it is loaded differs everywhere
 * this library runs: an app with no bundler imports a vendored `pdf.mjs`, a Node test
 * imports the npm package, a bundled site imports whatever its bundler gives it. The
 * library should not have an opinion about that.
 *
 * What pdf.js gives us, and what it does not
 * =========================================
 *
 * `getTextContent()` returns one item per text-show operation, with the text, the text
 * matrix, and the run's width and height. That is exactly the granularity the parsers
 * call an *atom*, so the NSDL and CDSL readers, which work on whole cells, get what they
 * need directly.
 *
 * What it does not report is per-glyph positions, which the CAMS and KFin readers use to
 * decide which table column a character belongs to. So each atom's width is spread across
 * its characters here. In a table the numbers are right-aligned digits of near-equal
 * width and an atom rarely straddles two columns, so the approximation holds; a backend
 * that can do better should report `chars` itself and this step is skipped.
 */

import { CASParseError, IncorrectPasswordError } from '../exceptions.js';
import { isNonLatinFont, stripFontSubsetPrefix } from './backend.js';

/**
 * pdf.js reports a run's `height` as the em size. The glyph bounding box the parsers
 * expect is closer to the cap height, and that ratio feeds the gap threshold that decides
 * where a space is inserted between two characters.
 */
const DEFAULT_GLYPH_HEIGHT_RATIO = 0.72;

function isPasswordError(error) {
  if (!error) return false;
  if (error.name === 'PasswordException') return true;
  const message = String(error.message || error).toLowerCase();
  return message.includes('password');
}

class PdfjsDocument {
  constructor(document, options) {
    this.document = document;
    this.numPages = document.numPages;
    this.glyphHeightRatio = options.glyphHeightRatio ?? DEFAULT_GLYPH_HEIGHT_RATIO;
    this._pages = new Map();
  }

  async _page(pageNumber) {
    if (!this._pages.has(pageNumber)) {
      this._pages.set(pageNumber, await this.document.getPage(pageNumber));
    }
    return this._pages.get(pageNumber);
  }

  /** Resolves a pdf.js font handle to its PostScript name, when the object is loaded. */
  static _fontName(page, item) {
    const handle = item.fontName;
    if (!handle) return '';
    try {
      if (page.commonObjs && page.commonObjs.has(handle)) {
        const font = page.commonObjs.get(handle);
        if (font && font.name) return font.name;
      }
    } catch {
      // The font object is not always resolvable; the handle is a usable stand-in for
      // the one thing fonts are compared for, which is "same font or not".
    }
    return handle;
  }

  async getAtoms(pageNumber) {
    const page = await this._page(pageNumber);
    const content = await page.getTextContent({ disableNormalization: true });
    const atoms = [];
    let streamSeq = 0;

    for (const item of content.items) {
      streamSeq += 1;
      if (item.type === 'beginMarkedContent' || item.type === 'endMarkedContent') continue;
      const text = item.str;
      if (!text || !text.trim()) continue;

      const [a, b, , , e, f] = item.transform;
      const vertical = Math.abs(b) > Math.abs(a);
      const rawFont = PdfjsDocument._fontName(page, item);
      if (isNonLatinFont(rawFont)) continue;

      const width = Math.abs(item.width) || 0;
      const height = Math.abs(item.height) || 0;
      const glyphHeight = height * this.glyphHeightRatio;

      atoms.push({
        text,
        xLeft: e,
        xRight: e + width,
        baseline: f,
        yTop: f + glyphHeight,
        yBottom: f - glyphHeight * 0.25,
        font: stripFontSubsetPrefix(rawFont),
        vertical,
        streamSeq,
      });
    }
    return atoms;
  }

  async getText(pageNumber) {
    const atoms = await this.getAtoms(pageNumber);
    return atoms.map((atom) => atom.text).join('\n');
  }

  async close() {
    for (const page of this._pages.values()) {
      try {
        page.cleanup();
      } catch {
        // A page that has already been released is not a problem worth reporting.
      }
    }
    this._pages.clear();
    try {
      await this.document.destroy();
    } catch {
      // Same: destroying twice is harmless.
    }
  }
}

/**
 * Wraps a pdf.js module as a backend.
 *
 * @param {object} pdfjsLib the pdf.js module (it needs `getDocument`)
 * @param {object} [options]
 * @param {number} [options.glyphHeightRatio] cap height as a fraction of the em size
 * @param {object} [options.documentOptions] extra options passed to `getDocument`
 */
export function createPdfjsBackend(pdfjsLib, options = {}) {
  if (!pdfjsLib || typeof pdfjsLib.getDocument !== 'function') {
    throw new TypeError('createPdfjsBackend needs the pdf.js module');
  }

  return {
    async open(source, password = '') {
      const task = pdfjsLib.getDocument({
        ...(options.documentOptions || {}),
        ...toSourceOptions(source),
        password: password || '',
        // A CAS is a table of text; none of the parsers look at anything drawn.
        isEvalSupported: false,
      });
      let document;
      try {
        document = await task.promise;
      } catch (error) {
        if (isPasswordError(error)) {
          throw new IncorrectPasswordError('Incorrect PDF password!');
        }
        throw new CASParseError(
          `Unhandled error while opening PDF: ${error && error.message ? error.message : error}`,
        );
      }
      return new PdfjsDocument(document, options);
    },
  };
}

function toSourceOptions(source) {
  if (source instanceof Uint8Array) return { data: source };
  if (source instanceof ArrayBuffer) return { data: new Uint8Array(source) };
  if (typeof source === 'string') return { url: source };
  if (source && typeof source === 'object') return source;
  throw new CASParseError(`Invalid input: ${typeof source} is not a PDF source`);
}
