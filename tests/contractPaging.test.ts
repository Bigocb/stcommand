import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Client, SpaceTradersAPI } from "../src/core/client.js";

/**
 * getContracts() must return the newest page. The API lists contracts oldest first, 20 per page, and the only open
 * contract is always the newest; reading page 1 alone hid THEOREM_DEV_2's 21st contract (2026-10-08).
 */
describe("SpaceTradersAPI.getContracts paging", () => {
  it("follows meta.total to the last page, then starts there next time", async () => {
    const all = Array.from({ length: 21 }, (_, i) => ({ id: `c${i + 1}` }));
    const pages: number[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = new URL(typeof input === "string" ? input : input.toString());
      const page = Number(url.searchParams.get("page") ?? 1);
      pages.push(page);
      const data = all.slice((page - 1) * 20, page * 20);
      return new Response(JSON.stringify({ data, meta: { total: all.length, page, limit: 20 } }), {
        status: 200, headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;
    try {
      const api = new SpaceTradersAPI(new Client({ token: "t" }), "t");
      const first = await api.getContracts();
      assert.deepEqual(first.map((c) => c.id), ["c21"]);
      assert.deepEqual(pages, [1, 2]);
      await api.getContracts();
      assert.deepEqual(pages, [1, 2, 2], "the second read goes straight to the last page");
    } finally {
      globalThis.fetch = original;
    }
  });
});
