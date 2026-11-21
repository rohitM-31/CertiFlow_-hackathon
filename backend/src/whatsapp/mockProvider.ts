/**
 * Stand-in WhatsApp provider (there is no real WhatsApp account for this project).
 * Mounted by the API at /mock-whatsapp in non-production environments, and called by
 * the worker over real HTTP, exactly like a real provider would be.
 *
 * It misbehaves like a real one:
 *  - "fail":    returns 503 before accepting the message (provider outage).
 *  - "timeout": ACCEPTS the message but answers too slowly, so the caller times out
 *               without knowing it was delivered. This is the case that causes duplicate
 *               messages in naive systems.
 *  - Idempotency-Key header: a repeated request with the same key returns the original
 *    message and does NOT deliver again (as real messaging APIs do).
 *
 * Messages are kept in memory, and /mock-whatsapp/inbox shows them: that is "the
 * candidate's phone" for the demo.
 */
import { randomUUID } from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import { config } from "../config.js";

export interface MockMessage {
  id: string;
  to: string;
  text: string;
  idempotencyKey: string;
  receivedAt: string;
}

type Behaviour = "ok" | "fail" | "timeout";

const messages: MockMessage[] = [];
const byKey = new Map<string, MockMessage>();
const forced: Behaviour[] = [];

/** Test/demo controls. */
export const mockWhatsapp = {
  /** Force the next responses, e.g. forceNext("timeout", "ok"). */
  forceNext: (...behaviours: Behaviour[]) => void forced.push(...behaviours),
  inbox: (to?: string) => (to ? messages.filter((m) => m.to === to) : [...messages]),
  reset: () => {
    messages.length = 0;
    byKey.clear();
    forced.length = 0;
  },
};

function nextBehaviour(): Behaviour {
  const next = forced.shift();
  if (next) return next;
  const r = Math.random();
  if (r < config.mockWhatsappFailureRate) return "fail";
  if (r < config.mockWhatsappFailureRate + config.mockWhatsappTimeoutRate) return "timeout";
  return "ok";
}

const sendSchema = z.object({
  to: z.string().regex(/^\+91[6-9]\d{9}$/),
  text: z.string().min(1).max(4096),
});

export const mockWhatsappRouter = Router();

mockWhatsappRouter.post("/messages", (req, res) => {
  const key = req.header("Idempotency-Key");
  const body = sendSchema.safeParse(req.body);
  if (!key || !body.success) {
    res.status(400).json({ error: "Idempotency-Key header, a +91 mobile number and text are required" });
    return;
  }

  const behaviour = nextBehaviour();
  if (behaviour === "fail") {
    res.status(503).json({ error: "Service temporarily unavailable" });
    return;
  }

  let message = byKey.get(key);
  if (!message) {
    message = { id: `wamid.${randomUUID()}`, to: body.data.to, text: body.data.text, idempotencyKey: key, receivedAt: new Date().toISOString() };
    byKey.set(key, message);
    messages.push(message); // delivered to the phone
  }
  const reply = { messageId: message.id, status: "accepted" };

  if (behaviour === "timeout") {
    // Delivered, but the answer comes after the caller has given up.
    const hangMs = Math.max(config.whatsappTimeoutMs * 3, 2_000);
    setTimeout(() => {
      if (!res.writableEnded) res.json(reply);
    }, hangMs).unref();
    return;
  }
  res.json(reply);
});

/** "The candidate's phone": messages received, optionally for one number. Demo only. */
mockWhatsappRouter.get("/inbox", (req, res) => {
  const to = typeof req.query["to"] === "string" ? req.query["to"] : undefined;
  res.json(mockWhatsapp.inbox(to).slice().reverse());
});
