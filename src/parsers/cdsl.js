/**
 * The CDSL statement reader.
 *
 * Like the NSDL one, this consumes the `Block`/`Cell` structure from `pageobj.js` and
 * produces holdings directly.
 *
 * The layout, in document order (the absolute page numbers move with the holding count):
 *
 *   - cover and account roster: the investor address block, then the summary table
 *     enumerating each demat account and the fund-folio pseudo-account;
 *   - per-folio descriptive blocks: AMC, scheme name, folio, KYC, ISIN and client code,
 *     one group per folio, with no balances;
 *   - per-account sections: a `DP Name : ... BO ID : ...` header, the transactions, then
 *     a holding statement header and the holdings table;
 *   - a fund-units table with the full profit and loss per folio;
 *   - optionally an NPS section, holdings and transactions;
 *   - notes and footer.
 */

import { FileType } from '../enums.js';
import { Decimal, ZERO } from '../decimal.js';
import {
  DematAccount, DematOwner, Equity, MutualFund, NPSAccount, NPSScheme, NSDLCASData,
  StatementPeriod,
} from '../types.js';
import * as pageobj from './pageobj.js';
import { extractNsdlCdslInvestor } from './investor.js';

// ---------------------------------------------------------------------- patterns

export const ISIN_RE = /^[A-Z]{2}[0-9A-Z]{9}\d$/;
export const INF_ISIN_RE = /^INF[0-9A-Z]{8}\d$/;
export const INE_ISIN_RE = /^IN[E9][0-9A-Z]{8}\d$/;

const NUMERIC_RE = /^-?(?:[\d,]+(?:\.\d+)?|\.\d+)$/;

/**
 * A long folio wraps its tail onto the next display line, which arrives as a separate
 * cell: `91012112582/0` splits into `910121125` and `82/0`. The tail is spliced back on
 * with no separator, because the hyphen on the page is only a wrap marker and is absent
 * from the authoritative folio block.
 */
const FOLIO_TAIL_RE = /^\d+\/\d+$/;

const PERIOD_RE = new RegExp(
  '(?:for\\s+the\\s+period\\s+from|statement\\s+for\\s+the\\s+period\\s+from)\\s+'
  + '(\\d{2}[-/][A-Za-z0-9]{2,3}[-/]\\d{4})\\s+to\\s+(\\d{2}[-/][A-Za-z0-9]{2,3}[-/]\\d{4})',
  'i',
);

const DEMAT_TYPE_RE = /^(CDSL|NSDL)\s+Demat\s+Account\s*$/i;
const PAN_RE = /(.+?)\s*\(\s*PAN\s*:\s*([^)]+?)\s*\)/i;
const PAN_RE_GLOBAL = /(.+?)\s*\(\s*PAN\s*:\s*([^)]+?)\s*\)/gi;

/** The roster row carries `DP Id: <dp> Client Id : <client>`, spacing varies. */
const SUMMARY_DPC_RE = /DP\s*Id\s*:\s*(\S+?)\s+Client\s*Id\s*:\s*(\d+)/i;

/** A holdings section header: `DP Name : <broker> DP ID : <dp> CLIENT ID : <client>`. */
const SECTION_DPC_RE = /DP\s*Name\s*:\s*([\s\S]+?)\s+DP\s*ID\s*:\s*(\S+)\s+CLIENT\s*ID\s*:\s*(\S+)/i;

/**
 * A transaction-page header: `DP Name : <broker> BO ID : <16 characters>`. The identifier
 * concatenates the DP and client identifiers, eight characters each. A CDSL DP identifier
 * is numeric and an NSDL one starts with `IN`, so the field is either all digits or two
 * letters and fourteen digits.
 */
const SECTION_BOID_RE = /DP\s*Name\s*:\s*([\s\S]+?)\s+(?:BO\s*ID|DPID)\s*:\s*([A-Z0-9]{16})/i;

// ------------------------------------------------------------------ NPS patterns

