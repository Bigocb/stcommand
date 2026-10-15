/**
 * Compress JSON responses with gzip when the browser accepts it. Built on Node's own zlib, so no new dependency.
 *
 * Why: the dashboard polls several JSON endpoints every 15 seconds per open screen, and nothing was compressed. JSON
 * shrinks five to ten times. Small bodies (under `threshold` bytes) are sent as they are: compressing them costs more
 * than it saves. Compression runs asynchronously so a large body doesn't hold the event loop the fleet also uses.
 */
import type { NextFunction, Request, Response } from "express";
import { gzip } from "node:zlib";

export function gzipJson(threshold = 1024) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!/\bgzip\b/.test(String(req.headers["accept-encoding"] ?? ""))) return next();
    const send = res.json.bind(res);
    res.json = ((body: unknown) => {
      const text = JSON.stringify(body);
      if (text === undefined || Buffer.byteLength(text) < threshold || res.headersSent) return send(body);
      gzip(text, (err, zipped) => {
        if (res.headersSent) return;
        res.setHeader("Vary", "Accept-Encoding");
        res.type("application/json");
        if (err) {
          res.send(text);
          return;
        }
        res.setHeader("Content-Encoding", "gzip");
        res.setHeader("Content-Length", String(zipped.length));
        res.end(zipped);
      });
      return res;
    }) as Response["json"];
    next();
  };
}
