import { prisma } from "./db.js";
import { log } from "./logger.js";

/**
 * Live-update events over Postgres NOTIFY / LISTEN.
 *
 * Any process (API instance or worker) publishes with pg_notify(); every API instance
 * LISTENs and forwards the event to its connected browsers (realtime.ts), so several
 * API instances can run side by side.
 *
 * These are NOTIFICATIONS only ("batch 7 changed, refetch"). They carry IDs and
 * statuses, never personal data, and losing one is harmless: the browser refetches
 * through the normal permission-checked API. Work that must not be lost goes through
 * the job queue (queue.ts).
 */
export const EVENTS_CHANNEL = "certiflow_events";

export interface AppEvent {
  type: "batch.updated" | "batch.escalated" | "certificate.updated";
  rooms: string[];
  payload: Record<string, string | number | boolean | null>;
}

export const room = {
  user: (id: string) => `user:${id}`,
  role: (role: string) => `role:${role}`,
  district: (id: string) => `district:${id}`,
  centre: (id: string) => `centre:${id}`,
};

/** Everyone allowed to see a batch: its centre, its district officers, quality and state. */
export function batchAudience(batch: { centreId: string; districtId: string }): string[] {
  return [room.centre(batch.centreId), room.district(batch.districtId), room.role("QUALITY"), room.role("STATE")];
}

export async function publish(event: AppEvent): Promise<void> {
  try {
    await prisma.$executeRaw`SELECT pg_notify(${EVENTS_CHANNEL}, ${JSON.stringify(event)})`;
  } catch (err) {
    // Fail open: a missed live update must never fail the user's action.
    log.warn("event publish failed", { type: event.type, error: (err as Error).message });
  }
}