/** Every NPS holding row's scheme name begins with this. */
const NPS_SCHEME_MARKER = 'nps trust';
const NPS_SP_RE = /NPS[-\s]*SP\s*:\s*([A-Za-z0-9]+)/i;
const NPS_PRAN_RE = /PRAN\s*ID\s*:\s*([A-Z0-9]+)/i;
const NPS_VALUE_RE = /Portfolio\s+Value[^\d]*([\d,]+\.\d+)/i;
const NPS_TIER_RE = /\bTIER\s*[-\s]*(I{1,2}|1|2)\b/i;
const NPS_ASSET_RE = /\bSCHEME\s+([A-Za-z])\b/;

/**
 * Text that marks a block as genuine NPS holding content. Used to skip the page furniture
 * that gets interleaved when a scheme row straddles a page break: the bank header, the
 * tab bar, the investor name, the column headings and the page footer.
 */
const NPS_HOLDING_TEXT_RE = /NPS\s+TRUST|PENSION\s+FUND|MANAGEMENT\s+LIMITED|SCHEME\s+[A-Z0-9]\s*-\s*TIER/i;

/**
 * The smallest horizontal gap that separates the two text columns, scheme name and fund
 * manager. Wrapped lines within a column share an x, so any gap this large is a real
 * column boundary, which makes the split independent of where the columns happen to sit.
 */
const NPS_COL_GAP_MIN = 150.0;

// --------------------------------------------------------------- decimal helpers

const BLANKS = new Set(['', '-', '--', 'N.A', 'NA']);

export function toDecimal(text) {
  if (text === null || text === undefined) return ZERO;
  const value = String(text).replace(/,/g, '').trim();
  if (BLANKS.has(value)) return ZERO;
  try {
    return Decimal.parse(value);
  } catch {
    return ZERO;
  }
}

export function optDecimal(text) {
  if (text === null || text === undefined) return null;
  const value = String(text).replace(/,/g, '').trim();
  if (BLANKS.has(value)) return null;
  try {
    return Decimal.parse(value);
  } catch {
    return null;
  }
}

export function looksNumeric(text) {
  const value = String(text ?? '').trim();
  if (!value) return false;
  return NUMERIC_RE.test(value);
}

function relClose(a, b, rel = Decimal.parse('0.005')) {
  if (b.isZero()) return a.abs().lte(Decimal.parse('0.01'));
  return a.sub(b).abs().div(b.abs()).lte(rel);
}

/**
 * Assigns the profit and the return percentage from the numbers after the value.
 *
 * Taking the last two positionally is wrong when a statement omits the profit column and
 * prints only the return. The identity `value - invested` picks the profit where it
 * exists; otherwise the profit is left unset and a small trailing number reads as a
 * percentage.
 */
function resolveMfPnlReturns(numerics, value, invested, hasDistributionColumn) {
  if (!hasDistributionColumn) return [null, null];

  const valueIndex = numerics.length >= 4 ? 3 : 2;
  const remaining = numerics.slice(valueIndex + 1)
    .map(toDecimal)
    .filter((amount) => !amount.isZero());

  const expectedPnl = invested !== null && invested.gt(0) ? value.sub(invested) : null;
  let pnl = null;
  let returns = null;

  if (expectedPnl !== null) {
    for (const amount of remaining) {
      if (relClose(amount, expectedPnl)) {
        pnl = amount;
        break;
      }
    }
    if (pnl === null && numerics.length >= 6) {
      const positional = optDecimal(numerics[numerics.length - 2]);
      if (positional !== null && relClose(positional, expectedPnl)) pnl = positional;
    }
  }

  const others = remaining.filter((amount) => pnl === null || !amount.eq(pnl));
  if (pnl !== null && others.length) {
    returns = others[others.length - 1];
  } else if (pnl === null && expectedPnl !== null) {
    for (const amount of others) {
      if (amount.abs().lt(Decimal.parse('100'))) {
        returns = amount;
        break;
      }
    }
  } else if (numerics.length >= 5) {
    returns = optDecimal(numerics[numerics.length - 1]);
  }

  if (pnl !== null && pnl.isZero()) pnl = null;
  if (returns !== null && returns.isZero()) returns = null;
  return [pnl, returns];
}

