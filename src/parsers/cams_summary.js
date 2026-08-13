/**
 * The CAMS and KFin summary statement reader.
 *
 * Same architecture as the detailed reader, simpler schema: each scheme is one row and
 * there are no transactions. A long name can wrap onto one or two continuation lines
 * below.
 *
 * A CAMS row, where it fits on one line:
 *
 *   <folio> <ISIN> <code>-<scheme name> <cost> <balance> <NAV date> <NAV> <value> <RTA>
 *
 * KFin carries the same fields but splits the header across two or three baselines.
 */

import { CASFileType, FileType } from '../enums.js';
import { Decimal, ZERO } from '../decimal.js';
import { CasDate } from '../dates.js';
import { CASData, Folio, Scheme, SchemeValuation, StatementPeriod } from '../types.js';
import { extractCamsKfinInvestor } from './investor.js';
import { isinSearch } from '../isin.js';
import { extractPages } from './extract.js';
import { AMC_RE, Column, collectAtoms, toDecimal } from './cams_detailed.js';

/**
 * Header words either dialect uses. Whichever appears, it maps to one canonical column.
 */
const SUMMARY_HEADER_LABELS = new Set([
  'Folio', 'No', 'No.', 'ISIN', 'Scheme', 'Name', 'Cost', 'Value', 'Unit', 'Balance',
  'Closing', 'NAV', 'Date', 'Price', 'Market', 'Registrar',
]);
const SUMMARY_MIN_HITS = 5;

const HEADER_WINDOW_Y = 15.0;

/**
 * Given the set of words in one x cluster of the header, the first rule whose required
 * tokens are all present names the column. Order within a cluster does not matter, which
 * it must not: KFin renders "Closing" and "Unit" on one baseline above "Balance" on
 * another, so sorting by x interleaves them.
 */
const COLUMN_RULES = [
  [['Folio'], 'Folio', 'left'],
  [['ISIN'], 'ISIN', 'left'],
  [['Scheme'], 'Scheme', 'left'],
  [['Cost'], 'Cost', 'right'],
  [['Closing', 'Balance'], 'Balance', 'right'],
  [['Unit', 'Balance'], 'Balance', 'right'],
  [['NAV', 'Date'], 'NAVDate', 'left'],
  [['NAV'], 'NAV', 'right'],
  [['Price'], 'NAV', 'right'],
  [['Market'], 'MarketValue', 'right'],
  [['Registrar'], 'Registrar', 'left'],
];

/**
 * Gap that starts a new header cluster. KFin's column separators run as tight as nine
 * points, so this has to be smaller than ordinary word spacing.
 */
const XCLUSTER_GAP = 7.0;

/**
 * Splits a line into words by gap *or* by a literal space character. The CAMS summary
 * header puts a real space between "Folio" and "No.", so the gap test alone would keep
 * them together.
 */
function wordsOnLine(line, minGap = 1.5) {
  const chars = [...line.chars].sort((a, b) => a.x0 - b.x0);
  const words = [];
  let current = '';
  let x0 = null;
  let x1 = null;

  for (const char of chars) {
    if (!char.text.trim()) {
      if (current) {
        words.push([current, x0, x1]);
        current = '';
      }
      continue;
    }
    if (current && char.x0 - x1 > minGap) {
      words.push([current, x0, x1]);
      current = '';
    }
    if (!current) x0 = char.x0;
    current += char.text;
    x1 = char.x1;
  }
  if (current) words.push([current, x0, x1]);
  return words;
}

/**
 * Finds the summary table header: a run of lines within `HEADER_WINDOW_Y` points carrying
 * at least `SUMMARY_MIN_HITS` distinct header words, including the two that are always
 * present.
 *
 * @returns {[number, Column[]]|null} the last line index of the header, and the columns
 */
export function detectSummaryColumns(lines, startIndex) {
  for (let i = startIndex; i < lines.length; i += 1) {
    const window = [lines[i]];
    for (let j = i + 1; j < lines.length; j += 1) {
      if (lines[i].baseline - lines[j].baseline > HEADER_WINDOW_Y) break;
      window.push(lines[j]);
    }

    const words = window.flatMap((line) => wordsOnLine(line));
    const labels = new Set(words.map((w) => w[0]).filter((w) => SUMMARY_HEADER_LABELS.has(w)));
    if (labels.size >= SUMMARY_MIN_HITS && labels.has('Folio') && labels.has('Scheme')) {
      return [i + window.length - 1, buildSummaryColumns(words)];
    }
  }
  return null;
}

