/**
 * The CAMS and KFin detailed statement reader.
 *
 * Reads each page's transaction table by finding the column boundaries and assigning
 * every character to a column by its x midpoint. Handles multi-page, multi-AMC statements
 * with a folio and scheme header per block, the six standard transaction columns, the
 * labelled opening and closing balance rows, and the NAV, valuation and cost footer.
 *
 * Two known limits, both inherited and both deliberate: a multi-line transaction
 * description keeps only its first line, and a segregated portfolio is classified but is
 * not fully supported by the capital-gains side.
 */

import { CASFileType, FileType, TransactionType } from '../enums.js';
import { Decimal, ZERO } from '../decimal.js';
import { CasDate } from '../dates.js';
import {
  CASData, Folio, Scheme, SchemeValuation, StatementPeriod, TransactionData,
} from '../types.js';
import { extractGiftFolio, getParsedSchemeName, getTransactionType } from './classify.js';
import { extractCamsKfinInvestor } from './investor.js';
import { isinSearch } from '../isin.js';
import { extractPages } from './extract.js';

// ---------------------------------------------------------------------- columns

/**
 * The header is two physical rows: "Date Transaction Amount Units Price Unit" over
 * "(INR) (INR) Balance". Four of these labels on one window is enough to call it a
 * header.
 */
const TXN_HEADER_LABELS = new Set([
  'Date', 'Transaction', 'Amount', 'Units', 'Price', 'Unit', 'Balance', 'NAV',
]);
const TXN_MIN_HITS = 4;

/** Every numeric column is right-aligned; date and description are left-aligned. */
const ALIGN = {
  Date: 'left',
  Transaction: 'left',
  Amount: 'right',
  Units: 'right',
  Price: 'right',
  'Unit Balance': 'right',
  NAV: 'right',
};

export class Column {
  constructor(label, xLo, xHi, alignment) {
    this.label = label;
    this.xLo = xLo;
    this.xHi = xHi;
    this.alignment = alignment;
  }

  /** Where a value in this column snaps to. */
  get xAnchor() {
    return this.alignment === 'right' ? this.xHi : this.xLo;
  }
}

