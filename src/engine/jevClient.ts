import { JudgeError, type Answer, type Judge, type JudgeRequest, type JudgeResult } from "./judge.js";

/**
 * HTTP adapter for TypeSafe's Jev: POST {state, model, questions} to the official endpoint with a Bearer key.
 *
 * The endpoint is fixed on purpose. A community write-up of this API names a different host (thejevai.com); the provider's
 * own API reference says https://api.typesafe.ai/v1/systemone, and fleet state must never go to a host nobody verified.
 * The key is read from the environment by judgeFromEnv() and is never put in an error message or a log line.
 */
export const JEV_URL = "https://api.typesafe.ai/v1/systemone";

export interface JevOptions {
  apiKey: string;
  /** "jev-latest" follows the provider; pin a version (e.g. "jev-1.13.0") if answers must not drift. */
  model?: string;
  timeoutMs?: number;
  /** Extra tries after a 429 or 529. */
  retries?: number;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

function parseProbabilities(v: unknown): Record<string, number> | undefined {
  if (!isObj(v)) return undefined;
  const out: Record<string, number> = {};
  for (const [k, p] of Object.entries(v)) {
    const n = num(p);
    if (n === undefined) return undefined;
    out[k] = n;
  }
  return out;
}

function parseAnswer(raw: unknown): Answer | undefined {
  if (!isObj(raw)) return undefined;
  if (raw.type === "noul") {
    const p = num(raw.noul);
    return p !== undefined && p >= 0 && p <= 1 ? { type: "noul", noul: p } : undefined;
  }
  const probabilities = parseProbabilities(raw.probabilities);
  const confidence = num(raw.confidence);
  if (!probabilities || confidence === undefined) return undefined;
  if (raw.type === "choice") return typeof raw.choice === "string" ? { type: "choice", choice: raw.choice, probabilities, confidence } : undefined;
  if (raw.type === "score") {
    const score = num(raw.score);
    return score !== undefined ? { type: "score", score, probabilities, confidence } : undefined;
  }
  return undefined;
}

/** Validates a response body against the documented shape. A malformed one is an error, not a guess. */
export function parseJevResponse(json: unknown): Omit<JudgeResult, "latencyMs"> {
  if (!isObj(json) || !isObj(json.answers)) throw new JudgeError("unexpected response shape: no answers");
  const answers: Record<string, Answer> = {};
  for (const [id, raw] of Object.entries(json.answers)) {
    const a = parseAnswer(raw);
    if (!a) throw new JudgeError(`unexpected response shape: answer "${id}"`);
    answers[id] = a;
  }
  const usage = isObj(json.usage) ? json.usage : {};
  return {
    answers,
    model: typeof json.model === "string" ? json.model : "unknown",
    inputTokens: num(usage.input_tokens) ?? 0,
    outputTokens: num(usage.output_tokens) ?? 0,
  };
}

export function createJevJudge(opts: JevOptions): Judge {
  const doFetch = opts.fetch ?? fetch;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = opts.now ?? Date.now;
  const retries = opts.retries ?? 1;
  const timeoutMs = opts.timeoutMs ?? 4000;
  return {
    async decide(request: JudgeRequest): Promise<JudgeResult> {
      const body = JSON.stringify({ state: request.state, model: opts.model ?? "jev-latest", questions: request.questions });
      const started = now();
      for (let attempt = 0; ; attempt++) {
        let res: Response;
        try {
          res = await doFetch(JEV_URL, {
            method: "POST",
            headers: { Authorization: `Bearer ${opts.apiKey}`, "Content-Type": "application/json" },
            body,
            signal: AbortSignal.timeout(timeoutMs),
          });
        } catch (err) {
          // A timeout or a network failure. Never echo the request, which carries the state.
          throw new JudgeError(`decision model unreachable: ${err instanceof Error ? err.name : "error"}`, undefined, true);
        }
        if (res.ok) {
          let json: unknown;
          try {
            json = await res.json();
          } catch {
            throw new JudgeError("unexpected response shape: not JSON");
          }
          return { ...parseJevResponse(json), latencyMs: now() - started };
        }
        if ((res.status === 429 || res.status === 529) && attempt < retries) {
          await sleep(400 * (attempt + 1));
          continue;
        }
        if (res.status === 401) throw new JudgeError("decision model rejected the API key", 401);
        const detail = (await res.text().catch(() => "")).slice(0, 160);
        throw new JudgeError(`decision model returned ${res.status}${detail ? `: ${detail}` : ""}`, res.status, res.status === 429 || res.status === 529);
      }
    },
  };
}

/** The live judge, or undefined while no key is set: every caller treats "no judge" as "carry on without the model". */
export function judgeFromEnv(env: NodeJS.ProcessEnv = process.env, overrides: Partial<JevOptions> = {}): Judge | undefined {
  const apiKey = env.TYPESAFE_API_KEY?.trim();
  if (!apiKey) return undefined;
  return createJevJudge({ apiKey, model: env.JEV_MODEL?.trim() || undefined, ...overrides });
}
