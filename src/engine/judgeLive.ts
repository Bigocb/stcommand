import { judgeFromEnv } from "./jevClient.js";
import type { Judge } from "./judge.js";

/**
 * The process's one decision model, read from the environment on first use (TYPESAFE_API_KEY). Undefined while no key is set,
 * and every caller treats that as "carry on without the model". One instance is shared: it holds no per-tenant state.
 */
let cached: Judge | undefined;
let read = false;

export function getJudge(): Judge | undefined {
  if (!read) {
    cached = judgeFromEnv();
    read = true;
  }
  return cached;
}

/** For tests: replace what getJudge() returns, or pass nothing to read the environment again. */
export function setJudgeForTests(judge?: Judge): void {
  cached = judge;
  read = judge !== undefined;
}