/** Splits a line into `[text, x0, x1]` words wherever the horizontal gap is wide enough. */
export function wordsOnLine(line, minGap = 1.5) {
  const chars = [...line.chars].sort((a, b) => a.x0 - b.x0);
  const words = [];
  let current = '';
  let x0 = null;
  let x1 = null;

  for (const char of chars) {
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
 * The vertical span that counts as one header block. CAMS uses two baselines over about
 * ten points; KFin uses four over about eleven.
 */
const HEADER_WINDOW_Y = 15.0;

/**
 * Finds the next transaction-table header at or after `startIndex`.
 *
 * A header is a run of consecutive lines spanning no more than `HEADER_WINDOW_Y` points
 * that between them carry at least `TXN_MIN_HITS` distinct column labels. Collecting
 * labels across the whole window means a wrapped "Unit"/"Balance" pair and KFin's
 * four-baseline split behave the same.
 *
 * @returns {[number, number, Column[]]|null} first and last line index of the header
 *   window, and the columns
 */
export function detectTxnColumns(lines, startIndex) {
  for (let i = startIndex; i < lines.length; i += 1) {
    const window = [lines[i]];
    for (let j = i + 1; j < lines.length; j += 1) {
      if (lines[i].baseline - lines[j].baseline > HEADER_WINDOW_Y) break;
      window.push(lines[j]);
    }

    const allWords = window.flatMap((line) => wordsOnLine(line));
    const labels = new Set(allWords.map((w) => w[0]).filter((w) => TXN_HEADER_LABELS.has(w)));
    if (labels.size < TXN_MIN_HITS) continue;

    return [i, i + window.length - 1, buildColumns(allWords)];
  }
  return null;
}

/** Maps header words to columns, folding "Unit" and "Balance" into one. */
function buildColumns(words) {
  const columns = [];
  const texts = words.map((w) => w[0]);

  for (const [text, x0, x1] of words) {
    if (text === 'Unit' && texts.includes('Balance')) {
      for (const [otherText, otherX0, otherX1] of words) {
        if (otherText !== 'Balance') continue;
        if (Math.abs((otherX0 + otherX1) / 2 - (x0 + x1) / 2) >= 30) continue;
        columns.push(new Column(
          'Unit Balance', Math.min(x0, otherX0), Math.max(x1, otherX1), 'right',
        ));
        break;
      }
    } else if (ALIGN[text] && text !== 'Unit' && text !== 'Balance') {
      columns.push(new Column(text, x0, x1, ALIGN[text]));
    }
  }
  columns.sort((a, b) => a.xLo - b.xLo);
  return columns;
}

/**
 * How far left of its anchor a right-aligned value can start. Wide enough for any
 * plausible amount, narrow enough to exclude wrapped description text bleeding in.
 */
const NUMERIC_ZONE_WIDTH = 55.0;

/**
 * The x range each column owns.
 *
 * The asymmetry is the whole point: a description is wide and naturally runs into the
 * amount column's space, while the amount itself sits in a narrow zone against the
 * column's right edge. So a numeric column is bounded by how wide its content can be, not
 * by the midpoint to its neighbour.
 */
function columnRanges(columns) {
  const sorted = [...columns].sort((a, b) => (a.xLo + a.xHi) / 2 - (b.xLo + b.xHi) / 2);
  return sorted.map((column, index) => {
    if (column.alignment === 'right') {
      return [column, column.xHi - NUMERIC_ZONE_WIDTH, column.xHi + 3.0];
    }
    const lo = column.xLo - 3.0;
    const next = sorted[index + 1];
    if (!next) return [column, lo, Infinity];
    const hi = next.alignment === 'right' ? next.xHi - NUMERIC_ZONE_WIDTH : next.xLo - 3.0;
    return [column, lo, hi];
  });
}

/** Renders a bucket of characters as cell text, inserting spaces at real gaps. */
function renderCell(chars) {
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
  return parts.join('').trim();
}

/**
 * Buckets each character into a column by x midpoint and renders the cells. Overlay
 * duplicates were already filtered at the atom level.
 */
export function assignCells(line, columns) {
  const ranges = columnRanges(columns);
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
    if (chars.length) cells[label] = renderCell(chars);
  }
  return cells;
}

// ------------------------------------------------------------------ label parsers

/**
 * A folio header. The number may carry a sub-account suffix after a slash. PAN, KYC and
 * PAN-KYC are each optional but appear in this order when present; the lazy gap lives
 * inside the optional group so a minimal match cannot skip past it and leave the capture
 * empty.
 */
export const FOLIO_LINE_RE = new RegExp(
  'Folio\\s+No\\s*:\\s*(\\d+(?:\\s*/\\s*\\d+)?)'
  + '(?:[\\s\\S]*?PAN\\s*:\\s*([A-Z]{5}\\d{4}[A-Z]))?'
  + '(?:[\\s\\S]*?KYC\\s*:\\s*(OK|NOT OK))?'
  + '(?:[\\s\\S]*?PAN\\s*:\\s*(OK|NOT OK))?',
  'i',
);
const INLINE_ISIN_RE = /[-\s]*ISIN\s*:\s*([A-Z0-9]+)/i;
const INLINE_ADVISOR_RE = /[-\s]*\(\s*Advisor\s*:\s*([^)]+?)\)/i;
const INLINE_ADVISOR_GLOBAL_RE = /[-\s]*\(\s*Advisor\s*:\s*([^)]+?)\)/gi;
const SCHEME_HEAD_RTA_RE = /Registrar\s*:\s*(\S+)/i;

/**
 * A complete fund ISIN: `INF`, eight alphanumerics, a check digit. Used to reject a
 * truncated one, which is what a value wrapping across the `Registrar :` label produces —
 * and a partial ISIN suppresses the name-and-code fallback, so the scheme ends up with
 * none at all.
 */
const FULL_ISIN_RE = /^INF[0-9A-Z]{8}\d$/;
const ISIN_ANYWHERE_RE = /\bINF[0-9A-Z]{8}\d\b/;

/**
 * Known registrars. The value after `Registrar :` is not reliably the registrar: some
 * templates interleave an advisor annotation, an ISIN continuation, or a watermark
 * fragment between the label and the name. Picking the recognised token out of the
 * stitched header is more robust than trusting position.
 */
const RTA_TOKEN_RE = /\b(CAMS|KFINTECH|KFIN|KARVY)\b/i;

