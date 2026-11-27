import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { screenRoutes } from "../src/http/screenRoutes.js";

describe("screenRoutes (issue #87)", () => {
  const all = [
    { good: "A", profitPerTrip: 10 }, { good: "B", profitPerTrip: 500 }, { good: "A", profitPerTrip: 900 },
    { good: "C", profitPerTrip: 1 }, { good: "B", profitPerTrip: 5 }, { good: "A", profitPerTrip: 2 },
  ];
  it("keeps each good's first route and the best by profit per trip, in the list's order", () => {
    assert.deepEqual(screenRoutes(all, 1), [all[0], all[1], all[2], all[3]]);
  });
  it("find(good) and the top-N board read the same as on the full list", () => {
    const cut = screenRoutes(all, 2);
    for (const g of ["A", "B", "C"]) assert.equal(cut.find((r) => r.good === g), all.find((r) => r.good === g));
    const best = (xs: typeof all) => [...xs].sort((a, b) => b.profitPerTrip - a.profitPerTrip).slice(0, 2);
    assert.deepEqual(best(cut), best(all));
  });
});
