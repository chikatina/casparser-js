/**
 * The dispatcher behind `readCasPdf`.
 *
 * Opens the PDF once, sniffs the issuer and, for a registrar statement, whether it lists
 * transactions, hands it to the right reader, optionally sorts the transactions, and
 * returns the parsed shape or a serialisation of it.
 *
 * The four readers live alongside this file:
 *
 *   cams_detailed.js   CAMS and KFin, detailed
 *   cams_summary.js    CAMS and KFin, summary
 *   nsdl.js            NSDL
 *   cdsl.js            CDSL
 */

import { CASFileType, FileType } from '../enums.js';
import { CASParseError } from '../exceptions.js';
import { CASData, NSDLCASData } from '../types.js';
import { Decimal, ZERO } from '../decimal.js';
import { asDate } from '../dates.js';
import { batchEquitySymbols, batchIsinMetadata } from '../isin.js';
import { resolveBackend } from '../pdf/backend.js';
import { detectCasType, detectFileType } from './detect.js';
import { cas2csv, cas2json } from './utils.js';

/**
 * Sorts each scheme's transactions by date and recomputes the running balance from the
 * opening one. Schemes that are already in order are left alone, balances included.
 */
function sortTransactions(data) {
  for (const folio of data.folios) {
    folio.schemes.forEach((scheme, index) => {
      const dates = scheme.transactions.map((t) => asDate(t.date).ordinal);
      const sorted = [...dates].sort((a, b) => a - b);
      if (dates.every((value, i) => value === sorted[i])) return;

      let balance = Decimal.from(scheme.open);
      const ordered = [...scheme.transactions]
        .sort((a, b) => asDate(a.date).ordinal - asDate(b.date).ordinal);
      for (const txn of ordered) {
        balance = balance.add(txn.units === null ? ZERO : txn.units);
        txn.balance = balance;
      }
      scheme.transactions = ordered;
      folio.schemes[index] = scheme;
    });
  }
  return data;
}

/**
 * Fills in the AMFI code and scheme type on demat fund holdings.
 *
 * A depository statement lists a fund by ISIN alone, so unlike a registrar statement it
 * arrives with neither. Resolving both in one batch lets a demat holding be reconciled
 * with the same scheme from a registrar statement. Values the reader already set are left
 * alone, and an ISIN the database cannot resolve stays null.
 */
function enrichDematMutualFunds(data) {
  const metadata = batchIsinMetadata(
    data.accounts.flatMap((account) => account.mutual_funds.map((fund) => fund.isin)),
  );
  for (const account of data.accounts) {
    for (const fund of account.mutual_funds) {
      const [amfi, type] = metadata.get(fund.isin) || [null, null];
      if (fund.amfi === null) fund.amfi = amfi;
      if (fund.type === null) fund.type = type;
    }
  }
  return data;
}

/**
 * Fills in the trading symbol and exchange on demat equity holdings, so a consumer can
 * price them from a symbol-keyed feed.
 */
function enrichDematEquities(data) {
  const symbols = batchEquitySymbols(
    data.accounts.flatMap((account) => account.equities.map((equity) => equity.isin)),
  );
  for (const account of data.accounts) {
    for (const equity of account.equities) {
      const [symbol, exchange] = symbols.get(equity.isin) || [null, null];
      if (equity.symbol === null) equity.symbol = symbol;
      if (equity.exchange === null) equity.exchange = exchange;
    }
  }
  return data;
}

export { enrichDematMutualFunds, enrichDematEquities, sortTransactions };

function emitDeprecation(message) {
  if (typeof process !== 'undefined' && typeof process.emitWarning === 'function') {
    process.emitWarning(message, 'DeprecationWarning');
  } else if (typeof console !== 'undefined') {
    console.warn(`DeprecationWarning: ${message}`);
  }
}

/**
 * Parses a consolidated account statement.
 *
 * @param {Uint8Array|ArrayBuffer|string|object} source the PDF, as bytes, a path or a URL
 * @param {string} password most of these statements are encrypted, usually with the
 *   investor's permanent account number
 * @param {object} [options]
 * @param {string} [options.output] `"dict"` returns the parsed models, `"json"` their
 *   JSON, `"csv"` a comma-separated view
 * @param {boolean} [options.sortTransactions] sort each scheme's transactions by date and
 *   recompute the running balance
 * @param {object} [options.backend] a PDF backend, when one is not registered globally
 * @param {boolean} [options.forcePdfminer] accepted and ignored, for callers carrying the
 *   argument over from an older release
 */
export async function readCasPdf(source, password = '', options = {}) {
  const {
    output = 'dict',
    sortTransactions: shouldSort = true,
    backend: explicitBackend = null,
    forcePdfminer = false,
  } = options;

  if (forcePdfminer) {
    emitDeprecation(
      'force_pdfminer is deprecated: pdfminer is not a supported backend in casparser-js.',
    );
  }

  const backend = resolveBackend(explicitBackend);
  const document = await backend.open(source, password);
  let data;

  try {
    const fileType = await detectFileType(document);
    if (fileType === FileType.UNKNOWN) {
      throw new CASParseError(
        'Could not identify the CAS issuer. Supported issuers are CAMS, KFintech, NSDL, '
        + 'and CDSL.',
      );
    }

    if (fileType === FileType.CAMS || fileType === FileType.KFINTECH) {
      const casType = await detectCasType(document);
      if (casType === CASFileType.DETAILED) {
        const { parse } = await import('./cams_detailed.js');
        data = await parse(document, fileType);
      } else if (casType === CASFileType.SUMMARY) {
        const { parse } = await import('./cams_summary.js');
        data = await parse(document, fileType);
      } else {
        throw new CASParseError(
          'Could not identify whether this is a DETAILED or SUMMARY CAMS / KFin statement.',
        );
      }
      if (shouldSort && data instanceof CASData) data = sortTransactions(data);
    } else if (fileType === FileType.NSDL) {
      const { parseNsdl } = await import('./nsdl.js');
      data = await parseNsdl(document, FileType.NSDL);
    } else if (fileType === FileType.CDSL) {
      const { parseCdsl } = await import('./cdsl.js');
      data = await parseCdsl(document, FileType.CDSL);
    } else {
      throw new CASParseError(`Unsupported file type: ${fileType}`);
    }
  } finally {
    await document.close();
  }

  if (data instanceof NSDLCASData) {
    data = enrichDematMutualFunds(data);
    data = enrichDematEquities(data);
  }

  if (output === 'dict') return data;
  if (output === 'csv') return cas2csv(data);
  return cas2json(data);
}

export default readCasPdf;
