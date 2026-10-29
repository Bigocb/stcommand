import { test } from "node:test";
import assert from "node:assert/strict";
// @ts-expect-error plain browser module
import { hourlyRows, hourlyAverage } from "../public/shared/hourly.js";

const H = 3_600_000;
const t0 = Date.parse("2026-10-29T18:00:00Z");
// 30-minute buckets for three hours; worth climbs 1M per complete hour.
const buckets = [0, 1, 2, 3, 4, 5].map((i) => ({ t: t0 + i * 30 * 60_000, net: 500_000, sells: 40, netWorth: 20_000_000 + (i + 1) * 500_000 }));

test("buckets roll up into clock hours, newest first, with the running hour marked", () => {
  const rows = hourlyRows(buckets, 30, t0 + 2.5 * H);
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.map((r: { start: number }) => r.start), [t0 + 2 * H, t0 + H, t0]);
  assert.equal(rows[0].partial, true);
  assert.equal(rows[1].partial, false);
  assert.equal(rows[1].net, 1_000_000);
  assert.equal(rows[1].sells, 80);
  assert.equal(rows[1].worth, 1_000_000); // end of 19:00 hour against the end of the 18:00 hour
});

test("the first hour's worth is measured inside the hour; an hour with no worth samples is null", () => {
  const rows = hourlyRows(buckets, 30, t0 + 3 * H);
  assert.equal(rows[2].worth, 500_000);
  const noWorth = hourlyRows([{ t: t0, net: 10, sells: 1, netWorth: null }], 30, t0 + 3 * H);
  assert.equal(noWorth[0].worth, null);
});

test("the average skips the running hour", () => {
  const rows = hourlyRows(buckets, 30, t0 + 2.5 * H);
  assert.deepEqual(hourlyAverage(rows, 3), { hours: 2, net: 1_000_000, sells: 80, worth: 750_000 });
  assert.equal(hourlyAverage([], 3), null);
});
