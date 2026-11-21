import type { Server as HttpServer } from "node:http";
import { Server } from "socket.io";
import { config } from "./config.js";
import { userFromToken, type AuthUser } from "./auth/middleware.js";
import { EVENTS_CHANNEL, room, type AppEvent } from "./events.js";
import { listen } from "./pgListen.js";
import { log } from "./logger.js";

/**
 * Live updates to browsers over WebSockets (Socket.IO).
 *
 * Each browser authenticates with its JWT and joins "rooms" matching what it may see
 * (its user, role, district, centre). This API instance LISTENs on the Postgres events
 * channel and forwards each event to the right rooms, so it doesn't matter which
 * instance (or worker) produced it.
 */
export function attachRealtime(httpServer: HttpServer): () => Promise<void> {
  const io = new Server(httpServer, { cors: { origin: config.frontendUrl } });

  io.use(async (socket, next) => {
    const token = typeof socket.handshake.auth["token"] === "string" ? socket.handshake.auth["token"] : "";
    const user = token ? await userFromToken(token) : null;
    if (!user) return next(new Error("unauthorized"));
    socket.data.user = user;
    next();
  });

  io.on("connection", (socket) => {
    const user = socket.data.user as AuthUser;
    void socket.join(room.user(user.id));
    void socket.join(room.role(user.role));
    if (user.role === "DISTRICT_OFFICER" && user.districtId) void socket.join(room.district(user.districtId));
    if (user.role === "CENTRE" && user.centreId) void socket.join(room.centre(user.centreId));
  });

  const stopListening = listen(EVENTS_CHANNEL, (message) => {
    try {
      const event = JSON.parse(message) as AppEvent;
      io.to(event.rooms).emit(event.type, event.payload);
    } catch (err) {
      log.warn("bad event on channel", { error: (err as Error).message });
    }
  });

  return async () => {
    await stopListening();
    await io.close();
  };
}
