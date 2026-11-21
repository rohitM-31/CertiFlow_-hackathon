import { randomUUID } from "node:crypto";
import request from "supertest";
import { createApp } from "../src/app.js";
import { prisma } from "../src/db.js";
import { signToken } from "../src/auth/middleware.js";

export const app = createApp();

/**
 * Each test file builds its own isolated "world" (districts, centre, people) with a
 * random suffix, so tests never depend on seed data or on each other.
 */
export async function createWorld() {
  const id = randomUUID().slice(0, 8);
  const district = await prisma.district.create({ data: { name: `District-${id}` } });
  const otherDistrict = await prisma.district.create({ data: { name: `Other-${id}` } });
  const centre = await prisma.centre.create({ data: { code: `C-${id}`, name: `Centre ${id}`, districtId: district.id } });

  const mk = (name: string, role: "CENTRE" | "DISTRICT_OFFICER" | "QUALITY" | "STATE", extra = {}) =>
    prisma.user.create({ data: { username: `${name}-${id}`, name, role, passwordHash: "x", ...extra } });

  const people = {
    centre: await mk("centre", "CENTRE", { centreId: centre.id }),
    officer1: await mk("officer1", "DISTRICT_OFFICER", { districtId: district.id }),
    officer2: await mk("officer2", "DISTRICT_OFFICER", { districtId: district.id }),
    officer3: await mk("officer3", "DISTRICT_OFFICER", { districtId: district.id }),
    outsider: await mk("outsider", "DISTRICT_OFFICER", { districtId: otherDistrict.id }),
    quality: await mk("quality", "QUALITY"),
    state: await mk("state", "STATE"),
  };
  const tokens = Object.fromEntries(Object.entries(people).map(([k, u]) => [k, signToken(u.id)])) as Record<keyof typeof people, string>;
  return { id, district, centre, people, tokens };
}

export type World = Awaited<ReturnType<typeof createWorld>>;

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

export function api(token: string) {
  return {
    get: (url: string) => request(app).get(url).set(auth(token)),
    post: (url: string, body: object = {}) => request(app).post(url).set(auth(token)).send(body),
    /** Upload a CSV as a new batch. */
    uploadBatch: (csv: string, courseName = "Solar PV Installer", filename = "batch.csv") =>
      request(app).post("/api/batches").set(auth(token)).field("courseName", courseName).attach("file", Buffer.from(csv), filename),
    resubmit: (batchId: string, csv: string, filename = "fixed.csv") =>
      request(app).post(`/api/batches/${batchId}/resubmit`).set(auth(token)).attach("file", Buffer.from(csv), filename),
  };
}

let phoneCounter = Math.floor(Math.random() * 1_000_000);

/** A valid CSV with `count` candidates, unique enrolment numbers and phone numbers. */
export function candidatesCsv(count: number, prefix = randomUUID().slice(0, 6).toUpperCase()): string {
  const lines = ["enrollment_no,full_name,phone,date_of_birth"];
  for (let i = 1; i <= count; i++) {
    phoneCounter++;
    const letter = String.fromCharCode(65 + (i % 26));
    lines.push(`${prefix}-${String(i).padStart(4, "0")},Candidate ${letter}${letter.toLowerCase()}ani,9${String(phoneCounter).padStart(9, "0")},2000-01-${String((i % 27) + 1).padStart(2, "0")}`);
  }
  return lines.join("\n");
}

/** Upload a valid CSV as the centre. The batch is created and already in district review. */
export async function uploadedBatch(world: World, count = 5): Promise<string> {
  const res = await api(world.tokens.centre).uploadBatch(candidatesCsv(count));
  if (res.status !== 201) throw new Error(`upload failed: ${JSON.stringify(res.body)}`);
  return res.body.id as string;
}

export const approve = (token: string, batchId: string) => api(token).post(`/api/batches/${batchId}/decisions`, { type: "APPROVE" });

/** Take a small batch through every approval to APPROVED. */
export async function approvedBatch(world: World, count = 2): Promise<string> {
  const batchId = await uploadedBatch(world, count);
  for (const who of ["officer1", "officer2", "state"] as const) {
    const res = await approve(world.tokens[who], batchId);
    if (res.status !== 200) throw new Error(`${who} approval failed: ${JSON.stringify(res.body)}`);
  }
  return batchId;
}
