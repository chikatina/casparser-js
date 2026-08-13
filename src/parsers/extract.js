/**
 * Per-glyph text extraction for the CAMS and KFin readers.
 *
 * Walks a page's text-show operations — one *atom* each — filters overlay duplicates at
 * that level, then expands the survivors into per-glyph `Char`s clustered into `Line`s by
 * typographic baseline.
 *
 * Why the atom layer exists
 * =========================
 *
 * These statements occasionally render the date column as two near-identical glyph layers
 * in the same font, offset by less than a point. Working purely per glyph loses track of
 * which glyph came from which show operation, so the two layers share one logical line
 * and interleave by x: `2020` reads back as `22002200`, which parses as the year 2200 and
 * poisons everything downstream. Keeping the show operation as a unit makes the duplicate
 * obvious and cheap to drop.
 *
 * Why per-glyph positions are still needed
 * ========================================
 *
 * The detailed reader assigns each character to a table column by its x midpoint, so
 * after the dedup each surviving atom is expanded back into characters.
 *
 * Why baseline y rather than bounding-box y
 * =========================================
 *
 * A glyph's bounding box moves with its descender, so `g` and `y` would sit lower than
 * the rest of their line and break the clustering. The baseline does not move.
 */

/**
 * Baseline clustering tolerance. Glyphs from one show operation share an exact baseline;
 * a point and a half absorbs the drift between, say, a date atom and a description atom
 * on the same visual row without merging rows that sit seven points apart.
 */
export const Y_TOL = 1.5;

/**
 * Row banding for the overlay dedup. Wider than `Y_TOL` so both layers of an overlay pair
 * and the rest of the row land in the same band.
 */
export const Y_OVERLAY_ROW_TOL = 3.0;

/**
 * Below this vertical offset two atoms are the same physical row, which means they are
 * legitimate side-by-side cells rather than an overlay pair.
 */
export const Y_OVERLAY_MIN_OFFSET = 0.05;

/**
 * How much two same-font atoms must overlap horizontally, as a fraction of the narrower
 * one's width, before they count as duplicates rather than neighbouring columns.
 */
export const X_OVERLAY_MIN_FRAC = 0.5;

/** One glyph at a known typographic position. */
export class Char {
  constructor(text, x0, y0, x1, y1, font = '') {
    this.text = text;
    this.x0 = x0;
    this.y0 = y0;
    this.x1 = x1;
    this.y1 = y1;
    this.font = font;
  }

  get h() {
    return this.y1 - this.y0;
  }
}

export class Line {
  constructor(page, baseline, chars = []) {
    this.page = page;
    this.baseline = baseline;
    this.chars = chars;
  }

  /**
   * The line's text, with a space wherever the horizontal gap is wide enough to be one.
   *
   * The threshold is 0.6 of the median glyph height, floored at 1.5 points. Going lower
   * catches the kerning gaps inside a number rendered as several show operations, so a
   * folio number or an amount does not come back fragmented.
   */
  get text() {
    const chars = [...this.chars].sort((a, b) => a.x0 - b.x0);
    if (!chars.length) return '';
    const heights = chars.map((c) => c.h).sort((a, b) => a - b);
    const median = heights[Math.floor(heights.length / 2)];
    const gap = Math.max(1.5, 0.6 * median);

    const out = [];
    let previousRight = null;
    for (const char of chars) {
      if (previousRight !== null && char.x0 - previousRight > gap) out.push(' ');
      out.push(char.text);
      previousRight = char.x1;
    }
    return out.join('');
  }
}

export class Page {
  constructor(number, lines) {
    this.number = number;
    this.lines = lines;
  }
}

/** One text-show operation, with its box, font and the glyphs it produced. */
class Atom {
  constructor(xLeft, xRight, yTop, yBottom, font, chars = []) {
    this.xLeft = xLeft;
    this.xRight = xRight;
    this.yTop = yTop;
    this.yBottom = yBottom;
    this.font = font;
    this.chars = chars;
  }

  get width() {
    return this.xRight - this.xLeft;
  }
}

/**
 * Turns a raw atom into glyphs.
 *
 * A backend that reports per-glyph boxes is used as-is. Otherwise the atom's width is
 * spread across its characters, which is what the column assignment needs and all it
 * needs: the boundary that matters is between columns, and a show operation almost never
 * straddles one.
 */
