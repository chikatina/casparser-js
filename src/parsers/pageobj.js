/**
 * Block extraction for the NSDL and CDSL readers.
 *
 * Those statements are tables of multi-line cells, so the useful unit is not a glyph or a
 * line but a *cell*: a vertical strip of text-show operations that share a left edge.
 * This module builds them:
 *
 *   1. one atom per text-show operation, dropping the Devanagari overlay font;
 *   2. dedup by position and text, because these files render the banner twice;
 *   3. cluster atoms into raw lines by their tops;
 *   4. cluster consecutive raw lines into blocks — a block is one table row;
 *   5. within a block, group atoms into columns by left edge, join each column top-down.
 *
 * The result is a flat list of `Block`s in reading order, which is what the two
 * depository readers consume.
 */

/** Atoms within this many points of each other's top belong to one raw line. */
export const Y_LINE_TOL = 1.5;

/**
 * Top-to-top gap that keeps two raw lines in the same block. These tables run about seven
 * points between the lines of one row and about eleven between rows, so nine separates
 * them cleanly.
 */
export const Y_BLOCK_TOL = 9.0;

/**
 * U+00AD. A statement generator inserts it where a long token — most often a twelve
 * character ISIN — had to wrap. It carries no meaning: it must be removed, and where it
 * ends a fragment it marks a continuation that joins the next fragment with no separator.
 */
export const SOFT_HYPHEN = '­';

/** Left edges within this many points belong to the same vertical strip. */
export const X_LEFT_TOL = 3.0;

/** Vertical gap allowed inside one multi-line cell. */
export const STRIP_VERTICAL_GAP = 9.0;

/**
 * Two atoms in a mid-table column join one strip only when their left edges match *and*
 * their centres drift apart. That second test separates a left-aligned multi-line cell,
 * whose right edge wanders with the text, from a centre-aligned two-row column header
 * such as "Average Total" stacked over "Expense Ratio", whose centres stay put. Atoms at
 * the far left of the page are exempt: stacking there is always a multi-line cell.
 */
export const CENTER_LEFT_ALIGN_TOL = 1.0;
export const LEFT_EDGE_X = 100.0;

/**
 * One text-show operation.
 *
 * `streamSeq` is its position in the content-stream walk. Two atoms whose sequence
 * numbers differ by one had nothing drawn between them, which is how a genuine
 * continuation is told from a same-row neighbour.
 */
export class Atom {
  constructor(xLeft, xRight, yTop, yBot, text, font = '', streamSeq = 0) {
    this.xLeft = xLeft;
    this.xRight = xRight;
    this.yTop = yTop;
    this.yBot = yBot;
    this.text = text;
    this.font = font;
    this.streamSeq = streamSeq;
  }
}

/** A logical table cell: one column slice of a block, possibly several lines tall. */
export class Cell {
  constructor({ xLeft, xRight, yTop, yBot, text, atoms = [] }) {
    this.xLeft = xLeft;
    this.xRight = xRight;
    this.yTop = yTop;
    this.yBot = yBot;
    this.text = text;
    this.atoms = atoms;
  }
}

/** A logical row. Cells run left to right. */
export class Block {
  constructor(page, cells = []) {
    this.page = page;
    this.cells = cells;
  }

  get yTop() {
    return this.cells.length ? Math.max(...this.cells.map((c) => c.yTop)) : 0;
  }

  get yBot() {
    return this.cells.length ? Math.min(...this.cells.map((c) => c.yBot)) : 0;
  }

  get xLeft() {
    return this.cells.length ? Math.min(...this.cells.map((c) => c.xLeft)) : 0;
  }

  get xRight() {
    return this.cells.length ? Math.max(...this.cells.map((c) => c.xRight)) : 0;
  }

  /** A single-string view of the row, cells joined by two tabs. */
  text() {
    return this.cells.filter((c) => c.text).map((c) => c.text).join('\t\t');
  }
}

/**
 * Drops the second copy of text a statement drew twice.
 *
 * These files render some text once for the visible glyphs and once for the accessibility
 * layer. The copies land at slightly different x positions with identical content, so an
 * earlier atom at the same y with the same text and an overlapping x range wins.
 */
function dedupeOverlapping(atoms) {
  if (!atoms.length) return [];
  const byLine = new Map();
  for (const atom of atoms) {
    const key = Math.round(atom.yTop * 10) / 10;
    if (!byLine.has(key)) byLine.set(key, []);
    byLine.get(key).push(atom);
  }

  const keep = [];
  for (const lineAtoms of byLine.values()) {
    const kept = [];
    for (const atom of lineAtoms) {
      const text = atom.text.trim();
      const duplicate = kept.some((other) => other.text.trim() === text
        && atom.xLeft < other.xRight && other.xLeft < atom.xRight);
      if (!duplicate) kept.push(atom);
    }
    keep.push(...kept);
  }
  return keep;
}

/** Groups atoms into raw lines by their tops. */
function clusterRawLines(atoms) {
  if (!atoms.length) return [];
  const sorted = [...atoms].sort((a, b) => (b.yTop - a.yTop) || (a.xLeft - b.xLeft));
  const lines = [[sorted[0]]];
  let currentY = sorted[0].yTop;
  for (const atom of sorted.slice(1)) {
    if (Math.abs(atom.yTop - currentY) <= Y_LINE_TOL) {
      lines[lines.length - 1].push(atom);
    } else {
      lines.push([atom]);
      currentY = atom.yTop;
    }
  }
  return lines;
}

