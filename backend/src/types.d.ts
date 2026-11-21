import type { AuthUser } from "./auth/middleware.js";

declare global {
  namespace Express {
    interface Request {
      requestId: string;
      user?: AuthUser;
    }
  }
}

export {};