const OPEN_BAL_RE = /Opening\s+Unit\s+Balance\s*:?\s*([\d,.]+)/i;
const CLOSE_BAL_RE = /Closing\s+Unit\s+Balance\s*:?\s*([\d,.]+)/i;
const NAV_RE = /NAV\s+on\s+(\d{2}-[A-Za-z]{3}-\d{4})\s*:\s*INR\s*([\d,.]+)/i;
const VALUATION_RE = /(?:Valuation|Market\s+Value)\s+on\s+(\d{2}-[A-Za-z]{3}-\d{4})\s*:\s*INR\s*([\d,.]+)/i;
const COST_VALUE_RE = /Total\s+Cost\s+Value\s*:?\s*([\d,.]+)/i;

/** Up to three nominee slots; an empty one means no nominee at that position. */
const NOMINEE_RE = new RegExp(
  'Nominee\\s+1\\s*:\\s*(?<n1>[^:]*?)\\s*'
  + '(?:Nominee\\s+2\\s*:\\s*(?<n2>[^:]*?)\\s*'
  + '(?:Nominee\\s+3\\s*:\\s*(?<n3>[\\s\\S]*?))?)?$',
  'i',
);

const STMT_PERIOD_RE = /(\d{2}-[A-Za-z]{3}-\d{4})\s+To\s+(\d{2}-[A-Za-z]{3}-\d{4})/i;

/**
 * An AMC section heading. Most end in "Mutual Fund" or "MF"; a few newer houses use
 * "Fund House". Anchoring on the suffix stops a disclaimer that happens to mention an AMC
 * mid-sentence from being read as a section boundary.
 */
export const AMC_RE = /^(.+?\s+(?:MF|Mutual\s*Fund|Fund\s*House))$/i;

/**
 * The leading date of a transaction row. Accepts `25-Oct-2021`, `25 Oct 2021`,
 * `25Oct2021`; dashes sometimes sit on a different baseline. Anchored only at the start,
 * so a stray trailing character (KFin's instalment number leaking out of the description
 * column) does not defeat it.
 */
export const DATE_CELL_RE = /^\s*(\d{1,2}[-\s]*[A-Za-z]{3}[-\s]*\d{4})/;

/** Parses a printed amount, treating parentheses as a negative sign. */
export function toDecimal(text) {
  if (text === null || text === undefined) return null;
  let value = String(text).trim();
  if (!value) return null;

  const negative = value.startsWith('(') || value.startsWith('-');
  value = value.replace(/^\(+/, '').replace(/\)+$/, '').replace(/^-+/, '').replace(/,/g, '');
  try {
    const parsed = Decimal.parse(value);
    return negative ? parsed.neg() : parsed;
  } catch {
    return null;
  }
}

// ------------------------------------------------------- running-balance validator

const BALANCE_TOLERANCE = Decimal.parse('0.005');

/**
 * Cross-checks each row's units against the printed running balance and flips the sign of
 * a single-row mis-read.
 *
 * Some templates print a reversed row with cosmetic parentheses around the units even
 * though the semantic sign is the opposite. The running balance column is unambiguous, so
 * it is trusted: where `previous + units` misses but `previous - units` lands, the units
 * and the matching amount are flipped and the row is reclassified, which can move it out
 * of the default redemption bucket entirely.
 *
 * Rows with no units and rows with no printed balance cannot be checked and are skipped.
 */
export function applyBalanceSignFix(scheme) {
  let previous = scheme.open === null ? ZERO : Decimal.from(scheme.open);

  for (const txn of scheme.transactions) {
    if (txn.units === null || txn.balance === null || previous === null) continue;
    const units = Decimal.from(txn.units);
    const balance = Decimal.from(txn.balance);

    if (previous.add(units).sub(balance).abs().lte(BALANCE_TOLERANCE)) {
      previous = balance;
      continue;
    }
    if (previous.sub(units).sub(balance).abs().lte(BALANCE_TOLERANCE)) {
      const flipped = units.neg();
      txn.units = flipped;
      if (txn.amount !== null) txn.amount = Decimal.from(txn.amount).neg();
      const [type, rate] = getTransactionType(txn.description, flipped);
      txn.type = type;
      txn.dividend_rate = rate;
    }
    previous = balance;
  }

  let total = scheme.open === null ? ZERO : Decimal.from(scheme.open);
  for (const txn of scheme.transactions) {
    if (txn.units !== null) total = total.add(txn.units);
  }
  scheme.close_calculated = total;
}

