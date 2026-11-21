import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "./generated/prisma/client.js";
import { config } from "./config.js";

// Prisma 7 talks to Postgres through a driver adapter (node-postgres here).
const adapter = new PrismaPg({ connectionString: config.databaseUrl });

export const prisma = new PrismaClient({ adapter });

/** The transaction client type, so helpers can run inside a caller's transaction. */
export type Tx = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];

/** True if the error is a unique-constraint violation (Prisma code P2002). */
export function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: string }).code === "P2002";
}
