/**
 * The decimal type underneath everything else.
 *
 * These are not in the Python suite: there, `decimal.Decimal` came with the language and
 * needed no tests. Here it is ours, so the scale and rounding rules the parsers depend on
 * have to be pinned down.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { Decimal, ROUND_HALF_UP, sumDecimals } from '../src/decimal.js';

const D = (value) => Decimal.parse(value);

describe('parsing and printing', () => {
  it('keeps the scale it was written with', () => {
    assert.equal(D('2500.00').toString(), '2500.00');
    assert.equal(D('0.0241').toString(), '0.0241');
    assert.equal(D('-1.50').toString(), '-1.50');
    assert.equal(D('1e3').toString(), '1E+3');
  });

  it('compares on value, not on scale', () => {
    assert.ok(D('2500.00').eq(D('2500')));
    assert.ok(D('0.1').lt(D('0.2')));
    assert.ok(D('-5').lt(D('0')));
  });

  it('reads a plain number through its decimal spelling', () => {
    assert.equal(Decimal.from('10000.00').toString(), '10000.00');
    assert.equal(Decimal.parse('  1,000 '.replace(/,/g, '')).toString(), '1000');
  });

  it('converts a float to its exact binary expansion', () => {
    // The same value Python's Decimal(0.1) gives, which is what keeps a ported
    // computation that started from a float on the same arithmetic.
    assert.ok(Decimal.from(0.1).toString().startsWith('0.1000000000000000055511151231'));
    assert.equal(Decimal.from(3).toString(), '3');
  });

  it('rejects nonsense', () => {
    assert.throws(() => D('not a number'));
    assert.throws(() => D(''));
  });
});

describe('arithmetic', () => {
  it('adds without binary drift', () => {
    assert.equal(D('0.1').add(D('0.2')).toString(), '0.3');
  });

  it('takes the wider scale on add and the sum of scales on multiply', () => {
    assert.equal(D('1.5').add(D('1.25')).toString(), '2.75');
    assert.equal(D('1.5').mul(D('1.25')).toString(), '1.875');
    assert.equal(D('100.000').mul(D('25.0000')).toString(), '2500.0000000');
  });

  it('divides exactly where the quotient terminates', () => {
    assert.equal(D('10').div(D('2')).toString(), '5');
    assert.equal(D('1').div(D('8')).toString(), '0.125');
  });

  it('divides to twenty-eight significant digits where it does not', () => {
    assert.equal(D('1').div(D('3')).toString(), '0.3333333333333333333333333333');
  });

  it('takes the remainder with the sign of the dividend', () => {
    assert.equal(D('7').mod(D('3')).toString(), '1');
    assert.equal(D('-7').mod(D('3')).toString(), '-1');
    assert.ok(D('2077622.00').sub(D('77622.00')).mod(D('100000')).isZero());
  });

  it('sums an iterable from zero', () => {
    assert.equal(sumDecimals([D('1.10'), D('2.20'), D('3.30')]).toString(), '6.60');
    assert.equal(sumDecimals([]).toString(), '0');
  });
});

describe('rounding', () => {
  it('rounds half to even by default, as Python does', () => {
    assert.equal(D('2.5').round(0).toString(), '2');
    assert.equal(D('3.5').round(0).toString(), '4');
    assert.equal(D('1.005').round(2).toString(), '1.00');
  });

  it('rounds half up when asked', () => {
    assert.equal(D('2.5').quantize('1', ROUND_HALF_UP).toString(), '3');
    assert.equal(D('-2.5').quantize('1', ROUND_HALF_UP).toString(), '-3');
  });

  it('quantises to a pattern', () => {
    assert.equal(D('1.23456').quantize('0.0001').toString(), '1.2346');
    assert.equal(D('7').quantize('0.01').toString(), '7.00');
  });

  it('truncates toward zero for an integer', () => {
    assert.equal(D('1.99').toBigInt(), 1n);
    assert.equal(D('-1.99').toBigInt(), -1n);
  });
});