function buildSummaryColumns(words) {
  const sorted = [...words].sort((a, b) => a[1] - b[1]);
  const clusters = [];
  let current = [];
  let clusterRight = 0;

  for (const word of sorted) {
    if (current.length && word[1] - clusterRight > XCLUSTER_GAP) {
      clusters.push(current);
      current = [];
      clusterRight = 0;
    }
    current.push(word);
    clusterRight = Math.max(clusterRight, word[2]);
  }
  if (current.length) clusters.push(current);

  const columns = [];
  const seen = new Set();
  for (const cluster of clusters) {
    const tokens = new Set(cluster.map((w) => w[0]));
    for (const [required, label, alignment] of COLUMN_RULES) {
      if (seen.has(label)) continue;
      if (!required.every((token) => tokens.has(token))) continue;
      columns.push(new Column(
        label,
        Math.min(...cluster.map((w) => w[1])),
        Math.max(...cluster.map((w) => w[2])),
        alignment,
      ));
      seen.add(label);
      break;
    }
  }
  columns.sort((a, b) => a.xLo - b.xLo);
  return columns;
}

/**
 * Numeric values here are narrower than in a detailed statement. The NAV date is treated
 * as right-aligned even though it reads left, because its value extends further right
 * than the header label above it.
 */
const NUMERIC_WIDTH = 42.0;

function summaryColumnRanges(columns) {
  const sorted = [...columns].sort((a, b) => (a.xLo + a.xHi) / 2 - (b.xLo + b.xHi) / 2);
  return sorted.map((column, index) => {
    if (column.alignment === 'right') {
      return [column, column.xHi - NUMERIC_WIDTH, column.xHi + 3.0];
    }
    const lo = column.xLo - 3.0;
    const next = sorted[index + 1];
    if (!next) return [column, lo, Infinity];
    const hi = next.alignment === 'right' ? next.xHi - NUMERIC_WIDTH : next.xLo - 3.0;
    return [column, lo, hi];
  });
}

export function assignSummaryCells(line, columns) {
  const ranges = summaryColumnRanges(columns);
  const buckets = new Map(columns.map((c) => [c.label, []]));

  for (const char of line.chars) {
    const midpoint = (char.x0 + char.x1) / 2;
    for (const [column, lo, hi] of ranges) {
      if (midpoint >= lo && midpoint < hi) {
        buckets.get(column.label).push(char);
        break;
      }
    }
  }

  const cells = {};
  for (const [label, chars] of buckets) {
    if (!chars.length) continue;
    chars.sort((a, b) => a.x0 - b.x0);
    const heights = chars.map((c) => c.h).sort((a, b) => a - b);
    const median = heights[Math.floor(heights.length / 2)];
    const gap = Math.max(1.5, 0.6 * median);
    const parts = [];
    let previousRight = null;
    for (const char of chars) {
      if (previousRight !== null && char.x0 - previousRight > gap) parts.push(' ');
      parts.push(char.text);
      previousRight = char.x1;
    }
    cells[label] = parts.join('').trim();
  }
  return cells;
}

// ------------------------------------------------------------------------- parsing

/** At least six digits: a short number in disclaimer text is not a folio. */
const FOLIO_CELL_RE = /^\s*(\d{6,}(?:\s*\/\s*\d+)?)/;
const ISIN_CELL_RE = /(INF[A-Z0-9]{8}\d)/;
const SUMMARY_DATE_RE = /as\s+on\s+(\d{2}-[A-Za-z]{3}-\d{4})/i;

/** `<code>-<scheme name>`, where the code is short and has no spaces around the dash. */
const SCHEME_CELL_RE = /^\s*([\w\s]{2,15}?)\s*-\s*([\s\S]+)$/;

/**
 * A scheme cell looks like data when it starts with an alphanumeric code, then a dash,
 * then the name. Disclaimer rows lack that exact prefix shape.
 */
const SCHEME_LOOKS_LIKE_DATA = /^\s*[A-Z0-9][\w\s]{1,15}\s*-\s*\S/;

/**
 * The holdings table ends with a total row carrying the portfolio grand total. Everything
 * after it is notes, disclaimers and the watermark, none of which must bleed into the
 * last scheme's name. A real continuation is a fragment, never a row beginning "Total".
 */
const SUMMARY_TOTAL_RE = /^\s*(?:grand\s+|sub\s+|portfolio\s+)?total\b/i;

/**
 * Reads a summary statement.
 *
 * @param {object} document an open PDF document from a backend
 * @param {string} fileType the issuer, as detected by the dispatcher
 */
