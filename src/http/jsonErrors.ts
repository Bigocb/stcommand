import type { ErrorRequestHandler } from "express";

/**
 * Turn an error thrown out of an async route into a JSON `{ error }` body.
 *
 * Express 5 forwards a rejected async handler to the default error handler, which answers a bare HTML 500 and hides the
 * message. Most dashboard routes carry their own try/catch, but the feed routes (and several others) do not, so a
 * plain "say which feed" refusal reached the page as an opaque 500 (2026-10-08: removing COPPER_ORE, which had both a
 * buying and a mining feed, from a page that did not say which). An error that carries a numeric `status` (a refusal
 * the caller can fix) keeps it; anything else stays a 500 and is logged.
 */
export const jsonErrors: ErrorRequestHandler = (err, req, res, next) => {
  if (res.headersSent) return next(err);
  const status = typeof err?.status === "number" && err.status >= 400 && err.status < 600 ? err.status : 500;
  if (status >= 500) console.error(`[dashboard] ${req.method} ${req.originalUrl} error`, err);
  res.status(status).json({ error: err instanceof Error ? err.message : String(err) });
};
