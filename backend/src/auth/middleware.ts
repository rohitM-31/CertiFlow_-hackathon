import type { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";
import { config } from "../config.js";
import { prisma } from "../db.js";
import { forbidden, unauthorized } from "../errors.js";
import type { Role } from "../generated/prisma/enums.js";

/** The logged-in user as every route sees them. Loaded fresh from the DB on each request. */
export interface AuthUser {
  id: string;
  username: string;
  name: string;
  role: Role;
  districtId: string | null; // officers: their district; centre users: their centre's district
  centreId: string | null;
}

export function signToken(userId: string): string {
  return jwt.sign({}, config.jwtSecret, { subject: userId, expiresIn: "8h", algorithm: "HS256" });
}

/**
 * Turn a JWT into a user. The token carries ONLY the user id; role, district and centre
 * always come from the database, so a tampered or stale token can never grant a role the
 * user doesn't have. The algorithm is pinned to HS256 to block "alg: none" attacks.
 */
export async function userFromToken(token: string): Promise<AuthUser | null> {
  let userId: string | undefined;
  try {
    const payload = jwt.verify(token, config.jwtSecret, { algorithms: ["HS256"] });
    userId = typeof payload === "object" ? payload.sub : undefined;
  } catch {
    return null;
  }
  if (!userId) return null;

  const user = await prisma.user.findUnique({ where: { id: userId }, include: { centre: true } });
  if (!user) return null;
  return {
    id: user.id,
    username: user.username,
    name: user.name,
    role: user.role,
    districtId: user.centre ? user.centre.districtId : user.districtId,
    centreId: user.centreId,
  };
}

export async function authenticate(req: Request, _res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) throw unauthorized();
  const user = await userFromToken(header.slice("Bearer ".length));
  if (!user) throw unauthorized("Session expired or invalid, please log in again");
  req.user = user;
  next();
}

export function requireRole(...roles: Role[]) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.user) throw unauthorized();
    if (!roles.includes(req.user.role)) throw forbidden();
    next();
  };
}

export function currentUser(req: Request): AuthUser {
  if (!req.user) throw unauthorized();
  return req.user;
}
