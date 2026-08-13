/** The command line's number formatting, which is the part with no PDF in it. */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { formatINR, formatNumber } from '../bin/casparser.js';
import { Decimal } from '../src/decimal.js';

describe('thousands grouping', () => {
  it('groups in threes', () => {
    assert.equal(formatNumber(100), '100');
    assert.equal(formatNumber(1000), '1,000');
    assert.equal(formatNumber(102312), '102,312');
  });

  it('leaves a fractional part alone', () => {
    assert.equal(formatNumber(Decimal.parse('100.001')), '100.001');
    assert.equal(formatNumber(Decimal.parse('22994.003')), '22,994.003');
  });

  it('keeps the sign', () => {
    assert.equal(formatNumber(-1000), '-1,000');
  });
});

describe('rupee formatting', () => {
  it('groups in lakhs and crores', () => {
    assert.equal(formatINR(100), '₹100.00');
    assert.equal(formatINR(1000), '₹1,000.00');
    assert.equal(formatINR(100000), '₹1,00,000.00');
    assert.equal(formatINR(10000000), '₹1,00,00,000.00');
  });

  it('rounds to paise and keeps the sign', () => {
    assert.equal(formatINR(Decimal.parse('1234.567')), '₹1,234.57');
    assert.equal(formatINR(Decimal.parse('-4500')), '-₹4,500.00');
  });
});
