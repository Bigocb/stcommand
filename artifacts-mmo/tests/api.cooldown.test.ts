import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCooldownTracker, predictMove, predictFight, predictGathering, predictCrafting, predictRest, predictOther, tileDistance } from '../src/api/cooldown.js';
import { classify, errorInfo, ApiError } from '../src/api/errors.js';

test('tracker records readyAt and waitMs per character', () => {
  const t = createCooldownTracker();
  assert.equal(t.waitMs('A', 100), 0);
  t.record('A', { total_seconds: 10, remaining_seconds: 10, expiration: 'x', reason: 'move' }, 1000);
  assert.equal(t.readyAt('A'), 11000);
  assert.equal(t.waitMs('A', 5000), 6000);
  assert.equal(t.waitMs('A', 20000), 0);
  assert.equal(t.waitMs('B', 5000), 0);
});

test('tracker falls back to expiration when remaining missing', () => {
  const t = createCooldownTracker();
  t.record('A', { total_seconds: 5, remaining_seconds: NaN, expiration: '1970-01-01T00:00:07.000Z' }, 0);
  assert.equal(t.readyAt('A'), 7000);
});

test('predictors', () => {
  assert.equal(predictMove(4), 20);
  assert.equal(tileDistance({ x: 0, y: 0 }, { x: 3, y: 4 }), 5);
  assert.equal(tileDistance({ x: 1, y: 1 }, { x: 1, y: 1 }), 1);
  assert.equal(predictFight(20), 40);
  assert.equal(predictFight(20, 25), 30);
  assert.equal(predictFight(2), 5);          // minimum
  assert.equal(predictFight(30, 100), 5);
  assert.equal(predictGathering(0), 30);
  assert.equal(predictGathering(10), 35);
  assert.equal(predictGathering(10, 20), 28);
  assert.equal(predictCrafting(3), 15);
  assert.equal(predictRest(100), 20);
  assert.equal(predictRest(5), 3);           // minimum
  assert.equal(predictOther(), 3);
});

test('error table classification', () => {
  assert.equal(classify(499), 'retryable-after-cooldown');
  assert.equal(classify(429), 'retryable-backoff');
  assert.equal(classify(452), 'fatal');
  assert.equal(classify(454), 'fatal');
  assert.equal(classify(492), 'caller-bug');
  assert.equal(classify(497), 'caller-bug');
  assert.equal(classify(503), 'retryable-backoff');
  assert.equal(classify(999), 'caller-bug');
  assert.equal(errorInfo(462)?.name, 'BANK_FULL');
  assert.equal(new ApiError(454, 'm', 401).cls, 'fatal');
});