// ------------------------------------------------------------- account key helpers

export function fullType(typeWord) {
  return `${String(typeWord).toUpperCase()} Demat Account`;
}

export function accountKey(typeWord, dpId, clientId) {
  return [String(typeWord).toUpperCase(), String(dpId).trim(), String(clientId).trim()];
}

function keyString(key) {
  return key.join(' ');
}

/**
 * Splits a sixteen-character identifier into its parts. An NSDL DP identifier starts with
 * `IN`, a CDSL one is all digits; either way the client identifier is the last eight.
 */
export function splitBoId(boId) {
  if (String(boId).length !== 16) return ['', '', ''];
  const value = String(boId);
  if (value.slice(0, 2).toUpperCase() === 'IN') return ['NSDL', value.slice(0, 8), value.slice(8)];
  if (/^\d+$/.test(value)) return ['CDSL', value.slice(0, 8), value.slice(8)];
  return ['', '', ''];
}

// --------------------------------------------------------------------------- NPS

function normaliseTier(value) {
  const text = String(value).toUpperCase();
  if (text === '1') return 'I';
  if (text === '2') return 'II';
  return text;
}

/**
 * True when a block is part of an NPS holding row: it carries a number, or scheme and
 * fund-manager text. Everything else in the region is page furniture.
 */
function isNpsHoldingBlock(block) {
  return block.cells.some((cell) => looksNumeric(cell.text) || NPS_HOLDING_TEXT_RE.test(cell.text));
}

/**
 * Builds one NPS scheme from an accumulated row buffer.
 *
 * A row spans several extractor lines: two text columns, the scheme name and the fund
 * manager, plus two numbers, the units and the NAV. The text is split into columns by the
 * largest horizontal gap rather than a fixed threshold, because the column positions
 * drift between statement versions. The value is units times NAV. A row missing either
 * number, which is what a redacted statement gives, is skipped.
 */
function buildNpsScheme(cells) {
  const textCells = cells.filter((cell) => cell.text.trim() && !looksNumeric(cell.text));
  const numberCells = cells
    .filter((cell) => looksNumeric(cell.text))
    .sort((a, b) => a.xLeft - b.xLeft);

  const byX = [...textCells].sort((a, b) => a.xLeft - b.xLeft);
  let split = byX.length;
  if (byX.length >= 2) {
    let maxGap = -Infinity;
    let at = 0;
    for (let i = 0; i < byX.length - 1; i += 1) {
      const gap = byX[i + 1].xLeft - byX[i].xLeft;
      if (gap > maxGap || (gap === maxGap && i + 1 > at)) {
        maxGap = gap;
        at = i + 1;
      }
    }
    if (maxGap >= NPS_COL_GAP_MIN) split = at;
  }

  const nameCells = byX.slice(0, split).sort((a, b) => b.yTop - a.yTop);
  const managerCells = byX.slice(split).sort((a, b) => b.yTop - a.yTop);

  let scheme = nameCells.map((cell) => cell.text.replace(/\n/g, ' ').trim()).join(' ').trim();
  scheme = scheme.replace(/\s+/g, ' ');
  if (!scheme.toLowerCase().includes(NPS_SCHEME_MARKER)) return null;
  if (numberCells.length < 2) return null;

  let fundManager = managerCells.map((cell) => cell.text.replace(/\n/g, ' ').trim()).join(' ').trim();
  fundManager = fundManager.replace(/\s+/g, ' ') || null;

  const units = toDecimal(numberCells[0].text);
  const nav = toDecimal(numberCells[1].text);

  const tierMatch = NPS_TIER_RE.exec(scheme);
  const assetMatch = NPS_ASSET_RE.exec(scheme);

  return new NPSScheme({
    scheme,
    fund_manager: fundManager,
    tier: tierMatch ? normaliseTier(tierMatch[1]) : null,
    asset_class: assetMatch ? assetMatch[1].toUpperCase() : null,
    units,
    nav,
    value: units.mul(nav).quantize('0.01'),
  });
}

