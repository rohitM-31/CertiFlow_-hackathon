import { randomBytes, randomInt, timingSafeEqual } from "node:crypto";

// No 0/O or 1/I, so a number read aloud or typed from paper is unambiguous.
const ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";

/**
 * Certificate numbers are RANDOM (32^10 ≈ 10^15 possibilities), not sequential: nobody
 * can guess valid numbers or walk through them to harvest data. Uniqueness is guaranteed
 * by the database's unique constraint, not by luck.
 */
export function newCertificateNumber(): string {
  let s = "";
  for (let i = 0; i < 10; i++) s += ALPHABET[randomInt(ALPHABET.length)];
  return `PSM-${s}`;
}

export const CERTIFICATE_NUMBER_RE = /^PSM-[A-Z0-9]{10}$/;

/** Secret for the candidate's private download link (256 bits). */
export function newDownloadToken(): string {
  return randomBytes(32).toString("base64url");
}

/** Compare secrets in constant time so response timing can't leak how much matched. */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/** "Rahul Kumar Sharma" -> "Rahul K. S.": enough to match the paper, not enough to dox. */
export function maskName(fullName: string): string {
  const [first, ...rest] = fullName.trim().split(/\s+/);
  return [first, ...rest.map((p) => `${p.charAt(0).toUpperCase()}.`)].join(" ");
}

export function downloadUrl(baseUrl: string, number: string, token: string): string {
  return `${baseUrl}/api/certificates/${number}/download?token=${token}`;
}

export function verifyUrl(baseUrl: string, number: string): string {
  return `${baseUrl}/verify/${number}`;
}
