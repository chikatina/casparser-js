/** Serialisation helpers: JSON, and the two CSV shapes the original produced. */

/** Two numbers within a tolerance of each other. */
export function isClose(a, b, tolerance = 1.0e-4) {
  return Math.abs(Number(a) - Number(b)) < tolerance;
}

/** One CSV row, quoting only where the content forces it, as Python's writer does. */
function csvRow(values) {
  return `${values.map((value) => {
    if (value === null || value === undefined) return '';
    const text = String(value);
    if (/[",\r\n]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
    return text;
  }).join(',')}\r\n`;
}

export function writeCsv(header, rows) {
  return csvRow(header) + rows.map(csvRow).join('');
}

export function cas2json(data) {
  return JSON.stringify(data.dump());
}

/** One row per scheme: what a holding looks like, without its transactions. */
export function cas2csvSummary(data) {
  const header = [
    'amc', 'folio', 'advisor', 'registrar', 'pan', 'scheme', 'isin', 'amfi',
    'open', 'close', 'value', 'date', 'transactions',
  ];
  const rows = [];
  for (const folio of data.folios) {
    for (const scheme of folio.schemes) {
      rows.push([
        String(folio.amc).replace(/\n/g, ' '),
        folio.folio,
        scheme.advisor,
        scheme.rta,
        folio.PAN,
        String(scheme.scheme).replace(/\n/g, ' '),
        scheme.isin,
        scheme.amfi,
        scheme.open,
        scheme.close,
        scheme.valuation.value,
        scheme.valuation.date,
        scheme.transactions.length,
      ]);
    }
  }
  return writeCsv(header, rows);
}

/** One row per transaction. */
export function cas2csv(data) {
  const header = [
    'amc', 'folio', 'pan', 'scheme', 'advisor', 'isin', 'amfi', 'date', 'description',
    'amount', 'units', 'nav', 'balance', 'type', 'dividend',
  ];
  const rows = [];
  for (const folio of data.folios) {
    for (const scheme of folio.schemes) {
      for (const transaction of scheme.transactions) {
        rows.push([
          String(folio.amc).replace(/\n/g, ' '),
          folio.folio,
          folio.PAN,
          String(scheme.scheme).replace(/\n/g, ' '),
          scheme.advisor,
          scheme.isin,
          scheme.amfi,
          transaction.date,
          String(transaction.description).replace(/\n/g, ' '),
          transaction.amount,
          transaction.units,
          transaction.nav,
          transaction.balance,
          transaction.type,
          transaction.dividend_rate,
        ]);
      }
    }
  }
  return writeCsv(header, rows);
}
