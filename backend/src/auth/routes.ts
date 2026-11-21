import { Router } from "express";
import bcrypt from "bcrypt";
import { z } from "zod";
import { prisma } from "../db.js";
import { unauthorized } from "../errors.js";
import { rateLimit } from "../rateLimit.js";
import { authenticate, currentUser, signToken } from "./middleware.js";

export const authRouter = Router();

const loginSchema = z.object({
  username: z.string().trim().toLowerCase().min(1).max(50),
  password: z.string().min(1).max(200),
});

authRouter.post("/login", rateLimit("login", 20), async (req, res) => {
  const { username, password } = loginSchema.parse(req.body);
  const user = await prisma.user.findUnique({ where: { username } });
  // Same message for unknown user and wrong password: don't reveal which usernames exist.
  if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
    throw unauthorized("Wrong username or password");
  }
  res.json({ token: signToken(user.id) });
});

authRouter.get("/me", authenticate, (req, res) => {
  res.json(currentUser(req));
});

// Demo only: lists the sample personas so reviewers can switch in one click.
authRouter.get("/demo-users", async (_req, res) => {
  const users = await prisma.user.findMany({
    select: { username: true, name: true, role: true },
    orderBy: { createdAt: "asc" },
  });
  res.json(users);
});