/**
 * Reads the NPS section, when there is one.
 *
 * Holdings only: the NPS transaction statement is deliberately not parsed. The scheme
 * name, fund manager, units and NAV come from the holding region; the subscriber
 * identifier, the service provider and the reported portfolio value come from the
 * section text. Returns null when the statement has no NPS section at all.
 */
export function parseNps(blocks) {
  let npsSp = null;
  let pran = null;
  let value = null;
  const schemes = [];
  let mode = null;
  let buffer = [];

  const flush = () => {
    if (!buffer.length) return;
    const scheme = buildNpsScheme(buffer);
    if (scheme !== null) schemes.push(scheme);
    buffer = [];
  };

  for (const block of blocks) {
    const text = block.text();
    const lower = text.toLowerCase();

    if (npsSp === null) {
      const match = NPS_SP_RE.exec(text);
      if (match) npsSp = match[1];
    }
    if (pran === null) {
      const match = NPS_PRAN_RE.exec(text);
      if (match) pran = match[1];
    }

    if (lower.includes('statement of transactions')) {
      flush();
      mode = 'txn';
      continue;
    }
    if (lower.includes('holding statement') && lower.includes('as on')) {
      flush();
      mode = 'holding';
      continue;
    }
    if (lower.includes('portfolio value')) {
      // This closes the holding region. The reported total is only taken when NPS
      // holdings are actually what is being closed.
      if (schemes.length || buffer.length) {
        const match = NPS_VALUE_RE.exec(text);
        if (match) value = toDecimal(match[1]);
      }
      flush();
      mode = null;
      continue;
    }
    if (lower.includes('nps investment summary')) {
      flush();
      mode = null;
      continue;
    }
    if (mode !== 'holding') continue;

    const startsScheme = block.cells
      .some((cell) => cell.text.trim().toLowerCase().startsWith(NPS_SCHEME_MARKER));
    if (startsScheme) {
      flush();
      buffer = [...block.cells];
    } else if (buffer.length && isNpsHoldingBlock(block)) {
      buffer.push(...block.cells);
    }
  }
  flush();

  if (!schemes.length && value === null && npsSp === null && pran === null) return null;
  if (value === null) {
    value = schemes.reduce((total, scheme) => total.add(scheme.value), ZERO);
  }
  return new NPSAccount({ pran, nps_sp: npsSp, value, schemes });
}

// ------------------------------------------------------------------- entry point

/**
 * Reads a CDSL statement.
 *
 * @param {object} document an open PDF document from a backend
 * @param {string} fileType the issuer, as detected by the dispatcher
 */
