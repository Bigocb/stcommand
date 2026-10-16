import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createClient, type FetchLike } from '../src/api/client.js';
import { ApiError } from '../src/api/errors.js';

function harness(responses: Array<{ status?: number; body: unknown; headers?: Record<string, string> }>) {
  let t = 1_000_000;
  const calls: { url: string; method: string; body?: string; headers: Record<string, string>; at: number }[] = [];
  const sleeps: number[] = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, method: init.method, body: init.body, headers: init.headers, at: t });
    const r = responses.shift();
    if (!r) throw new Error('unexpected fetch');
    const status = r.status ?? 200;
    return { ok: status < 400, status, headers: { get: (k) => r.headers?.[k.toLowerCase()] ?? null }, json: async () => r.body };
  };
  const client = createClient({
    token: 'test-token', fetch, now: () => t,
    sleep: async (ms) => { sleeps.push(ms); t += ms; },
  });
  return { client, calls, sleeps, now: () => t };
}
const cd = (s: number) => ({ total_seconds: s, remaining_seconds: s, expiration: '', reason: 'move', started_at: '' });

test('success unwraps {data}, sends bearer token and JSON body', async () => {
  const h = harness([{ body: { data: { cooldown: cd(5), destination: {} } } }]);
  const r = await h.client.move('Bob', { x: 1, y: 2 });
  assert.equal(r.cooldown.total_seconds, 5);
  assert.equal(h.calls[0]!.url, 'https://api.artifactsmmo.com/my/Bob/action/move');
  assert.equal(h.calls[0]!.headers.Authorization, 'Bearer test-token');
  assert.equal(h.calls[0]!.body, '{"x":1,"y":2}');
});

test('waits recorded cooldown before the next action for same character only', async () => {
  const h = harness([
    { body: { data: { cooldown: cd(10) } } }, { body: { data: { cooldown: cd(3) } } }, { body: { data: { cooldown: cd(3) } } },
  ]);
  await h.client.rest('Bob');
  await h.client.rest('Ann');
  assert.deepEqual(h.sleeps, []);
  await h.client.rest('Bob');
  assert.equal(h.sleeps.length, 1);
  assert.equal(h.sleeps[0], 10_000);
});

test('499 waits reported remaining time and retries once, then gives up', async () => {
  const e499 = { status: 499, body: { error: { code: 499, message: 'Character in cooldown: 7 seconds remaining' } } };
  const h = harness([e499, { body: { data: { cooldown: cd(5) } } }]);
  const r = await h.client.gathering('Bob');
  assert.equal(r.cooldown.total_seconds, 5);
  assert.equal(h.calls.length, 2);
  assert.ok(h.sleeps.some((s) => s >= 7000 && s <= 7200), `sleeps ${h.sleeps}`);

  const h2 = harness([e499, e499]);
  await assert.rejects(h2.client.gathering('Bob'), (e: unknown) => e instanceof ApiError && e.code === 499 && e.cls === 'retryable-after-cooldown');
  assert.equal(h2.calls.length, 2);
});

test('429 backs off exponentially then succeeds; exhausted retries throw', async () => {
  const e429 = { status: 429, body: { error: { code: 429, message: 'Rate limit exceeded' } } };
  const h = harness([e429, e429, { body: { data: { id: 1 } } }]);
  await h.client.getServer();
  assert.deepEqual(h.sleeps, [1000, 2000]);

  const h2 = harness([e429, e429, e429, e429]);
  await assert.rejects(h2.client.getServer(), (e: unknown) => e instanceof ApiError && e.code === 429 && e.cls === 'retryable-backoff');
});

test('token missing is fatal and not retried', async () => {
  const h = harness([{ status: 401, body: { error: { code: 454, message: 'Token is missing.' } } }]);
  await assert.rejects(h.client.getMyCharacters(), (e: unknown) => e instanceof ApiError && e.code === 454 && e.cls === 'fatal');
  assert.equal(h.calls.length, 1);
});

test('typed ApiError for caller bug (497 inventory full)', async () => {
  const h = harness([{ status: 497, body: { error: { code: 497, message: "The character's inventory is full." } } }]);
  await assert.rejects(h.client.bankWithdrawItems('Bob', [{ code: 'x', quantity: 1 }]), (e: unknown) => e instanceof ApiError && e.cls === 'caller-bug');
});

test('listAll paginates until pages exhausted', async () => {
  const h = harness([
    { body: { data: [{ code: 'a' }, { code: 'b' }], total: 3, page: 1, size: 2, pages: 2 } },
    { body: { data: [{ code: 'c' }], total: 3, page: 2, size: 2, pages: 2 } },
  ]);
  const rows = await h.client.listAll<{ code: string }>('/items', { type: 'weapon' });
  assert.deepEqual(rows.map((r) => r.code), ['a', 'b', 'c']);
  assert.match(h.calls[0]!.url, /\/items\?type=weapon&page=1&size=100$/);
  assert.match(h.calls[1]!.url, /page=2/);
});

test('limiter delays requests beyond headroom without any 429', async () => {
  const bodies = Array.from({ length: 12 }, () => ({ body: { data: {} } }));
  const h = harness(bodies);
  for (let i = 0; i < 12; i++) await h.client.getServer();
  assert.equal(h.calls.length, 12);
  assert.ok(h.sleeps.length > 0); // 9/s headroom forced a wait
  assert.ok(h.calls[11]!.at - h.calls[0]!.at >= 1000);
});
