/** Enumerations. Every member's value is its own name, as in the Python original. */

function autoEnum(...names) {
  const members = Object.create(null);
  for (const name of names) members[name] = name;
  return Object.freeze(members);
}

/** Where a statement came from. */
export const FileType = autoEnum('UNKNOWN', 'CAMS', 'KFINTECH', 'CDSL', 'NSDL');

/** Whether a CAMS / KFin statement lists transactions or only balances. */
export const CASFileType = autoEnum('UNKNOWN', 'SUMMARY', 'DETAILED');

/** Equity or debt, which decides the long-term holding period. */
export const FundType = autoEnum('EQUITY', 'DEBT', 'UNKNOWN');

export const GainType = autoEnum('STCG', 'LTCG');

export const TransactionType = autoEnum(
  'PURCHASE',
  'PURCHASE_SIP',
  'REDEMPTION',
  'DIVIDEND_PAYOUT',
  'DIVIDEND_REINVEST',
  'SWITCH_IN',
  'SWITCH_IN_MERGER',
  'SWITCH_OUT',
  'SWITCH_OUT_MERGER',
  'STT_TAX',
  'STAMP_DUTY_TAX',
  'TDS_TAX',
  'SEGREGATION',
  'GIFT_IN',
  'GIFT_OUT',
  'MISC',
  'UNKNOWN',
  'REVERSAL',
);