export async function parseCdsl(document, fileType = FileType.CDSL) {
  const atoms = await pageobj.extractAtoms(document);
  const blocks = pageobj.blocksFromAtoms(atoms);
  const period = findPeriod(blocks) || new StatementPeriod({ from: '', to: '' });

  // The account roster.
  const accountsByKey = new Map();
  const orderedAccounts = [];
  let mfFoliosAccount = null;
  let pendingOwners = [];

  for (const block of blocks) {
    if (block.page !== 2) continue;
    const text = block.text();
    const lower = text.toLowerCase();

    if (lower.includes('in the single name of') || lower.includes('in the joint name')) {
      pendingOwners = [];
      continue;
    }
    if (PAN_RE.test(text) && !text.includes('Mutual')) {
      PAN_RE_GLOBAL.lastIndex = 0;
      let match = PAN_RE_GLOBAL.exec(text);
      while (match) {
        pendingOwners.push(new DematOwner({ name: match[1].trim(), PAN: match[2].trim() }));
        match = PAN_RE_GLOBAL.exec(text);
      }
      continue;
    }
    if (isSummaryDematRow(block)) {
      const [account, key] = accountFromSummaryRow(block, pendingOwners);
      if (!accountsByKey.has(keyString(key))) {
        accountsByKey.set(keyString(key), account);
        orderedAccounts.push(account);
      }
      continue;
    }
    if (isSummaryMfFoliosRow(block)) {
      if (mfFoliosAccount === null) {
        mfFoliosAccount = mfFoliosAccountFromSummary(block, pendingOwners);
        orderedAccounts.push(mfFoliosAccount);
      }
    }
  }

  // Scheme code to client code, from the descriptive blocks that follow the roster. How
  // many pages they span depends on the folio count, so the scan runs from page three up
  // to the first per-account section and only consumes blocks matching the descriptive
  // template.
  const schemeMeta = new Map();
  let pending = {};
  for (const block of blocks) {
    if (block.page < 3) continue;
    const text = block.text();
    if (SECTION_BOID_RE.test(text)) break;

    if (text.includes('Scheme Name :') && text.includes('Scheme Code :')) {
      const match = /Scheme\s*Name\s*:\s*([\s\S]+?)\s+Scheme\s*Code\s*:\s*(\S+)/.exec(text);
      if (match) {
        pending = {
          scheme_name: match[1].replace(/\n/g, ' ').trim(),
          scheme_code: match[2].trim(),
        };
      }
    } else if (text.includes('Folio No :')) {
      const match = /Folio\s*No\s*:\s*(\S+)/.exec(text);
      if (match) pending.folio = match[1];
    } else if (text.includes('ISIN :') && text.includes('UCC')) {
      const isinMatch = /ISIN\s*:\s*(\S+)/.exec(text);
      const uccMatch = /UCC\s*:\s*([\w/]+)?/.exec(text);
      if (isinMatch && pending.scheme_code) {
        pending.isin = isinMatch[1];
        if (uccMatch && uccMatch[1]) pending.ucc = uccMatch[1];
        schemeMeta.set(pending.scheme_code, { ...pending });
        pending = {};
      }
    }
  }

  // The holdings tables. Pages one and two are skipped because the roster carries
  // identifiers that would otherwise read as section headers.
  let account = null;
  let mode = null;

  for (const block of blocks) {
    if (block.page < 3) continue;
    const text = block.text();
    const lower = text.toLowerCase();

    const boMatch = SECTION_BOID_RE.exec(text);
    if (boMatch) {
      const [typeWord, dpId, clientId] = splitBoId(boMatch[2]);
      if (typeWord) {
        account = accountsByKey.get(keyString(accountKey(typeWord, dpId, clientId))) || null;
        mode = null;
        continue;
      }
    }

    const dpcMatch = SECTION_DPC_RE.exec(text);
    if (dpcMatch) {
      let typeWord = 'CDSL';
      const upper = text.toUpperCase();
      if (upper.includes('NSDL') && !upper.includes('CDSL')) typeWord = 'NSDL';
      const key = accountKey(typeWord, dpcMatch[2].trim(), dpcMatch[3].trim());
      account = accountsByKey.get(keyString(key)) || null;
      mode = null;
      continue;
    }

    // A transaction section: turn holdings mode off so its rows are not read as holdings.
    if (lower.includes('statement of transactions')) {
      mode = null;
      continue;
    }
    if (lower.includes('holding statement') && lower.includes('as on')) {
      mode = 'equities';
      continue;
    }
    if (lower.includes('mutual fund units held as on')) {
      account = mfFoliosAccount;
      mode = 'mf_holdings';
      continue;
    }

    if (isHoldingsHeader(block) || isTotalRow(block)) continue;
    if (account === null || mode === null) continue;

    if (mode === 'equities') {
      const row = parseHoldingsRow(block);
      if (!row) continue;
      const [isin, name, numShares, price, value] = row;
      // These statements list exchange-traded funds in the same table as equities, but
      // they are fund units, so they are routed to the fund list.
      if (INF_ISIN_RE.test(isin)) {
        account.mutual_funds.push(new MutualFund({
          name, isin, balance: numShares, nav: price, value,
        }));
      } else {
        account.equities.push(new Equity({
          name, isin, num_shares: numShares, price, value,
        }));
      }
    } else if (mode === 'mf_holdings') {
      const fund = parseMfHoldingsRow(block, schemeMeta);
      if (fund) account.mutual_funds.push(fund);
    }
  }

  return new NSDLCASData({
    statement_period: period,
    accounts: orderedAccounts,
    investor_info: extractNsdlCdslInvestor(atoms),
    file_type: fileType,
    nps: parseNps(blocks),
  });
}

