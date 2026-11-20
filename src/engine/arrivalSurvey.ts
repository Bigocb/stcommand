/**
 * Whether a ship that has just jumped into a system should read every market and shipyard there.
 *
 * FleetManager.jumpShip() ran a full survey (one call per market and per yard, 20 to 25 in a big system) after every jump
 * by a tour ship, explorer or keeper delivery, including a pass straight through a system our keepers already read.
 * 2026-11-05 it was the biggest single API spender, 19 calls a minute of the 90 (21%), at a priority that kept the keepers'
 * own reads waiting 9 to 15 seconds.
 *
 * The rule: survey when the system has never been surveyed, or its last survey is older than `maxAgeMs`, and no keeper
 * is stationed in it. A system with keepers is read by them; a fresh survey adds nothing. The waypoints and gates are
 * still loaded on every arrival (the caller does that), because distances and the next hop need them.
 *
 * Pure: facts in, verdict and a one-line reason out. Policy is data, backed by the doctrine clause arrivalSurveyMaxAgeMin;
 * with the clause off every arrival surveys, as before.
 *
 * Read keepers only (clause arrivalSurveyReadKeepers, off by default; operator 2026-11-20): a keeper counts as reading the system
 * only once its market has a price on record. A staged system has a keeper assigned to every market from the moment it is staged,
 * so the first probe through the gate was told "8 keeper(s) read it already" while nothing there had been priced, and flew on
 * without reading the market it arrived at (HQ44, 2026-11-20 19:05).
 */

export interface ArrivalSurveyPolicy {
  /** Off: survey on every arrival (the old behaviour). */
  enabled: boolean;
  /** A survey younger than this is fresh enough to skip. */
  maxAgeMs: number;
  /** Count only keepers whose market has been priced (needs `keepersRead` in the facts). Off: every assigned keeper counts. */
  readKeepersOnly?: boolean;
}

export interface ArrivalFacts {
  /** When the system was last surveyed, or undefined if never. */
  surveyedAtMs?: number;
  /** Keepers stationed on markets in the system. */
  keepers: number;
  /** Of those, the ones whose market has a price on record. Undefined when unknown (then `keepers` is used). */
  keepersRead?: number;
  now: number;
}

export interface ArrivalVerdict {
  survey: boolean;
  reason: string;
}

export function arrivalSurvey(f: ArrivalFacts, policy: ArrivalSurveyPolicy): ArrivalVerdict {
  if (!policy.enabled) return { survey: true, reason: "arrival survey rule off" };
  if (f.surveyedAtMs === undefined) return { survey: true, reason: "never surveyed" };
  const useRead = policy.readKeepersOnly === true && f.keepersRead !== undefined;
  const reading = useRead ? f.keepersRead! : f.keepers;
  if (reading > 0) return { survey: false, reason: `${reading} keeper(s) read it already` };
  if (useRead && f.keepers > 0) return { survey: true, reason: `${f.keepers} keeper(s) assigned but none has read its market yet` };
  const ageMin = Math.round((f.now - f.surveyedAtMs) / 60_000);
  if (f.now - f.surveyedAtMs < policy.maxAgeMs) return { survey: false, reason: `surveyed ${ageMin} min ago` };
  return { survey: true, reason: `last survey ${ageMin} min ago` };
}
