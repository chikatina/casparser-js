/**
 * Reads the investor block out of a statement.
 *
 * Both extractors narrow the page to a top-left column and then walk it top-down picking
 * out labelled fields. Atoms rather than baseline-clustered lines, because the disclaimer
 * paragraph on the right shares baselines with the investor block and would otherwise
 * contaminate the result.
 *
 * A registrar statement carries the full set — name, email, address, mobile. A depository
 * statement prints only the name and address, so the other two come back empty.
 */

import { CASParseError } from '../exceptions.js';
import { InvestorInfo } from '../types.js';

/**
 * Everything to the right of this is the disclaimer paragraph or the cover banner. It is
 * the conservative right edge that fits every layout seen.
 */
const LEFT_COLUMN_X = 200.0;

const EMAIL_RE = /^Email\s*Id\s*:\s*(\S+@\S+)/i;
const MOBILE_RE = /^Mobile\s*:\s*([+\d]+)/i;
const PHONE_RE = /^\s*Phone\s+Off\s*:/i;
const PINCODE_RE = /^\s*(?:Pin\s*code|PINCODE)\s*:\s*\d+/i;
const ID_MARKER_RE = /^\s*(?:CAS|NSDL)\s*ID\s*:/i;

function leftColumnAtoms(atoms) {
  return atoms
    .filter((atom) => atom.xLeft < LEFT_COLUMN_X && atom.text.trim())
    .sort((a, b) => b.yTop - a.yTop);
}

/**
 * The registrar layout, top-left of page one:
 *
 *     Email Id: <email>
 *     <name>
 *     <address line 1..N>
 *     [Phone Off: ...]
 *     Mobile: <mobile>
 *
 * `Email Id:` is the anchor and `Mobile:` is the terminator, so the transaction table
 * below is never picked up. Every statement carries this block by mandate, so a missing
 * one is a malformed file rather than an absent field.
 */
export function extractCamsKfinInvestor(pages) {
  const block = pages.length ? leftColumnAtoms(pages[0]) : [];

  let email = '';
  let mobile = '';
  let name = '';
  const addressLines = [];
  let seenEmail = false;

  for (const atom of block) {
    const text = atom.text.trim();
    const emailMatch = EMAIL_RE.exec(text);
    if (emailMatch) {
      email = emailMatch[1].trim();
      seenEmail = true;
      continue;
    }
    const mobileMatch = MOBILE_RE.exec(text);
    if (mobileMatch) {
      mobile = mobileMatch[1].trim();
      break;
    }
    if (!seenEmail) continue;
    if (PHONE_RE.test(text)) continue;
    if (!name) {
      name = text;
    } else {
      addressLines.push(text);
    }
  }

  if (!name) {
    throw new CASParseError(
      'Could not extract investor info from CAMS/KFin CAS PDF. Expected an `Email Id:` '
      + 'line followed by name + address + `Mobile:` in the top-left column of page 1.',
    );
  }
  return new InvestorInfo({
    name, email, address: addressLines.join('\n'), mobile,
  });
}

/**
 * The depository layout, top-left of page two, between a `CAS ID:` or `NSDL ID:` marker
 * and a `PINCODE:` line. Email and mobile are not printed on these, so they come back
 * empty.
 */
export function extractNsdlCdslInvestor(pages) {
  const block = pages.length >= 2 ? leftColumnAtoms(pages[1]) : [];

  let name = '';
  const addressLines = [];
  let seenMarker = false;

  for (const atom of block) {
    const text = atom.text.trim();
    if (ID_MARKER_RE.test(text)) {
      seenMarker = true;
      continue;
    }
    if (!seenMarker) continue;
    if (!name) {
      name = text;
      continue;
    }
    addressLines.push(text);
    if (PINCODE_RE.test(text)) break;
  }

  if (!name) {
    throw new CASParseError(
      'Could not extract investor info from NSDL/CDSL CAS PDF. Expected a `CAS ID:` / '
      + '`NSDL ID:` marker followed by name + address in the top-left column of page 2.',
    );
  }
  return new InvestorInfo({
    name, email: '', address: addressLines.join('\n'), mobile: '',
  });
}