/**
 * Checks the transactions against the printed running balance, which is the statement's
 * own checksum.
 *
 * Every row prints the balance after it, so `previous + units` must equal it. Where it
 * does not, a row was dropped or garbled between the two — the most dangerous failure
 * mode, because the parse still looks fine. On a mismatch the running total resyncs to
 * the printed figure, so one missing row produces one warning instead of cascading. A
 * final closing check catches a drop that no later printed balance would expose.
 */
export function reconcileBalances(scheme) {
  const warnings = [];
  const label = `'${scheme.scheme}' [${scheme.rta_code}]`;
  let running = scheme.open === null ? ZERO : Decimal.from(scheme.open);

  for (const txn of scheme.transactions) {
    if (txn.units !== null) running = running.add(txn.units);
    if (txn.balance === null) continue;
    const printed = Decimal.from(txn.balance);
    if (running.sub(printed).abs().gt(BALANCE_TOLERANCE)) {
      warnings.push(
        `${label}: unit-balance discontinuity at ${txn.date} (${txn.type}), computed `
        + `${running} but statement printed ${printed} (delta=${running.sub(printed)}); `
        + 'a transaction row may be missing or mis-parsed',
      );
      running = printed;
    }
  }

  if (scheme.close !== null) {
    const close = Decimal.from(scheme.close);
    if (running.sub(close).abs().gt(BALANCE_TOLERANCE)) {
      warnings.push(
        `${label}: closing unit balance mismatch, computed ${running} but statement `
        + `printed ${close} (delta=${running.sub(close)}); a transaction row may be `
        + 'missing or mis-parsed',
      );
    }
  }
  return warnings;
}

// ------------------------------------------------------------ scheme header region

/**
 * Marks a line as carrying scheme-header content: an annotation label, an advisor code, a
 * registrar token, or a scheme-code line whose code contains a letter. The letter rule is
 * what separates a real scheme line from the investor name, address, date range and load
 * notes that also sit between the folio line and the opening balance.
 */
const HEADER_MARKER_RE = /Registrar\s*:|Advisor\s*:|ISIN\s*:|Nominee\s+\d|\bARN-?\d+\b|\bINA\d+\b/i;

/**
 * A scheme code may contain internal spaces, so the rule is alphanumeric tokens with at
 * least one letter somewhere and the dash glued to the last token. "Entry Load - NIL" has
 * a space before its dash and "01-Jan-1990" has a digits-only leading token, so neither
 * qualifies.
 */
const SCHEME_CODE_RE = /^\s*(?=[A-Z0-9 ]{0,40}[A-Z])[A-Z0-9]+(?: [A-Z0-9]+)*-/i;

/**
 * A trailing unfinished marker means the value continues on the next line, which may
 * carry no marker of its own, so whatever follows a dangling line joins the header
 * regardless of its own content.
 */
