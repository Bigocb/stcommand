import type { CategoryDef } from "./types.js";

/**
 * The kinds of alert. To add one: add an entry here, write a detector for it (detectors.ts) that returns events with this
 * `category`, and add the detector to DETECTORS. The settings screen lists whatever is here.
 */
export const CATEGORIES: readonly CategoryDef[] = [
  { id: "approvals", label: "Approvals waiting", description: "Something is waiting for your decision.", defaultOn: true, cooldownMin: 0 },
  { id: "stranded", label: "Stranded ships", description: "A ship cannot continue on its own.", defaultOn: true, cooldownMin: 120 },
  { id: "idle", label: "Idle traders", description: "A trader has had no route for five minutes or more.", defaultOn: true, cooldownMin: 60 },
  { id: "attention", label: "Needs a look", description: "A ship the attention feed rates critical (stuck, looping, wasting).", defaultOn: true, cooldownMin: 180 },
  { id: "reset", label: "Server reset", description: "The weekly universe reset is close.", defaultOn: true, cooldownMin: 0 },
  { id: "rate", label: "Earning rate", description: "The hourly rate has fallen well below its recent average.", defaultOn: false, cooldownMin: 180 },
];

const BY_ID = new Map(CATEGORIES.map((c) => [c.id, c]));

export function categoryOf(id: string): CategoryDef | undefined {
  return BY_ID.get(id);
}