/** Merges consecutive raw lines into blocks. */
function clusterBlocks(rawLines) {
  if (!rawLines.length) return [];
  const blocks = [[...rawLines[0]]];
  let previousY = rawLines[0][0].yTop;
  for (const line of rawLines.slice(1)) {
    const currentY = line[0].yTop;
    if (previousY - currentY <= Y_BLOCK_TOL) {
      blocks[blocks.length - 1].push(...line);
    } else {
      blocks.push([...line]);
    }
    previousY = currentY;
  }
  return blocks;
}

/**
 * Groups a block's atoms into vertical strips, which are its multi-line cells.
 *
 * Left-edge alignment rather than x-range overlap, because some statements render a
 * client code as a lone digit sitting at the units column's x position. An overlap-based
 * grouping would swallow it into the units cell and the row would stop matching; keeping
 * it as its own cell is both truer to the layout and what the row readers expect.
 */
function columnCluster(blockAtoms) {
  const strips = [];
  const sorted = [...blockAtoms].sort((a, b) => (b.yTop - a.yTop) || (a.xLeft - b.xLeft));

  for (const atom of sorted) {
    const centre = (atom.xLeft + atom.xRight) / 2;
    let placed = false;

    for (const strip of strips) {
      const last = strip[strip.length - 1];
      const leftMatches = Math.abs(atom.xLeft - last.xLeft) <= X_LEFT_TOL;
      const gap = last.yTop - atom.yTop;
      const verticallyClose = gap >= -0.1 && gap <= STRIP_VERTICAL_GAP;
      if (!leftMatches || !verticallyClose) continue;

      const atLeftEdge = atom.xLeft < LEFT_EDGE_X;
      const lastCentre = (last.xLeft + last.xRight) / 2;
      const centreDrifts = Math.abs(centre - lastCentre) > CENTER_LEFT_ALIGN_TOL;
      if (atLeftEdge || centreDrifts) {
        strip.push(atom);
        placed = true;
        break;
      }
    }
    if (!placed) strips.push([atom]);
  }
  return strips;
}

/**
 * Joins one column's atoms top to bottom into a cell string.
 *
 * Normally one line per atom. The exception is the soft hyphen: where a fragment ends
 * with one, the generator wrapped a single token, so the next fragment is spliced on with
 * no separator and the hyphen dropped. Any remaining soft hyphens are stripped too, so a
 * token that wrapped inside a single atom is normalised the same way.
 */
export function joinColumnAtoms(atomsTopDown) {
  const pieces = [];
  let continuing = false;

  for (const atom of atomsTopDown) {
    const part = atom.text.trim();
    if (!part) continue;
    if (continuing) {
      pieces[pieces.length - 1] += part;
    } else {
      pieces.push(part);
    }
    const last = pieces[pieces.length - 1];
    if (last.endsWith(SOFT_HYPHEN)) {
      pieces[pieces.length - 1] = last.slice(0, -1);
      continuing = true;
    } else {
      continuing = false;
    }
  }
  return pieces.join('\n').split(SOFT_HYPHEN).join('');
}

/** Runs the column clustering and returns `Cell`s with their boxes. */
export function cellsFromBlockAtoms(blockAtoms) {
  const strips = columnCluster(blockAtoms);
  strips.sort((a, b) => Math.min(...a.map((x) => x.xLeft)) - Math.min(...b.map((x) => x.xLeft)));

  const cells = [];
  for (const strip of strips) {
    const sorted = [...strip].sort((a, b) => (b.yTop - a.yTop) || (a.xLeft - b.xLeft));
    const text = joinColumnAtoms(sorted);
    if (!text) continue;
    cells.push(new Cell({
      xLeft: Math.min(...strip.map((a) => a.xLeft)),
      xRight: Math.max(...strip.map((a) => a.xRight)),
      yTop: Math.max(...strip.map((a) => a.yTop)),
      yBot: Math.min(...strip.map((a) => a.yBot)),
      text,
      atoms: sorted,
    }));
  }
  return cells;
}

/**
 * One list of `Atom`s per page.
 *
 * Vertically-oriented runs are skipped: that is the rotated watermark, whose glyphs
 * otherwise bleed down the right-hand columns.
 */
export async function extractAtoms(document) {
  const pages = [];
  for (let number = 1; number <= document.numPages; number += 1) {
    // eslint-disable-next-line no-await-in-loop
    const raw = await document.getAtoms(number);
    const atoms = [];
    const seen = new Set();

    for (const item of raw) {
      if (item.vertical) continue;
      if (!item.text || !item.text.trim()) continue;
      const key = `${Math.round(item.xLeft * 10) / 10}|${Math.round(item.yTop * 10) / 10}|${item.text}`;
      if (seen.has(key)) continue;
      seen.add(key);
      atoms.push(new Atom(
        item.xLeft, item.xRight, item.yTop, item.yBottom,
        item.text, item.font, item.streamSeq,
      ));
    }
    pages.push(dedupeOverlapping(atoms));
  }
  return pages;
}

/** Turns already-extracted atoms into blocks, page by page. */
export function blocksFromAtoms(pages) {
  const out = [];
  pages.forEach((atoms, index) => {
    const rawLines = clusterRawLines(atoms);
    for (const blockAtoms of clusterBlocks(rawLines)) {
      const cells = cellsFromBlockAtoms(blockAtoms);
      if (cells.length) out.push(new Block(index + 1, cells));
    }
  });
  return out;
}

/** A flat list of `Block`s across every page, in reading order. */
export async function extractBlocks(document, preExtractedAtoms = null) {
  const pages = preExtractedAtoms || await extractAtoms(document);
  return blocksFromAtoms(pages);
}
