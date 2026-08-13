#!/usr/bin/env node
/**
 * The command line front end.
 *
 * Prints a statement's portfolio summary, writes it out as JSON or CSV, and optionally
 * runs the capital-gains reports. Plain text rather than a styled terminal UI: the output
 * is as often piped or pasted into a bug report as read directly, and a table that
 * survives both is worth more than one that only looks good in a terminal.
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import { VERSION, readCasPdf } from '../src/index.js';
import { CASFileType, FileType } from '../src/enums.js';
import { Decimal, ROUND_HALF_UP, ZERO } from '../src/decimal.js';
import { CASData, NSDLCASData } from '../src/types.js';
import { ParserException, GainsError, IncompleteCASError } from '../src/exceptions.js';
import { cas2csv, cas2csvSummary, cas2json, isClose } from '../src/parsers/utils.js';
import { CapitalGainsReport, QUARTER_LABELS, QUARTERLY_CATEGORIES } from '../src/analysis/index.js';
import { createPdfjsBackend } from '../src/pdf/pdfjs.js';
import { setPdfBackend } from '../src/pdf/backend.js';

// ------------------------------------------------------------------- formatting

/** Thousands grouping, keeping any fractional part as it is. */
export function formatNumber(value) {
  const text = String(value);
  const negative = text.startsWith('-');
  const body = negative ? text.slice(1) : text;
  const [whole, fraction] = body.split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${negative ? '-' : ''}${grouped}${fraction === undefined ? '' : `.${fraction}`}`;
}

/** Rupees, with the lakh-and-crore grouping the rest of the statement uses. */
export function formatINR(value) {
  const amount = Decimal.from(value).quantize('0.01', ROUND_HALF_UP);
  const negative = amount.lt(0);
  const text = amount.abs().quantize('0.01').toString();
  const [whole, fraction = '00'] = text.split('.');

  let grouped;
  if (whole.length <= 3) {
    grouped = whole;
  } else {
    const last3 = whole.slice(-3);
    const rest = whole.slice(0, -3);
    const groups = [];
    for (let i = rest.length; i > 0; i -= 2) groups.unshift(rest.slice(Math.max(0, i - 2), i));
    grouped = `${groups.join(',')},${last3}`;
  }
  return `${negative ? '-' : ''}₹${grouped}.${fraction}`;
}

/** Renders rows as a plain aligned table. Cells may contain newlines. */
function renderTable(title, header, rows, alignRight = new Set()) {
  const lines = [];
  const all = [header, ...rows];
  const expanded = all.map((row) => row.map((cell) => String(cell ?? '').split('\n')));
  const height = expanded.map((row) => Math.max(...row.map((cell) => cell.length)));
  const widths = header.map((_, column) => Math.max(
    ...expanded.map((row) => Math.max(...(row[column] || ['']).map((line) => line.length))),
  ));

  const pad = (text, column) => (alignRight.has(column)
    ? String(text).padStart(widths[column])
    : String(text).padEnd(widths[column]));

  const separator = `+${widths.map((width) => '-'.repeat(width + 2)).join('+')}+`;
  if (title) lines.push(title);
  lines.push(separator);

  expanded.forEach((row, index) => {
    for (let line = 0; line < height[index]; line += 1) {
      lines.push(`| ${row.map((cell, column) => pad(cell[line] ?? '', column)).join(' | ')} |`);
    }
    if (index === 0) lines.push(separator);
  });
  lines.push(separator);
  return lines.join('\n');
}

// ---------------------------------------------------------------------- printing

function printHeader(data) {
  const period = data.statement_period;
  const lines = [
    `Statement Period : ${period.from_} To ${period.to}`,
    `File Type : ${data.file_type}`,
  ];
  if (data.cas_type) lines.push(`CAS Type : ${data.cas_type}`);
  const investor = data.investor_info;
  if (investor) {
    for (const key of ['name', 'email', 'address', 'mobile']) {
      const value = investor[key];
      if (value) {
        const label = key.charAt(0).toUpperCase() + key.slice(1);
        lines.push(`${label} : ${String(value).replace(/[^\S\r\n]+/g, ' ')}`);
      }
    }
  }
  console.log(lines.join('\n'));
  console.log('');
}

function printNsdl(data) {
  printHeader(data);

  const rows = [];
  let accounts = 0;
  let errors = 0;

  for (const account of data.accounts) {
    let running = ZERO;
    const accountRows = [];

    if (account.equities.length) accountRows.push(['Equities', '', '', '', '']);
    for (const equity of account.equities) {
      running = running.add(equity.value);
      accountRows.push([
        equity.name, equity.isin, formatNumber(equity.num_shares),
        formatINR(equity.price), formatINR(equity.value),
      ]);
    }
    if (account.mutual_funds.length) accountRows.push(['Mutual Funds', '', '', '', '']);
    for (const fund of account.mutual_funds) {
      running = running.add(fund.value);
      accountRows.push([
        fund.name, fund.isin, formatNumber(fund.balance),
        formatINR(fund.nav), formatINR(fund.value),
      ]);
    }
    if (account.bonds.length) accountRows.push(['Bonds', '', '', '', '']);
    for (const bond of account.bonds) {
      running = running.add(bond.value);
      accountRows.push([
        bond.name, bond.isin, formatNumber(bond.num_bonds),
        formatINR(bond.market_price || bond.face_value || 0), formatINR(bond.value),
      ]);
    }

    const balance = Decimal.from(account.balance);
    const tolerance = Math.abs(Number(balance.toString()) || 1) * 0.01;
    const matched = isClose(Number(balance.toString()), Number(running.toString()), tolerance);
    if (!matched) errors += 1;
    accounts += 1;

    rows.push([
      `${account.name}\n${account.dp_id} - ${account.client_id}`, '', '', '',
      matched ? 'ok' : 'mismatch',
    ]);
    rows.push(...accountRows);
  }

  console.log(renderTable(
    'Portfolio Summary',
    ['Name', 'ISIN', 'Units', 'Price', 'Value'],
    rows,
    new Set([2, 3, 4]),
  ));

  if (data.nps && data.nps.schemes.length) {
    console.log('');
    console.log(renderTable(
      'NPS Holdings',
      ['Scheme', 'Class', 'Tier', 'Units', 'NAV', 'Value'],
      data.nps.schemes.map((scheme) => [
        scheme.scheme, scheme.asset_class || '', scheme.tier || '',
        formatNumber(scheme.units), formatNumber(scheme.nav), formatINR(scheme.value),
      ]),
      new Set([3, 4, 5]),
    ));
    const meta = [];
    if (data.nps.nps_sp) meta.push(`NPS-SP: ${data.nps.nps_sp}`);
    if (data.nps.pran) meta.push(`PRAN: ${data.nps.pran}`);
    meta.push(`Value: ${formatINR(data.nps.value)}`);
    console.log(meta.join('   '));
  }

  // The asset-class breakdown.
  let equities = ZERO;
  let fundsInDemat = ZERO;
  let fundFolios = ZERO;
  let bonds = ZERO;

  for (const account of data.accounts) {
    if (account.type === 'Mutual Fund Folios') {
      fundFolios = account.mutual_funds.reduce((total, f) => total.add(f.value), fundFolios);
    } else {
      equities = account.equities.reduce((total, e) => total.add(e.value), equities);
      fundsInDemat = account.mutual_funds.reduce((total, f) => total.add(f.value), fundsInDemat);
      bonds = account.bonds.reduce((total, b) => total.add(b.value), bonds);
    }
  }
  const nps = data.nps ? Decimal.from(data.nps.value) : ZERO;
  const total = bonds.add(equities).add(fundsInDemat).add(fundFolios).add(nps);

  console.log('');
  const breakdown = [
    ['Debts / Bonds', bonds],
    ['Equities (demat)', equities],
    ['Mutual Funds (demat)', fundsInDemat],
    ['Mutual Fund Folios', fundFolios],
    ['National Pension System', nps],
  ].filter(([, amount]) => amount.gt(0));
  for (const [label, amount] of breakdown) {
    console.log(`  ${label.padEnd(26)}${formatINR(amount)}`);
  }
  console.log(`  ${`Total Portfolio Value [As of ${data.statement_period.to}]`.padEnd(26)}${formatINR(total)}`);
  console.log('');
  console.log('Summary');
  console.log(`Total   : ${String(accounts).padStart(4)} accounts`);
  console.log(`Matched : ${String(accounts - errors).padStart(4)} accounts`);
  console.log(`Error   : ${String(errors).padStart(4)} accounts`);
}

function printSummary(data, { includeZeroFolios = false, outputFilename = null } = {}) {
  printHeader(data);
  const isSummary = data.cas_type === CASFileType.SUMMARY;

  const header = isSummary
    ? ['Scheme', 'Balance', `Value (${data.statement_period.to})`, '']
    : ['Scheme', 'Open', 'Close\nreported / calculated', `Value (${data.statement_period.to})`, 'Txns', ''];

  const rows = [];
  let count = 0;
  let errors = 0;
  let value = ZERO;
  let cost = ZERO;
  let currentAmc = null;
  let amcHeaderAdded = false;

  for (const folio of data.folios) {
    if (currentAmc !== folio.amc) {
      amcHeaderAdded = false;
      currentAmc = folio.amc;
    }
    for (const scheme of folio.schemes) {
      const close = Decimal.from(scheme.close);
      if (close.lt(Decimal.parse('0.001')) && !includeZeroFolios) continue;

      const calculated = Decimal.from(scheme.close_calculated);
      const valuation = scheme.valuation;
      const derived = Number(Decimal.from(valuation.nav).mul(calculated).toString());
      const ok = calculated.eq(close)
        && isClose(derived, Number(Decimal.from(valuation.value).toString()), 2);
      if (!ok) errors += 1;

      value = value.add(valuation.value);
      if (valuation.cost !== null) cost = cost.add(valuation.cost);

      if (!isSummary && !amcHeaderAdded) {
        rows.push([currentAmc, ...header.slice(1).map(() => '')]);
        amcHeaderAdded = true;
      }

      const name = `${scheme.scheme}\nFolio: ${String(folio.folio).replace(/\s+/g, '')}`;
      const valueCell = `${formatINR(valuation.value)}\n@ ${formatINR(valuation.nav)}`;
      rows.push(isSummary
        ? [name, formatNumber(close), valueCell, ok ? 'ok' : 'check']
        : [
          name, String(scheme.open),
          `${formatNumber(close)} / ${calculated}`, valueCell,
          String(scheme.transactions.length), ok ? 'ok' : 'check',
        ]);
      count += 1;
    }
  }

  const table = renderTable('Portfolio Summary', header, rows,
    new Set(header.map((_, i) => i).filter((i) => i > 0 && i < header.length - 1)));
  console.log(table);

  if (cost.gt(0)) {
    console.log(`Portfolio Cost Value : ${formatINR(cost)}`);
    console.log(`Portfolio Gains      : ${formatINR(value.sub(cost))}`);
  }
  console.log(`Portfolio Valuation  : ${formatINR(value)} [As of ${data.statement_period.to}]`);
  console.log('Summary');
  console.log(`Total   : ${String(count).padStart(4)} schemes`);
  console.log(`Matched : ${String(count - errors).padStart(4)} schemes`);
  console.log(`Error   : ${String(errors).padStart(4)} schemes`);

  if (outputFilename) {
    fs.writeFileSync(outputFilename, `${table}\n`, 'utf-8');
    console.log(`File saved : ${outputFilename}`);
  }
}

function printGifts(report) {
  console.log(renderTable(
    'Gift transactions (informational, not in gains)',
    ['FY', 'Fund', 'Dir', 'Date', 'Units', 'Value', 'Counterparty Folio'],
    report.gifts.map((gift) => [
      gift.fy, gift.fund.name, gift.direction, String(gift.date), String(gift.units),
      gift.value === null ? '-' : formatINR(Decimal.from(gift.value).abs()),
      gift.counterparty_folio || '-',
    ]),
    new Set([4, 5]),
  ));
  console.log(
    'Note: gifts are excluded from the capital-gains figures. A gift is not a transfer '
    + 'for the donor. For the recipient, cost basis and holding period carry over from '
    + 'the donor and are not available in this statement; the gift itself may be taxable '
    + 'as income from other sources if it came from a non-relative. This is a disclosure, '
    + 'not tax advice.',
  );
}

function printQuarterly(report) {
  const whole = (amount) => formatINR(Decimal.from(amount).quantize('1', ROUND_HALF_UP))
    .replace(/\.00$/, '');

  for (const fy of report.getFyList()) {
    const buckets = report.quarterlyGains(fy);
    const active = QUARTERLY_CATEGORIES.filter((category) => buckets[category].some((q) => !q.isZero()));
    if (!active.length) continue;

    const rows = [];
    let columnTotals = QUARTER_LABELS.map(() => ZERO);
    for (const category of active) {
      const quarters = buckets[category];
      const rowTotal = quarters.reduce((total, q) => total.add(q), ZERO);
      rows.push([category, ...quarters.map(whole), whole(rowTotal)]);
      columnTotals = columnTotals.map((total, i) => total.add(quarters[i]));
    }
    const grandTotal = columnTotals.reduce((total, q) => total.add(q), ZERO);
    rows.push(['Total', ...columnTotals.map(whole), whole(grandTotal)]);

    console.log(renderTable(
      `Quarterly Capital Gains ${fy} (taxable, by date of transfer)`,
      ['Category', ...QUARTER_LABELS, 'Total'],
      rows,
      new Set([1, 2, 3, 4, 5, 6]),
    ));
  }
  console.log(
    'Equity LTCG totals reconcile with the Schedule 112A report. Gains are placed by '
    + 'date of transfer; the five windows are the advance-tax installment periods.',
  );
}

function saveGains112a(report, fy, outputPath) {
  const wanted = String(fy).toUpperCase();
  const available = report.getFyList();
  if (!available.includes(wanted)) {
    console.log(`Warning: no capital gains found for ${wanted}.`);
    return;
  }
  const base = outputPath.slice(0, outputPath.length - path.extname(outputPath).length);
  const filename = `${base}-${wanted}-gains-112a.csv`;
  fs.writeFileSync(filename, report.generate112aCsvData(wanted), 'utf-8');
  console.log(`gains report (112a) saved : ${filename}`);
}

function printGains(data, { outputFilePath = null, gains112a = '' } = {}) {
  const report = new CapitalGainsReport(data);
  const base = outputFilePath
    ? outputFilePath.slice(0, outputFilePath.length - path.extname(outputFilePath).length)
    : null;

  if (!report.hasGains()) {
    console.log('Warning: no capital gains info found in CAS');
    if (report.hasGifts()) {
      printGifts(report);
      if (base) fs.writeFileSync(`${base}-gifts.csv`, report.getGiftsCsvData(), 'utf-8');
    }
    return;
  }

  const rows = [];
  let currentFy = null;
  let ltcgTotal = ZERO;
  let stcgTotal = ZERO;
  let taxableTotal = ZERO;

  const flush = () => {
    if (currentFy === null) return;
    rows.push(['', `${currentFy} - Total Gains`, formatINR(ltcgTotal),
      formatINR(taxableTotal), formatINR(stcgTotal)]);
  };

  for (const [fy, fund, , , ltcg, ltcgTaxable, stcg] of report.getSummary()) {
    if (fy !== currentFy) {
      flush();
      currentFy = fy;
      ltcgTotal = ZERO;
      stcgTotal = ZERO;
      taxableTotal = ZERO;
      rows.push([fy, '', '', '', '']);
    }
    ltcgTotal = ltcgTotal.add(ltcg);
    stcgTotal = stcgTotal.add(stcg);
    taxableTotal = taxableTotal.add(ltcgTaxable);
    rows.push(['', fund, formatINR(ltcg), formatINR(ltcgTaxable), formatINR(stcg)]);
  }
  flush();

  console.log(renderTable(
    'Capital Gains statement (Realised)',
    ['FY', 'Fund', 'LTCG', 'LTCG (Taxable)', 'STCG'],
    rows,
    new Set([2, 3, 4]),
  ));

  printQuarterly(report);

  if (gains112a) {
    if (!outputFilePath) {
      console.log('Warning: --gains-112a needs an output csv path via -o. Cannot continue.');
      return;
    }
    saveGains112a(report, gains112a, outputFilePath);
  }

  if (base) {
    fs.writeFileSync(`${base}-gains-summary.csv`, report.getSummaryCsvData(), 'utf-8');
    console.log(`Gains summary report saved : ${base}-gains-summary.csv`);
    fs.writeFileSync(`${base}-gains-detailed.csv`, report.getGainsCsvData(), 'utf-8');
    console.log(`Detailed gains report saved : ${base}-gains-detailed.csv`);
    if (report.hasGifts()) {
      fs.writeFileSync(`${base}-gifts.csv`, report.getGiftsCsvData(), 'utf-8');
      console.log(`Gift transactions saved : ${base}-gifts.csv`);
    }
  }

  if (report.hasGifts()) printGifts(report);

  if (report.hasError()) {
    console.log('WARNING: could not calculate gains for the following funds.');
    for (const [scheme] of report.errors) console.log(`- ${scheme}`);
  }

  console.log('');
  console.log(`PnL as of ${data.statement_period.to}`);
  console.log(`Total Invested      : ${formatINR(report.invested_amount)}`);
  console.log(`Current Valuation   : ${formatINR(report.current_value)}`);
  console.log(`Absolute PnL        : ${formatINR(report.current_value.sub(report.invested_amount))}`);
  console.log(
    '\nGains follow the registrars\' own methodology. Reconcile against your registrar\'s '
    + 'capital-gains statement before filing.',
  );
}

// ------------------------------------------------------------------------- main

const USAGE = `casparser-js ${VERSION}

  casparser-js [options] CAS_PDF_FILE

  -p PASSWORD          statement password, usually the investor's PAN
  -o, --output PATH    write the result to a file (.json, .csv, or plain text)
  -s, --summary        print the portfolio summary
  -a, --include-all    include schemes with a zero valuation in the summary
  -g, --gains          generate the capital-gains report
  --gains-112a FY      write the Schedule 112A csv for a financial year
  --force-pdfminer     accepted and ignored, kept for older callers
  -h, --help           show this message
  --version            show the version
`;

function parseArgs(argv) {
  const options = {
    password: '', output: null, summary: false, includeAll: false, gains: false,
    gains112a: '', forcePdfminer: false, filename: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case '-p': options.password = argv[++i] ?? ''; break;
      case '-o': case '--output': options.output = argv[++i] ?? null; break;
      case '-s': case '--summary': options.summary = true; break;
      case '-a': case '--include-all': options.includeAll = true; break;
      case '-g': case '--gains': options.gains = true; break;
      case '--gains-112a': options.gains112a = argv[++i] ?? ''; break;
      case '--force-pdfminer': options.forcePdfminer = true; break;
      case '-h': case '--help': options.help = true; break;
      case '--version': options.version = true; break;
      default:
        if (arg.startsWith('-')) throw new Error(`Unknown option: ${arg}`);
        options.filename = arg;
    }
  }
  return options;
}

async function main(argv) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    console.error(error.message);
    return 2;
  }
  if (options.help) {
    console.log(USAGE);
    return 0;
  }
  if (options.version) {
    console.log(VERSION);
    return 0;
  }
  if (!options.filename) {
    console.error(USAGE);
    return 2;
  }

  const pdfjsLib = await import('pdfjs-dist/legacy/build/pdf.mjs').catch(() => null);
  if (!pdfjsLib) {
    console.error('pdf.js is not installed. Run: npm install pdfjs-dist');
    return 1;
  }
  setPdfBackend(createPdfjsBackend(pdfjsLib));

  const extension = options.output ? path.extname(options.output).toLowerCase() : null;
  let summary = options.summary;
  if (!summary && !options.gains && extension !== '.csv' && extension !== '.json') summary = true;

  let data;
  try {
    data = await readCasPdf(new Uint8Array(fs.readFileSync(options.filename)), options.password, {
      forcePdfminer: options.forcePdfminer,
    });
  } catch (error) {
    if (error instanceof ParserException) {
      console.log(`Error parsing pdf file :: ${error.message}`);
      return 1;
    }
    throw error;
  }

  const warnings = data.parse_warnings || [];
  if (warnings.length) {
    console.log(`Warning: ${warnings.length} data-quality issue(s) detected while parsing:`);
    for (const warning of warnings) console.log(`  - ${warning}`);
  }

  if (data instanceof NSDLCASData) {
    printNsdl(data);
  } else if (summary) {
    printSummary(data, {
      includeZeroFolios: options.includeAll,
      outputFilename: (extension === '.csv' || extension === '.json') ? null : options.output,
    });
  }

  if (extension === '.csv' || extension === '.json') {
    let payload;
    if (extension === '.csv'
      && (data.file_type === FileType.CAMS || data.file_type === FileType.KFINTECH)) {
      const wantSummary = summary || data.cas_type === CASFileType.SUMMARY;
      console.log(wantSummary ? 'Generating summary CSV file...' : 'Generating detailed CSV file...');
      payload = wantSummary ? cas2csvSummary(data) : cas2csv(data);
    } else {
      console.log('Generating JSON file...');
      payload = cas2json(data);
    }
    fs.writeFileSync(options.output, payload, 'utf-8');
    console.log(`File saved : ${options.output}`);
  }

  if ((data.file_type === FileType.CAMS || data.file_type === FileType.KFINTECH)
    && (options.gains || options.gains112a)) {
    try {
      printGains(data, {
        outputFilePath: extension === '.csv' ? options.output : null,
        gains112a: options.gains112a,
      });
    } catch (error) {
      if (error instanceof IncompleteCASError) {
        console.log('Error! Cannot compute gains. CAS is incomplete.');
        return 2;
      }
      if (error instanceof GainsError) {
        console.log(error.message);
        return 0;
      }
      throw error;
    }
  }
  return 0;
}

const invokedDirectly = process.argv[1]
  && import.meta.url.endsWith(path.basename(process.argv[1]));

if (invokedDirectly) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((error) => {
      console.error(error);
      process.exit(1);
    });
}

export { main, CASData };
