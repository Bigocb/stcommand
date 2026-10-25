import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { validateTaskSpec } from "../src/engine/openingTasks.js";
import {
  OPENING_PRESETS, describeTask, uniqueKey, presetError, buildCustomTask, shipRefFromChoice,
  // @ts-expect-error plain browser module, no types
} from "../public/shared/openingPresets.js";

/**
 * The opening form used to be three pop-ups that could only change the command ship's role. These presets and the custom
 * builder replace it; the server's own validator is the gate, so every shape built here must pass it.
 */
const defaults = (p: any) => Object.fromEntries(p.fields.map((f: any) => [f.name, f.value]));

describe("opening presets", () => {
  for (const preset of OPENING_PRESETS) {
    it(`${preset.id}: its default values build a task the server accepts`, () => {
      const spec = preset.build(defaults(preset), { existingKeys: [] });
      const v = validateTaskSpec(spec);
      assert.ok(v.ok, v.ok ? "" : v.error);
      assert.equal(presetError(preset, defaults(preset)), null);
    });
  }

  it("a tour-ship task waits for the contract ship only when that task is queued", () => {
    const tour = OPENING_PRESETS.find((p: any) => p.id === "tour-ship")!;
    const alone = tour.build(defaults(tour), { existingKeys: [] }) as any;
    assert.equal(alone.trigger.kind, "cashAtLeast");
    const after = tour.build(defaults(tour), { existingKeys: ["contract-ship"] }) as any;
    assert.equal(after.trigger.kind, "all");
    assert.ok(after.trigger.of.some((m: any) => m.kind === "taskDone" && m.taskKey === "contract-ship"));
    assert.ok(validateTaskSpec(after).ok);
  });

  it("keys are made unique and within the server's rule", () => {
    assert.equal(uniqueKey("contract-ship", ["contract-ship"]), "contract-ship-2");
    assert.match(uniqueKey("A very Long Name With Spaces and Symbols!!!", []), /^[a-z0-9_-]{1,24}$/);
    assert.match(uniqueKey("   ", []), /^[a-z0-9_-]{1,24}$/);
  });

  it("rejects an empty or non-numeric amount before the server sees it", () => {
    const p = OPENING_PRESETS[0]!;
    assert.match(presetError(p, { cash: NaN, maxPrice: 1 })!, /Start when cash/);
    assert.match(presetError(OPENING_PRESETS.find((x: any) => x.id === "command-role")!, { role: "boss" })!, /Role/);
  });
});

describe("custom builder", () => {
  it("builds a multi-step task the server accepts, referring to a ship bought earlier", () => {
    const spec = buildCustomTask({
      name: "Probe then keep",
      trigger: { kind: "cashAtLeast", amount: 50000 },
      steps: [
        { kind: "buyShip", shipType: "SHIP_PROBE", maxPrice: 30000, preApproved: true },
        { kind: "setRole", ship: "step:1", role: "keeper" },
        { kind: "setDoctrine", key: "keeperTriage", enabled: true },
      ],
    }, { existingKeys: [] }) as any;
    assert.deepEqual(spec.steps[1].ship, { by: "step", step: 0 });
    const v = validateTaskSpec(spec);
    assert.ok(v.ok, v.ok ? "" : v.error);
  });

  it("maps ship choices", () => {
    assert.deepEqual(shipRefFromChoice("command"), { by: "command" });
    assert.deepEqual(shipRefFromChoice("step:2"), { by: "step", step: 1 });
    assert.deepEqual(shipRefFromChoice("THEOREM-7"), { by: "symbol", symbol: "THEOREM-7" });
  });
});

describe("plain-English description", () => {
  it("says what a task does in words", () => {
    const p = OPENING_PRESETS[0]!;
    const text = describeTask(p.build(defaults(p), { existingKeys: [] }));
    assert.match(text, /^When cash reaches 200,000c: buy a light shuttle for up to 100,000c/);
    assert.match(text, /put the ship bought in step 1 on contract duty/);
  });

  it("describes a combined trigger", () => {
    const h = OPENING_PRESETS.find((x: any) => x.id === "hauler")!;
    const text = describeTask(h.build(defaults(h), { existingKeys: [] }));
    assert.match(text, /When cash reaches 450,000c, and when the best route pays 100,000c a trip/);
  });
});

describe("survey-ship preset", () => {
  it("reads in plain words, including the wait", () => {
    const p = OPENING_PRESETS.find((x: any) => x.id === "survey-ship")!;
    const text = describeTask(p.build(defaults(p), { existingKeys: [] }));
    assert.match(text, /buy a light shuttle/);
    assert.match(text, /make the ship bought in step 1 a tour/);
    assert.match(text, /wait until every market worth a keeper has been priced/);
    assert.match(text, /a trader\.$/);
  });
});