const TRAILING_MARKER_RE = /(Registrar\s*:|Advisor\s*:|ISIN\s*:|\(\s*Advisor\s*:)\s*$/i;

/**
 * Scheme-name cleanup happens in two passes.
 *
 * First, excise the annotations a template splices into the *middle* of a name — a closed
 * advisor note and a valued ISIN — so the text on both sides survives. Income-distribution
 * templates routinely emit `... - IDCW - ISIN: INF... - Payout (Advisor:...)`, and cutting
 * at the first annotation would amputate the qualifier that tells the two variants apart.
 *
 * Then cut at the first marker that genuinely ends the name.
 *
 * A valueless `ISIN:`, left behind when its value wrapped, is deliberately neither
 * excised nor cut: the trailing-punctuation cleanup in `getParsedSchemeName` handles it,
 * and matching the original's output matters more than the cosmetics.
 */
const NAME_EXCISE_ISIN_RE = /[-\s]*ISIN\s*:\s*INF[A-Z0-9]*/gi;
const NAME_TERMINATOR_RE = new RegExp(
  '\\(\\s*Advisor\\s*:'
  + '|Registrar\\s*:?'
  + '|Nominee\\s+\\d'
  + '|\\bARN-?\\d+\\b|\\bINA\\d+\\b'
  + '|\\b(?:CAMS|KFINTECH|KFIN|KARVY)\\b',
  'i',
);
const ADVISOR_CODE_RE = /\b(ARN-?\d+|INA\d+)\b/i;

function isHeaderLine(text) {
  return HEADER_MARKER_RE.test(text) || RTA_TOKEN_RE.test(text) || SCHEME_CODE_RE.test(text);
}

/** True when the line leaves a marker's value dangling onto the next one. */
function expectsContinuation(text) {
  if (TRAILING_MARKER_RE.test(text.trim())) return true;
  const advisor = /\(\s*Advisor\s*:/i.exec(text);
  return Boolean(advisor) && !text.slice(advisor.index + advisor[0].length).includes(')');
}

/**
 * The index of the region's `<code>-<name>` scheme line.
 *
 * "ARN" is a distributor's registration prefix, never a scheme code, so an advisor-value
 * wrap line is not a scheme.
 */
function findSchemeLine(lines) {
  for (let i = 0; i < lines.length; i += 1) {
    if (!SCHEME_CODE_RE.test(lines[i])) continue;
    const head = lines[i].split('-')[0].trim().toUpperCase();
    if (head === 'ARN') continue;
    return i;
  }
  return null;
}

/**
 * The region lines that make up the stitched scheme header. A line joins if it carries
 * header content or if the previous member left a value dangling; everything else is
 * ignored, so junk in the region is harmless because it never joins.
 */
function headerMemberIndices(lines) {
  const out = [];
  let forced = false;
  lines.forEach((line, index) => {
    if (forced || isHeaderLine(line)) {
      out.push(index);
      forced = expectsContinuation(line);
    } else {
      forced = false;
    }
  });
  return out;
}

/**
 * Locates a scheme-header candidate in a region buffer.
 *
 * The gate is a scheme line plus `Registrar` evidence in the stitched member text, shared
 * between building a scheme and warning about a region that was thrown away unbuilt. A
 * hyphenated word can look like a code line, but it never comes with a registrar label.
 */
function regionCandidate(buffer) {
  const lines = buffer.map((line) => line.trim()).filter(Boolean);
  if (!lines.length) return null;
  const schemeIndex = findSchemeLine(lines);
  if (schemeIndex === null) return null;
  const members = headerMemberIndices(lines);
  const headerText = members.map((i) => lines[i]).join(' ');
  if (!headerText.includes('Registrar')) return null;
  return { lines, schemeIndex, members, headerText };
}

/**
 * Builds a scheme from an accumulated header region.
 *
 * The buffer holds every line between the folio line, or the previous scheme's footer,
 * and this scheme's opening balance. The accumulation loop is deliberately dumb; all the
 * judgment lives here, where the whole region is visible at once. Each field is extracted
 * with its own unanchored search rather than one do-everything header pattern, so a stray
 * line can pollute at most the single field whose pattern it happens to match.
 *
 * The name is the only positional field: whatever follows `<code>-` on the scheme line,
 * plus any member lines below it, cut at the first annotation.
 */
function buildSchemeFromBuffer(buffer, statementPeriod) {
  const candidate = regionCandidate(buffer);
  if (!candidate) return null;
  const { lines, schemeIndex, members, headerText } = candidate;

  const schemeLine = lines[schemeIndex];
  const dashAt = schemeLine.indexOf('-');
  const code = (dashAt >= 0 ? schemeLine.slice(0, dashAt) : schemeLine).trim();
  const rest = dashAt >= 0 ? schemeLine.slice(dashAt + 1) : '';

  let nameText = [rest, ...members.filter((i) => i > schemeIndex).map((i) => lines[i])].join(' ');
  nameText = nameText.replace(INLINE_ADVISOR_GLOBAL_RE, '');
  nameText = nameText.replace(NAME_EXCISE_ISIN_RE, '');
  const cut = NAME_TERMINATOR_RE.exec(nameText);
  const name = getParsedSchemeName(cut ? nameText.slice(0, cut.index) : nameText);

  const isinMatch = INLINE_ISIN_RE.exec(headerText);
  let inlineIsin = isinMatch ? isinMatch[1].trim() : null;
  if (!inlineIsin || !FULL_ISIN_RE.test(inlineIsin)) {
    const anywhere = ISIN_ANYWHERE_RE.exec(headerText);
    inlineIsin = anywhere ? anywhere[0] : null;
  }

  const advisorMatch = INLINE_ADVISOR_RE.exec(headerText);
  let advisor = advisorMatch ? advisorMatch[1].trim() : null;
  // When the advisor value wrapped below an interleaved registrar line, the capture looks
  // like "Registrar : CAMS ARN-28283"; narrow it back to the distributor code.
  if (advisor) {
    const advisorCode = ADVISOR_CODE_RE.exec(advisor);
    if (advisorCode) advisor = advisorCode[1];
  }

  const rtaToken = RTA_TOKEN_RE.exec(headerText);
  let rta;
  if (rtaToken) {
    rta = rtaToken[1].toUpperCase();
  } else {
    const labelled = SCHEME_HEAD_RTA_RE.exec(headerText);
    rta = (labelled ? labelled[1].trim() : '') || 'CAMS';
  }

  const [isin, amfi, schemeType] = isinSearch(name, rta, code, inlineIsin);

  // Nominees are matched per line, not on the joined text, because the pattern is
  // end-anchored: the nominee list has to sit at the end of its own line.
  let nominees = [];
  for (const line of lines) {
    const match = NOMINEE_RE.exec(line);
    if (!match) continue;
    nominees = [match.groups.n1, match.groups.n2, match.groups.n3]
      .map((value) => (value || '').trim())
      .filter(Boolean);
    break;
  }

  return new Scheme({
    scheme: name,
    advisor,
    rta,
    rta_code: code,
    isin,
    amfi,
    type: schemeType || 'N/A',
    nominees,
    open: ZERO,
    close: ZERO,
    close_calculated: ZERO,
    valuation: new SchemeValuation({
      date: statementPeriod ? statementPeriod.to : '1970-01-01',
      nav: ZERO,
      value: ZERO,
    }),
    transactions: [],
  });
}

/**
 * The warning for a header region thrown away without its opening balance anchor: that
 * scheme and all of its transactions would otherwise vanish silently. Reported only when
 * the region passes the same gate as scheme building, so the routine junk after a folio's
 * last footer stays quiet.
 */
function abandonedRegionWarning(buffer, where) {
  const candidate = regionCandidate(buffer);
  if (!candidate) return null;
  const snippet = candidate.lines[candidate.schemeIndex].slice(0, 80);
  return `scheme header region discarded at ${where} without an 'Opening Unit Balance' `
    + `anchor; its scheme and transactions were skipped: '${snippet}'`;
}

// ------------------------------------------------------------------- top-level parse

/**
 * Reads a detailed statement.
 *
 * @param {object} document an open PDF document from a backend
 * @param {string} fileType the issuer, as detected by the dispatcher
 */
export async function parse(document, fileType = FileType.UNKNOWN) {
  const pages = await extractPages(document);

  let statementPeriod = null;
  // Keyed on AMC and folio together: a folio number is scoped to its registrar, not
  // globally unique, so two AMCs can share one and keying on the number alone would
  // quietly merge the second AMC's schemes into the first AMC's folio.
  const folios = new Map();
  let currentAmc = null;
  let currentFolio = null;
  let currentScheme = null;
  let lastColumns = [];

  // The scheme header is the only part of the grammar that wraps unpredictably;
  // everything else is a single anchor that never wraps. So rather than stitching
  // adjacent lines by proximity, every line of the region is collected and parsed once.
  // Declared outside the page loop so a header split across a page break still
  // accumulates.
  let headerBuffer = [];
  let headerActive = false;
  const parseWarnings = [];

  for (const page of pages) {
    const headerPosition = detectTxnColumns(page.lines, 0);
    let columnFirst;
    let headerIndex;
    let columns;
    if (headerPosition) {
      [columnFirst, headerIndex, columns] = headerPosition;
      lastColumns = columns;
    } else {
      // A continuation page. Inherit the previous columns; an empty header window
      // excludes nothing and transactions may start from the first line.
      columnFirst = -1;
      headerIndex = -1;
      columns = lastColumns;
    }

    for (let i = 0; i < page.lines.length; i += 1) {
      const line = page.lines[i];
      const text = line.text;

      if (statementPeriod === null) {
        const match = STMT_PERIOD_RE.exec(text);
        if (match) statementPeriod = new StatementPeriod({ from: match[1], to: match[2] });
      }

      const amcMatch = AMC_RE.exec(text.trim());
      if (amcMatch) {
        currentAmc = amcMatch[0];
        // An AMC boundary ends any dangling region, loudly if it still held a scheme.
        if (headerActive) {
          const warning = abandonedRegionWarning(headerBuffer, 'AMC boundary');
          if (warning) parseWarnings.push(warning);
        }
        headerBuffer = [];
        headerActive = false;
        continue;
      }

      // A real folio header is its own line. A transaction that *mentions* a folio in its
      // description — a gift transfer names the other side — also matches, but always
      // starts with a date. Rejecting dated rows stops a gift being read as a folio
      // boundary, which dropped the row and, where a scheme's own folio was redacted,
      // the whole scheme with it.
      if (text.includes('Folio No') && !DATE_CELL_RE.test(text)) {
        const match = FOLIO_LINE_RE.exec(text);
        if (match) {
          // The internal " / " is preserved, matching the original's output.
          const folioNumber = match[1].trim();
          const key = `${currentAmc || 'UNKNOWN'} ${folioNumber}`;
          if (!folios.has(key)) {
            folios.set(key, new Folio({
              folio: folioNumber,
              amc: currentAmc || 'UNKNOWN',
              PAN: match[2] || '',
              KYC: match[3] || null,
              PANKYC: match[4] || null,
              schemes: [],
            }));
          }
          currentFolio = folios.get(key);
          currentScheme = null;
          if (headerActive) {
            const warning = abandonedRegionWarning(headerBuffer, 'folio boundary');
            if (warning) parseWarnings.push(warning);
          }
          headerBuffer = [];
          headerActive = true;
          continue;
        }
      }

      // The opening balance closes the header region and builds the scheme from it.
      const openMatch = OPEN_BAL_RE.exec(text);
      if (openMatch) {
        if (headerActive) {
          currentScheme = buildSchemeFromBuffer(headerBuffer, statementPeriod);
          if (currentScheme !== null) {
            if (currentFolio) currentFolio.schemes.push(currentScheme);
          } else {
            // An opening balance implies a scheme header above it, so failing to parse
            // one drops the whole scheme, transactions included. Never silently.
            const region = headerBuffer.map((s) => s.trim()).filter(Boolean);
            const snippet = region.slice(0, 2).join(' / ').slice(0, 120);
            parseWarnings.push(
              "unparseable scheme header region before 'Opening Unit Balance' on page "
              + `${page.number}; the scheme and its transactions were skipped: '${snippet}'`,
            );
          }
          headerActive = false;
          headerBuffer = [];
        }
        if (currentScheme !== null) {
          currentScheme.open = toDecimal(openMatch[1]) || ZERO;
          currentScheme.close_calculated = currentScheme.open;
        }
        continue;
      }

      // Footer rows attach to the scheme just closed. The closing balance reopens the
      // region for the next scheme; the NAV, valuation and cost lines that follow belong
      // to this one and are consumed here rather than buffered. Nominee lines belong to
      // the *next* scheme's header, so while a region is open they fall through to the
      // buffer instead.
      let consumedFooter = false;
      if (currentScheme !== null) {
        const closeMatch = CLOSE_BAL_RE.exec(text);
        if (closeMatch) {
          currentScheme.close = toDecimal(closeMatch[1]) || ZERO;
          headerBuffer = [];
          headerActive = true;
          consumedFooter = true;
        }
        const navMatch = NAV_RE.exec(text);
        if (navMatch) {
          currentScheme.valuation.date = CasDate.parse(navMatch[1]);
          currentScheme.valuation.nav = toDecimal(navMatch[2]) || ZERO;
          consumedFooter = true;
        }
        const valuationMatch = VALUATION_RE.exec(text);
        if (valuationMatch) {
          currentScheme.valuation.date = CasDate.parse(valuationMatch[1]);
          currentScheme.valuation.value = toDecimal(valuationMatch[2]) || ZERO;
          consumedFooter = true;
        }
        const costMatch = COST_VALUE_RE.exec(text);
        if (costMatch) {
          currentScheme.valuation.cost = toDecimal(costMatch[1]);
          consumedFooter = true;
        }
        if (!headerActive) {
          const nomineeMatch = NOMINEE_RE.exec(text);
          if (nomineeMatch) {
            currentScheme.nominees = [
              nomineeMatch.groups.n1, nomineeMatch.groups.n2, nomineeMatch.groups.n3,
            ].map((value) => (value || '').trim()).filter(Boolean);
          }
        }
      }

      // Region accumulation. Reached only while a region is open: skip the footer anchors
      // just consumed and the column-header window, buffer everything else. Deliberately
      // judgment-free; which lines form the header is decided where the whole region is
      // visible at once.
      if (headerActive) {
        if (!consumedFooter && !(i >= columnFirst && i <= headerIndex)) headerBuffer.push(text);
        continue;
      }

      if (currentScheme === null) continue;

      // A transaction row, once we have columns and are past this page's header block.
      if (columns.length && i > headerIndex) {
        const cells = assignCells(line, columns);
        const rawDate = (cells.Date || '').trim();
        const description = (cells.Transaction || '').trim();
        const dateMatch = DATE_CELL_RE.exec(rawDate);
        if (!dateMatch) continue;
        // A dated row with no description is not a transaction.
        if (!description) continue;

        // Collapse runs of dashes and spaces left by overlay bleed-through, so
        // "15--Jan--2021" reads as "15-Jan-2021".
        const dateText = dateMatch[1].replace(/[-\s]+/g, '-').replace(/^-+|-+$/g, '');
        const amount = toDecimal(cells.Amount || '');
        const units = toDecimal(cells.Units || '');
        let nav = toDecimal(cells.Price || cells.NAV || '');
        const balance = toDecimal(cells['Unit Balance'] || '');

        // A row with neither an amount nor units is not a transaction: it is usually a
        // stray date in a footnote.
        if (amount === null && units === null) continue;

        // Some older templates omit the per-row price but always carry the amount and the
        // units, so derive the NAV rather than leaving the gains side with nothing.
        if (nav === null && amount !== null && units !== null && !units.isZero()) {
          nav = amount.div(units).quantize('0.0001');
        }

        const [txnType, dividendRate] = getTransactionType(description, units);
        const giftFolio = (txnType === TransactionType.GIFT_IN || txnType === TransactionType.GIFT_OUT)
          ? extractGiftFolio(description)
          : null;

        if (units !== null) {
          currentScheme.close_calculated = Decimal.from(currentScheme.close_calculated).add(units);
        }
        currentScheme.transactions.push(new TransactionData({
          date: CasDate.parse(dateText),
          description,
          amount,
          units,
          nav,
          balance,
          type: txnType,
          dividend_rate: dividendRate,
          gift_folio: giftFolio,
        }));
      }
    }
  }

  // A region still open at the end of the document means the closing anchor never came.
  if (headerActive) {
    const warning = abandonedRegionWarning(headerBuffer, 'end of document');
    if (warning) parseWarnings.push(warning);
  }

  // Fix cosmetic-parenthesis sign mis-reads first, then reconcile against the printed
  // running balance. Both are cheap, self-validating, and no-ops when the signs already
  // agree with the statement.
  for (const folio of folios.values()) {
    for (const scheme of folio.schemes) {
      applyBalanceSignFix(scheme);
      parseWarnings.push(...reconcileBalances(scheme));
    }
  }

  const atoms = await collectAtoms(document);
  return new CASData({
    statement_period: statementPeriod || new StatementPeriod({ from: '', to: '' }),
    folios: [...folios.values()],
    investor_info: extractCamsKfinInvestor(atoms),
    cas_type: CASFileType.DETAILED,
    file_type: fileType,
    parse_warnings: parseWarnings,
  });
}

/** Raw atoms per page, which is what the investor extractor works on. */
export async function collectAtoms(document) {
  const pages = [];
  for (let number = 1; number <= document.numPages; number += 1) {
    // eslint-disable-next-line no-await-in-loop
    const raw = await document.getAtoms(number);
    pages.push(raw.filter((atom) => !atom.vertical && atom.text && atom.text.trim()));
  }
  return pages;
}