// -------------------------------------------------------- roster rows (page two)

export function isSummaryDematRow(block) {
  if (block.cells.length !== 4) return false;
  if (!DEMAT_TYPE_RE.test(block.cells[0].text.trim())) return false;
  return SUMMARY_DPC_RE.test(block.cells[1].text);
}

export function isSummaryMfFoliosRow(block) {
  if (block.cells.length !== 4) return false;
  return /^Mutual\s+Fund\s+Folios/i.test(block.cells[0].text.trim());
}

export function accountFromSummaryRow(block, owners = []) {
  const typeWord = DEMAT_TYPE_RE.exec(block.cells[0].text.trim())[1].toUpperCase();
  const brokerCell = block.cells[1].text;
  const lines = brokerCell.split('\n').map((line) => line.trim()).filter(Boolean);
  const identifiers = SUMMARY_DPC_RE.exec(brokerCell);
  const dpId = identifiers ? identifiers[1] : '';
  const clientId = identifiers ? identifiers[2] : '';

  const account = new DematAccount({
    name: lines.length ? lines[0] : '',
    type: fullType(typeWord),
    dp_id: dpId,
    client_id: clientId,
    folios: Number(toDecimal(block.cells[2].text).toBigInt()),
    balance: toDecimal(block.cells[3].text),
    owners: [...owners],
    equities: [],
    mutual_funds: [],
    bonds: [],
  });
  return [account, accountKey(typeWord, dpId, clientId)];
}

export function mfFoliosAccountFromSummary(block, owners = []) {
  const countMatch = /(\d+)/.exec(block.cells[1].text);
  return new DematAccount({
    name: 'Mutual Fund Folios',
    type: 'Mutual Fund Folios',
    dp_id: '',
    client_id: '',
    folios: countMatch ? Number(countMatch[1]) : 0,
    balance: toDecimal(block.cells[3].text),
    owners: [...owners],
    equities: [],
    mutual_funds: [],
    bonds: [],
  });
}

// -------------------------------------------------------------------- helpers

export function findPeriod(blocks) {
  for (const block of blocks) {
    const match = PERIOD_RE.exec(block.text());
    if (match) return new StatementPeriod({ from: match[1], to: match[2] });
  }
  return null;
}

/** A column-label row: no ISIN, and it reads like a set of headings. */
export function isHoldingsHeader(block) {
  const text = block.text();
  if (/\b(IN[EF9][0-9A-Z]{8}\d)\b/i.test(text)) return false;
  const lower = text.toLowerCase().replace(/\n/g, ' ').replace(/\t\t/g, ' ');
  if (lower.includes('isin') && (lower.includes('security') || lower.includes('scheme name'))) {
    return true;
  }
  return lower.includes('current') && lower.includes('bal') && lower.includes('market');
}

export function isTotalRow(block) {
  const first = block.cells.length ? block.cells[0].text.trim().toLowerCase() : '';
  return first === 'sub total' || first === 'total' || first === 'grand total';
}

// ------------------------------------------------------------- equity holdings row

/**
 * A holdings row, yielding ISIN, name, quantity, price and value.
 *
 * The columns run ISIN, security, current balance, frozen, pledged, pledge setup, free,
 * market price, value. A few rows carry a leading marker cell between the ISIN and the
 * name for a suspended issue. Rows whose quantity columns are all dashes — an unexercised
 * rights entitlement — still parse, because a dash reads as zero.
 *
 * Position-based rather than last-three-numbers, because a row can have only two numeric
 * cells when every balance column is a dash.
 */