export async function parse(document, fileType = FileType.UNKNOWN) {
  const pages = await extractPages(document);

  let statementDate = null;
  const folios = new Map();
  let currentAmc = null;
  let currentFolio = null;
  let currentScheme = null;
  let lastColumns = [];

  for (const page of pages) {
    const headerPosition = detectSummaryColumns(page.lines, 0);
    let headerIndex;
    let columns;
    if (headerPosition) {
      [headerIndex, columns] = headerPosition;
      lastColumns = columns;
    } else {
      headerIndex = -1;
      columns = lastColumns;
    }

    for (let i = 0; i < page.lines.length; i += 1) {
      const line = page.lines[i];
      const text = line.text;

      if (statementDate === null) {
        const match = SUMMARY_DATE_RE.exec(text);
        if (match) statementDate = match[1];
      }

      const amcMatch = AMC_RE.exec(text.trim());
      if (amcMatch) {
        currentAmc = amcMatch[0];
        continue;
      }

      if (!columns.length || i <= headerIndex) continue;

      const cells = assignSummaryCells(line, columns);
      let folioCell = (cells.Folio || '').trim();
      // A folio with a "/0" suffix can overflow into the ISIN column, and a long one can
      // push the ISIN aside, so the cell text is a hint and the ISIN is pulled by shape.
      const isinRaw = (cells.ISIN || '').trim();
      const isinMatch = ISIN_CELL_RE.exec(isinRaw) || ISIN_CELL_RE.exec(folioCell);
      const isinCell = isinMatch ? isinMatch[1] : '';

      // Recover a folio truncated by that overflow. No match means the cell holds
      // something else entirely, so clear it rather than treat the row as a main one.
      const folioMatch = FOLIO_CELL_RE.exec(folioCell);
      folioCell = folioMatch ? folioMatch[1].trim() : '';

      const schemeCell = (cells.Scheme || '').trim();
      const balanceCell = (cells.Balance || '').trim();
      const navDateCell = (cells.NAVDate || '').trim();
      const navCell = (cells.NAV || '').trim();
      const valueCell = (cells.MarketValue || '').trim();
      const costCell = (cells.Cost || '').trim();
      const rtaCell = (cells.Registrar || '').trim();

      // End of the holdings table. Drop the current scheme so the trailing notes cannot
      // be appended to its name as bogus continuations; a later real row re-establishes
      // it, which is what happens when a sub-total precedes the next AMC.
      if (!folioCell
        && (SUMMARY_TOTAL_RE.test(schemeCell) || SUMMARY_TOTAL_RE.test(text.trim()))) {
        currentScheme = null;
        continue;
      }

      // A main row has both a folio number and a scheme cell shaped like data, which
      // rejects footer text that happens to land partly in either zone.
      const isMain = Boolean(folioCell) && Boolean(schemeCell)
        && SCHEME_LOOKS_LIKE_DATA.test(schemeCell);

      // A genuine wrapped name lands only in the scheme column, with every numeric, date
      // and registrar zone empty. Requiring that rejects a footer row carrying a stray
      // amount that also spills into the scheme zone.
      const isContinuation = currentScheme !== null && !folioCell && Boolean(schemeCell)
        && !navDateCell && !balanceCell && !navCell && !valueCell && !costCell;

      if (isMain) {
        const folioNumber = folioCell.trim();
        if (!folios.has(folioNumber)) {
          folios.set(folioNumber, new Folio({
            folio: folioNumber,
            amc: currentAmc || 'UNKNOWN',
            PAN: '',
            KYC: null,
            PANKYC: null,
            schemes: [],
          }));
        }
        currentFolio = folios.get(folioNumber);

        let code = '';
        let name = schemeCell;
        const schemeMatch = SCHEME_CELL_RE.exec(schemeCell);
        if (schemeMatch) {
          code = schemeMatch[1].trim();
          name = schemeMatch[2].trim();
        }

        const balance = toDecimal(balanceCell) || ZERO;
        const nav = toDecimal(navCell) || ZERO;
        const cost = costCell ? toDecimal(costCell) : null;
        const marketValue = toDecimal(valueCell) || ZERO;
        const isin = isinCell || null;

        // A real date object, so a "01-Jan-2015" string is never mistaken for an ISO one.
        let navDate = CasDate.tryParse(navDateCell.replace(/[-\s]+/g, '-'));
        if (!navDate && statementDate) navDate = CasDate.tryParse(statementDate);
        if (!navDate) navDate = CasDate.parse('1970-01-01');

        const rtaForLookup = rtaCell || 'CAMS';
        const [resolvedIsin, amfi, schemeType] = isinSearch(name, rtaForLookup, code, isin);

        currentScheme = new Scheme({
          scheme: name,
          advisor: null,
          rta: rtaForLookup,
          rta_code: code,
          isin: resolvedIsin || isin,
          amfi,
          type: schemeType || 'N/A',
          open: balance,
          close: balance,
          close_calculated: balance,
          valuation: new SchemeValuation({
            date: navDate, nav, value: marketValue, cost,
          }),
          transactions: [],
        });
        currentFolio.schemes.push(currentScheme);
        continue;
      }

      if (isContinuation) {
        currentScheme.scheme = `${currentScheme.scheme} ${schemeCell}`.trim();
      }
    }
  }

  const atoms = await collectAtoms(document);
  return new CASData({
    statement_period: statementDate
      ? new StatementPeriod({ from: statementDate, to: statementDate })
      : new StatementPeriod({ from: '', to: '' }),
    folios: [...folios.values()],
    investor_info: extractCamsKfinInvestor(atoms),
    cas_type: CASFileType.SUMMARY,
    file_type: fileType,
  });
}

export { Decimal };
