import assert from 'node:assert/strict';
import { test } from 'node:test';
import { areaOf, nearestIndex, niceMax, pathOf, stackedMax, toSegments } from './chart.ts';

test('niceMax rounds to 1, 2, 5 times a power of ten', () => {
  assert.equal(niceMax(0), 1);
  assert.equal(niceMax(-3), 1);
  assert.equal(niceMax(Number.NaN), 1);
  assert.equal(niceMax(0.7), 1);
  assert.equal(niceMax(1), 1);
  assert.equal(niceMax(1.4), 2);
  assert.equal(niceMax(3), 5);
  assert.equal(niceMax(5), 5);
  assert.equal(niceMax(5.1), 10);
  assert.equal(niceMax(87), 100);
  assert.equal(niceMax(212), 500);
  for (const v of [0.03, 0.5, 7, 99, 1234, 98765]) assert.ok(niceMax(v) >= v, String(v));
});

test('toSegments: scaling, gaps at null, a single point', () => {
  const [seg] = toSegments([0, 5, 10], 10, 100, 50, 0);
  assert.deepEqual(seg, [{ x: 0, y: 50 }, { x: 50, y: 25 }, { x: 100, y: 0 }]);
  assert.equal(toSegments([1, null, 3], 3, 100, 50).length, 2);
  assert.equal(toSegments([null, null], 3, 100, 50).length, 0);
  assert.deepEqual(toSegments([4], 4, 100, 50, 0), [[{ x: 50, y: 0 }]]);
  // values above the axis are not clamped silently below the baseline, negatives are
  assert.equal(toSegments([-5], 10, 100, 50, 0)[0]![0]!.y, 50);
});

test('paths', () => {
  const seg = [{ x: 0, y: 10 }, { x: 5, y: 4.56 }];
  assert.equal(pathOf(seg), 'M0.0 10.0L5.0 4.6');
  assert.equal(areaOf(seg, 20), 'M0.0 10.0L5.0 4.6L5.0 20L0.0 20Z');
  assert.equal(areaOf([], 20), '');
});

test('nearestIndex stays in range', () => {
  assert.equal(nearestIndex(0, 100, 5), 0);
  assert.equal(nearestIndex(100, 100, 5), 4);
  assert.equal(nearestIndex(60, 100, 5), 2);
  assert.equal(nearestIndex(-20, 100, 5), 0);
  assert.equal(nearestIndex(500, 100, 5), 4);
  assert.equal(nearestIndex(10, 100, 1), 0);
  assert.equal(nearestIndex(10, 100, 0), 0);
});

test('stackedMax sums per point in time and treats null as 0', () => {
  assert.equal(stackedMax([[1, 2, null], [3, null, 4]]), 4);
  assert.equal(stackedMax([]), 0);
  assert.equal(stackedMax([[5, 5], [5]]), 10);
});
