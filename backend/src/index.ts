import { createServer } from "node:http";
import { config } from "./config.js";
import { createApp } from "./app.js";
import { attachRealtime } from "./realtime.js";
import { prisma } from "./db.js";
import { log } from "./logger.js";

const server = createServer(createApp());
const closeRealtime = attachRealtime(server);

server.listen(config.port, () => {
  log.info("api listening", { port: config.port });
});

// Graceful shutdown. An instance can also be killed at any moment: nothing important
// lives in its memory (state is in Postgres, sessions are JWTs).
async function shutdown(signal: string) {
  log.info("api shutting down", { signal });
  server.close();
  await closeRealtime();
  await prisma.$disconnect();
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
