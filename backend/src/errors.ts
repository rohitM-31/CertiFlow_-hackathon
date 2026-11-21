import type { NextFunction, Request, Response } from "express";
import { ZodError } from "zod";
import { log } from "./logger.js";

/** An error that maps directly to an HTTP response. Throw it from anywhere. */
export class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
  }
}

export const badRequest = (msg: string, details?: unknown) => new HttpError(400, msg, details);
export const unauthorized = (msg = "Not logged in") => new HttpError(401, msg);
export const forbidden = (msg = "You are not allowed to do this") => new HttpError(403, msg);
// 404 (not 403) for records the user may not see, so outsiders cannot even
// learn that a batch exists.
export const notFound = (msg = "Not found") => new HttpError(404, msg);
export const conflict = (msg: string) => new HttpError(409, msg);

/** Read a route parameter (e.g. ":id") as a plain string. */
export function param(req: Request, name: string): string {
  const value = req.params[name];
  if (typeof value !== "string" || value === "") throw notFound();
  return value;
}

export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction) {
  if (err instanceof HttpError) {
    res.status(err.status).json({ error: err.message, details: err.details });
    return;
  }
  if (err instanceof ZodError) {
    res.status(400).json({ error: "Invalid input", details: err.issues });
    return;
  }
  if (typeof err === "object" && err !== null && (err as { name?: string }).name === "MulterError") {
    res.status(400).json({ error: (err as Error).message });
    return;
  }
  log.error("unhandled error", { requestId: req.requestId, error: err instanceof Error ? err.stack : String(err) });
  res.status(500).json({ error: "Something went wrong", requestId: req.requestId }); // never leak internals
}