function charsForAtom(raw, font) {
  if (Array.isArray(raw.chars) && raw.chars.length) {
    return raw.chars
      .filter((c) => c.text && c.x1 > c.x0)
      .map((c) => new Char(c.text, c.x0, c.y0 ?? raw.baseline, c.x1, c.y1 ?? raw.yTop, font));
  }

  const glyphs = [...raw.text];
  if (!glyphs.length) return [];
  const advance = (raw.xRight - raw.xLeft) / glyphs.length;
  const chars = [];
  for (let i = 0; i < glyphs.length; i += 1) {
    const x0 = raw.xLeft + advance * i;
    chars.push(new Char(glyphs[i], x0, raw.baseline, x0 + advance, raw.yTop, font));
  }
  return chars;
}

/**
 * Drops atoms that are overlay duplicates of another atom on the same visual row.
 *
 * Two atoms are a pair when they share a font, their x ranges overlap by at least
 * `X_OVERLAY_MIN_FRAC` of the narrower one's width, and their tops differ by between
 * `Y_OVERLAY_MIN_OFFSET` and `Y_OVERLAY_ROW_TOL`. The one further from the row's median
 * top is the copy: the real row clusters tightly around the median and the overlay sits a
 * hair off it.
 */
function dedupeOverlayAtoms(atoms) {
  if (atoms.length < 2) return atoms;

  const ordered = atoms
    .map((atom, index) => ({ index, atom }))
    .sort((a, b) => b.atom.yTop - a.atom.yTop);

  const rows = [];
  let anchor = null;
  for (const entry of ordered) {
    if (anchor === null || Math.abs(entry.atom.yTop - anchor) > Y_OVERLAY_ROW_TOL) {
      rows.push([entry]);
      anchor = entry.atom.yTop;
    } else {
      rows[rows.length - 1].push(entry);
    }
  }

  const drop = new Set();
  for (const row of rows) {
    if (row.length < 2) continue;
    const tops = row.map((entry) => entry.atom.yTop).sort((a, b) => a - b);
    const median = tops[Math.floor(row.length / 2)];

    for (let i = 0; i < row.length; i += 1) {
      const left = row[i];
      if (drop.has(left.index)) continue;
      for (let j = i + 1; j < row.length; j += 1) {
        const right = row[j];
        if (drop.has(right.index) || !left.atom.font || left.atom.font !== right.atom.font) {
          continue;
        }
        const overlap = Math.min(left.atom.xRight, right.atom.xRight)
          - Math.max(left.atom.xLeft, right.atom.xLeft);
        if (overlap <= 0) continue;
        const narrower = Math.min(left.atom.width, right.atom.width);
        if (narrower <= 0 || overlap / narrower < X_OVERLAY_MIN_FRAC) continue;
        if (Math.abs(left.atom.yTop - right.atom.yTop) < Y_OVERLAY_MIN_OFFSET) continue;

        const leftDistance = Math.abs(left.atom.yTop - median);
        const rightDistance = Math.abs(right.atom.yTop - median);
        drop.add(leftDistance > rightDistance ? left.index : right.index);
      }
    }
  }
  return atoms.filter((_, index) => !drop.has(index));
}

/**
 * Clusters glyphs into top-down lines by baseline.
 *
 * The running average lets a line track a slow visual drift across many atoms, which is
 * how a scheme name and its registrar annotation on slightly different baselines end up
 * on one logical line, as intended.
 */
function clusterIntoLines(atoms, pageNumber) {
  const chars = atoms.flatMap((atom) => atom.chars).sort((a, b) => b.y0 - a.y0);
  const lines = [];
  for (const char of chars) {
    const last = lines[lines.length - 1];
    if (last && Math.abs(char.y0 - last.baseline) <= Y_TOL) {
      last.chars.push(char);
      const n = last.chars.length;
      last.baseline = (last.baseline * (n - 1) + char.y0) / n;
    } else {
      lines.push(new Line(pageNumber, char.y0, [char]));
    }
  }
  return lines;
}

/**
 * One `Page` per PDF page, each holding baseline-clustered `Line`s of `Char`s.
 *
 * Vertically-oriented runs are dropped: these statements stamp a rotated watermark down
 * the page edge whose glyphs otherwise land in the right-hand columns and bleed fragments
 * into the registrar and scheme-name fields.
 */
export async function extractPages(document) {
  const pages = [];
  for (let number = 1; number <= document.numPages; number += 1) {
    // eslint-disable-next-line no-await-in-loop
    const raw = await document.getAtoms(number);
    const atoms = [];
    for (const item of raw) {
      if (item.vertical) continue;
      const atom = new Atom(item.xLeft, item.xRight, item.yTop, item.yBottom, item.font);
      atom.chars = charsForAtom(item, item.font);
      if (atom.chars.length) atoms.push(atom);
    }
    pages.push(new Page(number, clusterIntoLines(dedupeOverlayAtoms(atoms), number)));
  }
  return pages;
}