export function parseHoldingsRow(block) {
  if (!block.cells.length) return null;
  const isin = block.cells[0].text.trim();
  if (!ISIN_RE.test(isin)) return null;

  // The data boundary is the first cell after the ISIN holding a number or a dash.
  // Everything between is the security name, which the renderer sometimes splits across
  // several cells at different x positions.
  let dataStart = null;
  for (let i = 1; i < block.cells.length; i += 1) {
    const text = block.cells[i].text.trim();
    if (looksNumeric(text) || text === '--' || text === '-') {
      dataStart = i;
      break;
    }
  }
  if (dataStart === null || block.cells.length - dataStart < 3) return null;

  const name = block.cells.slice(1, dataStart)
    .map((cell) => cell.text.replace(/\n/g, ' ').trim())
    .filter((text) => text && text !== '@')
    .join(' ') || null;

  return [
    isin,
    name,
    toDecimal(block.cells[dataStart].text),
    toDecimal(block.cells[block.cells.length - 2].text),
    toDecimal(block.cells[block.cells.length - 1].text),
  ];
}

// ------------------------------------------------------------ fund holdings row

/**
 * A row of the fund-units table. Three templates are known:
 *
 *   full, with a distribution-mode column:
 *     name | ISIN | folio | ARN-or-DIRECT | units | NAV | invested | value | expense
 *     ratio | direct | commission | profit | return
 *
 *   without the distribution-mode column:
 *     name | ISIN | folio | units | NAV | invested | value
 *
 *   reduced, with the distribution-mode column but no invested column:
 *     name | ISIN | folio | ARN-or-DIRECT | units | NAV | value
 *
 * The discriminator is the cell two after the ISIN: in the first and third it carries a
 * label, otherwise it is the units value. A holdings statement always prints the current
 * value, so when only three numbers survive the third is the value, not the cost.
 */
export function parseMfHoldingsRow(block, schemeMeta = new Map()) {
  if (block.cells.length < 5) return null;

  let isinIndex = null;
  for (let i = 0; i < Math.min(3, block.cells.length); i += 1) {
    if (ISIN_RE.test(block.cells[i].text.trim())) {
      isinIndex = i;
      break;
    }
  }
  if (isinIndex === null) return null;
  const isin = block.cells[isinIndex].text.trim();

  const name = block.cells.slice(0, isinIndex)
    .map((cell) => cell.text.replace(/\n/g, ' ').trim())
    .filter(Boolean)
    .join(' ') || null;

  let folio = null;
  let folioEnd = isinIndex + 1;
  if (isinIndex + 1 < block.cells.length) {
    folio = block.cells[isinIndex + 1].text.trim() || null;
  }
  if (folio && isinIndex + 2 < block.cells.length) {
    const tail = block.cells[isinIndex + 2].text.trim();
    if (FOLIO_TAIL_RE.test(tail)) {
      folio += tail;
      folioEnd = isinIndex + 2;
    }
  }

  const discriminator = folioEnd + 1;
  const hasDistributionColumn = discriminator < block.cells.length
    && !looksNumeric(block.cells[discriminator].text);
  const dataStart = discriminator + (hasDistributionColumn ? 1 : 0);

  const numerics = block.cells.slice(dataStart)
    .filter((cell) => looksNumeric(cell.text))
    .map((cell) => cell.text.trim());
  if (numerics.length < 3) return null;

  const balance = toDecimal(numerics[0]);
  const nav = toDecimal(numerics[1]);
  let invested = null;
  let value;
  if (numerics.length >= 4) {
    invested = optDecimal(numerics[2]);
    value = toDecimal(numerics[3]);
  } else {
    value = toDecimal(numerics[2]);
  }
  const [pnl, returns] = resolveMfPnlReturns(numerics, value, invested, hasDistributionColumn);

  // The client code comes from the descriptive blocks, keyed on the scheme code that
  // prefixes the name.
  let ucc = null;
  if (name) {
    const codeMatch = /^\s*([A-Z0-9]+)\s*-\s*/.exec(name);
    if (codeMatch) {
      const meta = schemeMeta instanceof Map
        ? schemeMeta.get(codeMatch[1])
        : schemeMeta[codeMatch[1]];
      if (meta) ucc = meta.ucc ?? null;
    }
  }

  return new MutualFund({
    name,
    isin,
    balance,
    nav,
    value,
    total_cost: invested,
    ucc,
    folio,
    pnl,
    return: returns,
  });
}
