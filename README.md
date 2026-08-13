# casparser-js

Reads Indian consolidated account statements in JavaScript. A statement from CAMS,
KFintech, NSDL or CDSL goes in; folios, schemes, transactions, demat holdings and pension
holdings come out.

This is a port of [casparser](https://github.com/codereverser/casparser), which is Python.
Everything it does, this does, with two things deliberately left to the caller: which PDF
reader to use, and whether to supply the reference database that fills in the codes a
statement does not print.

Nothing leaves the process. The PDF is parsed where it is opened, which is the point: a
consolidated account statement is a complete picture of somebody's investments, and it
should not have to travel to be read.

## Install

```
npm install @chikatina/casparser-js
```

The parsing runs on [pdf.js](https://mozilla.github.io/pdf.js/), which is a peer
dependency so an application that already bundles a copy does not end up with two:

```
npm install pdfjs-dist
```

## Use

```js
import * as pdfjsLib from 'pdfjs-dist';
import { createPdfjsBackend, readCasPdf, setPdfBackend } from '@chikatina/casparser-js';

setPdfBackend(createPdfjsBackend(pdfjsLib));

const data = await readCasPdf(bytes, 'ABCDE1234F');
for (const folio of data.folios) {
  for (const scheme of folio.schemes) {
    console.log(scheme.scheme, scheme.close.toString(), scheme.valuation.value.toString());
  }
}
```

`readCasPdf(source, password, options)` takes the PDF as a `Uint8Array`, an `ArrayBuffer`,
a path or a URL. The options:

| Option | Default | What it does |
| --- | --- | --- |
| `output` | `"dict"` | `"dict"` returns the parsed shapes, `"json"` their JSON, `"csv"` a comma-separated view |
| `sortTransactions` | `true` | Sort each scheme's transactions by date and recompute the running balance |
| `backend` | the registered one | A PDF backend for this call only |
| `forcePdfminer` | `false` | Accepted and ignored, for callers carrying it over from an older release |

## Amounts

Every amount is a `Decimal`, not a number. Binary floating point cannot hold `0.1`, and a
statement is nothing but amounts, so the arithmetic here is decimal from end to end and
follows the same rules as Python's `decimal` module: adding keeps the wider scale,
multiplying adds the scales, and dividing is exact when it terminates and twenty-eight
significant digits when it does not.

```js
scheme.valuation.value.toString();   // '1234567.89'
scheme.close.mul(scheme.valuation.nav).round(2).eq(scheme.valuation.value);
```

`Decimal` has `add`, `sub`, `mul`, `div`, `mod`, `neg`, `abs`, `cmp`, `eq`, `lt`, `lte`,
`gt`, `gte`, `round`, `quantize`, `normalize`, `toBigInt`, `toNumber` and `toString`.

## The reference database

A registrar prints a scheme's name and its own internal code, but not the ISIN, the AMFI
code, or whether the scheme is equity or debt. A depository prints the ISIN and nothing
else. The gap is closed by a reference database, and because that database is fifty
megabytes it is a choice rather than a dependency:

```js
import { DatabaseSync } from 'node:sqlite';
import { SqlIsinDb, setIsinProvider } from 'casparser-js';
import { SqlIsinDb as _ } from 'casparser-js/isin-db';

const db = new DatabaseSync('isin.db');
setIsinProvider(new SqlIsinDb({ query: (sql, params) => db.prepare(sql).all(params) }));
```

Register nothing and `isin`, `amfi`, `type`, `symbol` and `exchange` come back `null` and
everything else parses. The schema is the one
[casparser-isin](https://github.com/codereverser/casparser-isin) publishes: a `scheme`
table, an `isin` table, and a `nav20180131` table holding each scheme's value on
31 January 2018, which the grandfathering rule for long-term equity gains needs.

For a provider backed by something other than SQL, implement `isinLookup`,
`directIsinLookup`, `navLookup` and `batchIsinLookup` yourself, or use `MemoryIsinDb` for
a small curated table.

## Capital gains

```js
import { CapitalGainsReport } from 'casparser-js';

const report = new CapitalGainsReport(data);
report.getFyList();                       // ['FY2025-26', 'FY2024-25']
report.getSummary();                      // per year and fund
report.generate112a('FY2025-26');         // Schedule 112A rows
report.generate112aCsvData('FY2025-26');  // ready for the filing utility
report.quarterlyGains('FY2025-26');       // split into the advance-tax windows
```

Units are matched first in, first out. Purchase-side stamp duty joins the cost of
acquisition; the securities transaction tax does not, because it is not deductible.
Grandfathering applies to lots acquired on or before 31 January 2018, and the Schedule
112A output follows the form for the year asked for, including the transfer column that
exists only on the 2024-25 one and the consolidated row the form accepts from 2025-26.

Gifts are recorded and kept out of the computation: for the donor a gift is not a
transfer, and for the recipient the cost basis and holding period carry over from the
donor and are not in the statement.

## Command line

```
npx casparser-js statement.pdf -p ABCDE1234F
npx casparser-js statement.pdf -p ABCDE1234F -o out.json
npx casparser-js statement.pdf -p ABCDE1234F -o out.csv -g --gains-112a FY2025-26
```

`-s` prints the portfolio summary, `-a` includes schemes worth nothing, `-g` runs the
gains report, and `-o` writes JSON, comma-separated values or plain text depending on the
extension.

## What comes out

Two shapes, depending on who issued the statement. A registrar statement gives `CASData`:

```
CASData
  statement_period  { from, to }
  investor_info     { name, email, address, mobile }
  cas_type          SUMMARY | DETAILED
  file_type         CAMS | KFINTECH | NSDL | CDSL | UNKNOWN
  parse_warnings    [ text ]
  folios            [ Folio ]

Folio
  folio, amc, PAN, KYC, PANKYC
  schemes           [ Scheme ]

Scheme
  scheme, advisor, rta_code, rta, type, isin, amfi, nominees
  open, close, close_calculated
  valuation         SchemeValuation { date, nav, cost, value }
  transactions      [ TransactionData ]

TransactionData
  date, description, amount, units, nav, balance, type, dividend_rate, gift_folio
```

A depository statement gives `NSDLCASData`:

```
NSDLCASData
  statement_period, investor_info, file_type, parse_warnings
  accounts          [ DematAccount ]
  nps               NPSAccount | null

DematAccount
  name, type, dp_id, client_id, folios, balance
  owners            [ DematOwner { name, PAN } ]
  equities          [ Equity ]
  mutual_funds      [ MutualFund ]
  bonds             [ Bond ]

Equity
  name, isin, num_shares, price, value, symbol, exchange

MutualFund
  name, isin, amfi, type, balance, nav, value
  avg_cost, total_cost, ucc, folio, pnl, return

Bond
  name, isin, num_bonds, value, face_value
  coupon_rate, coupon_frequency, maturity_date, market_price

NPSAccount
  pran, nps_sp, value
  schemes           [ NPSScheme { scheme, fund_manager, tier, asset_class, units, nav, value } ]
```

The machine-readable version of both is in [`schema/`](schema), generated from the same
field tables the code uses. Regenerate with `npm run schema`.

### Transaction types

| Type | What it is |
| --- | --- |
| `PURCHASE` | A purchase |
| `PURCHASE_SIP` | A purchase under a systematic investment plan |
| `REDEMPTION` | A redemption |
| `DIVIDEND_PAYOUT` | An income distribution paid out |
| `DIVIDEND_REINVEST` | An income distribution reinvested |
| `SWITCH_IN` | Units switched in from another scheme |
| `SWITCH_IN_MERGER` | Units switched in because two schemes merged |
| `SWITCH_OUT` | Units switched out to another scheme |
| `SWITCH_OUT_MERGER` | Units switched out because two schemes merged |
| `STT_TAX` | Securities transaction tax |
| `STAMP_DUTY_TAX` | Stamp duty |
| `TDS_TAX` | Tax deducted at source |
| `SEGREGATION` | Units created in a segregated portfolio |
| `GIFT_IN` | Units received as a gift |
| `GIFT_OUT` | Units given as a gift |
| `REVERSAL` | A purchase reversed, usually a failed payment |
| `MISC` | Something with no units and no tax meaning |
| `UNKNOWN` | Could not be classified |

## Differences from the Python original

Two, both deliberate.

The PDF reader is pdf.js rather than PDFium. pdf.js reports one item per text-show
operation, which is exactly the unit the depository readers work in, but it does not
report per-glyph positions, which the registrar readers use to decide which column a
character belongs to. So each run's width is spread across its characters. In a table the
numbers are right-aligned digits of near-equal width and a run rarely straddles a column
boundary, so this holds; a backend that can report glyph positions may do so and the step
is skipped.

The indexation branch for debt schemes now fires. The original compared a scheme's type
string against an enumeration member, which is never equal, so indexed cost of acquisition
could not be reached.

## Licence

MIT, as the original is.
