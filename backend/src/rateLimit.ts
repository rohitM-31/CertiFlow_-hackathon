import type { NextFunction, Request, Response } from "express";

/**
 * Fixed-window rate limiter kept in memory.
 *
 * Known limitation: each API instance counts separately (N instances allow N x limit).
 * Enough to stop casual scraping of public endpoints; in production a shared limit
 * belongs at the edge (CDN / load balancer), see DEPLOYMENT.md.
 */
const windows = new Map<string, { minute: number; count: number }>();

setInterval(() => {
  const now = Math.floor(Date.now() / 60_000);
  for (const [key, w] of windows) if (w.minute < now) windows.delete(key);
}, 60_000).unref();

export function rateLimit(name: string, limitPerMinute: number) {
  return (req: Request, res: Response, next: NextFunction) => {
    const minute = Math.floor(Date.now() / 60_000);
    const key = `${name}:${req.ip}`;
    const w = windows.get(key);
    const count = w && w.minute === minute ? w.count + 1 : 1;
    windows.set(key, { minute, count });
    if (count > limitPerMinute) {
      res.setHeader("Retry-After", "60");
      res.status(429).json({ error: "Too many requests, please try again in a minute" });
      return;
    }
    next();
  };
}
