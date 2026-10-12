/**
 * A survey tour: a surveyor visits a list of asteroid fields in turn and takes a few survey batches at each, so the field
 * tally (what `mining_fields` reads) fills in. One pass ends when every field has its batches; a LOOPING tour starts the
 * next lap instead, so the numbers keep firming up and follow the fields as they change. Pure: no I/O, no clock.
 */
export interface SurveyTourPlan {
  fields: string[];
  /** Survey batches to take at each field per lap. */
  perField: number;
  /** Start another lap when one finishes, instead of ending the tour. */
  loop: boolean;
  /** Laps finished so far. */
  laps: number;
  /** Batches taken at each field in the current lap. */
  done: Map<string, number>;
}

export type TourStep =
  | { kind: "survey"; field: string }
  | { kind: "lap"; laps: number }
  | { kind: "complete" };

/**
 * What the surveyor should do next: survey the first field still short of its batches, or, when every field has them,
 * finish the lap (and, for a loop, the caller resets `done` and calls again) or end the tour.
 */
export function nextTourStep(plan: SurveyTourPlan): TourStep {
  const next = plan.fields.find((f) => (plan.done.get(f) ?? 0) < plan.perField);
  if (next) return { kind: "survey", field: next };
  return plan.loop ? { kind: "lap", laps: plan.laps + 1 } : { kind: "complete" };
}

/** Start the next lap: count it and clear the per-field tally. */
export function startNextLap(plan: SurveyTourPlan): void {
  plan.laps += 1;
  plan.done = new Map();
}

/**
 * Visit order that keeps the flying short: from `start`, always the nearest field not yet visited. A greedy tour, not the
 * shortest possible, but it never zig-zags across the system, and a loop repeats it every lap.
 */
export function orderNearest(fields: string[], coords: Map<string, { x: number; y: number }>, start?: { x: number; y: number }): string[] {
  const left = [...new Set(fields)];
  const out: string[] = [];
  let at = start;
  while (left.length) {
    let best = 0;
    if (at) {
      let bestD = Infinity;
      left.forEach((f, i) => {
        const c = coords.get(f);
        const d = c ? Math.hypot(c.x - at!.x, c.y - at!.y) : Infinity;
        if (d < bestD) { bestD = d; best = i; }
      });
    }
    const [pick] = left.splice(best, 1);
    out.push(pick!);
    at = coords.get(pick!) ?? at;
  }
  return out;
}
