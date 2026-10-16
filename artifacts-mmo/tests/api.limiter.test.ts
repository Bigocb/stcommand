import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLimiter, bucketFor, DEFAULT_LIMITS } from '../src/api/limiter.js';

test('headroom 0.9 caps 10/s at 9 and frees exactly at window boundary', () => {
  const l = createLimiter();
  for (let i = 0; i < 9; i++) assert.deepEqual(l.tryAcquire('action', 1000 + i), { ok: true });
  const r = l.tryAcquire('action', 1500);
  assert.equal(r.ok, false);
  if (!r.ok) { assert.equal(r.waitMs, 500); assert.match(r.reason, /1000ms/); }
  assert.equal(l.tryAcquire('action', 1999).ok, false); // oldest (1000) still inside window
  assert.equal(l.tryAcquire('action', 2000).ok, true);  // 1000 + 1000 frees the slot
});

test('headroom 1.0 allows the full limit', () => {
  const l = createLimiter({ headroom: 1 });
  for (let i = 0; i < 10; i++) assert.equal(l.tryAcquire('data', i).ok, true);
  assert.equal(l.tryAcquire('data', 10).ok, false);
});

test('minute window binds after the second window clears', () => {
  const l = createLimiter({ headroom: 1 });
  let t = 0;
  for (let i = 0; i < 100; i++) { assert.equal(l.tryAcquire('action', t).ok, true); t += 200; } // 5/s, never hits 10/s
  const r = l.tryAcquire('action', t);
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.waitMs, 60_000 - t); // oldest at 0
});

test('hourly cap on account bucket (300 * 0.9 = 270)', () => {
  const l = createLimiter();
  let t = 0;
  for (let i = 0; i < 270; i++) { assert.equal(l.tryAcquire('account', t).ok, true); t += 5000; }
  assert.equal(l.tryAcquire('account', t).ok, false);
  assert.equal(l.tryAcquire('account', 3_600_000).ok, true);
});

test('buckets are independent and a refused call is not counted', () => {
  const l = createLimiter({ limits: { ...DEFAULT_LIMITS, data: [{ windowMs: 1000, max: 1 }] }, headroom: 1 });
  assert.equal(l.tryAcquire('data', 0).ok, true);
  assert.equal(l.tryAcquire('data', 1).ok, false);
  assert.equal(l.tryAcquire('action', 1).ok, true);
  assert.equal(l.usage('data', 1)[0]!.used, 1);
});

test('bucketFor mapping', () => {
  assert.equal(bucketFor('POST', '/my/Bob/action/move'), 'action');
  assert.equal(bucketFor('GET', '/my/bank'), 'account');
  assert.equal(bucketFor('GET', '/my/grandexchange/orders?page=1'), 'account');
  assert.equal(bucketFor('GET', '/my/characters'), 'data');
  assert.equal(bucketFor('GET', '/characters/Bob'), 'data');
  assert.equal(bucketFor('GET', '/items'), 'data');
  assert.equal(bucketFor('GET', '/'), 'data');
});
