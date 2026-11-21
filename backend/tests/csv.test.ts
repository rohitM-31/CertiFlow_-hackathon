// CSV validation (pure): a file with bad rows reports EXACTLY what is wrong.
import { describe, expect, it } from "vitest";
import { normalizePhone, parseCandidatesCsv } from "../src/batches/csv.js";

const csv = (text: string) => Buffer.from(text, "utf8");
const HEADER = "enrollment_no,full_name,phone,date_of_birth";

describe("parseCandidatesCsv", () => {
  it("accepts a clean file and normalises values", () => {
    const { rows, errors } = parseCandidatesCsv(
      csv(`${HEADER}\nele-0001,Asha Patil,+91 98765 43210,2000-05-04\nELE-0002,Ravi Kumar,09876543211,1999-12-31`),
      500,
    );
    expect(errors).toEqual([]);
    expect(rows).toEqual([
      { enrollmentNo: "ELE-0001", fullName: "Asha Patil", phone: "9876543210", dateOfBirth: "2000-05-04" },
      { enrollmentNo: "ELE-0002", fullName: "Ravi Kumar", phone: "9876543211", dateOfBirth: "1999-12-31" },
    ]);
  });

  it("reports every bad row with its row number and column", () => {
    const file = csv(
      [
        HEADER,
        "ELE-0001,Asha Patil,9876543210,2000-05-04", // row 2 ok
        "ELE-0002,,12345,2000-02-30", // row 3: name missing, bad phone, impossible date
        "ELE-0001,Duplicate Person,9876543299,2001-01-01", // row 4: duplicate enrolment
        "ELE-0004,=HYPERLINK(evil),9876543298,2001-01-01", // row 5: formula injection
      ].join("\n"),
    );
    const { errors } = parseCandidatesCsv(file, 500);
    expect(errors).toEqual(
      expect.arrayContaining([
        { row: 3, field: "full_name", message: "full_name is required" },
        expect.objectContaining({ row: 3, field: "phone" }),
        expect.objectContaining({ row: 3, field: "date_of_birth" }),
        expect.objectContaining({ row: 4, field: "enrollment_no", message: expect.stringContaining("row 2") }),
        expect.objectContaining({ row: 5, field: "full_name" }),
      ]),
    );
    expect(errors.some((e) => e.row === 2)).toBe(false);
  });

  it("handles quoted fields, and keeps leading zeros and dates as text", () => {
    const { rows, errors } = parseCandidatesCsv(csv(`${HEADER}\n"Q-0001","Maria D'Souza","09876543210","2000-01-01"`), 500);
    expect(errors).toEqual([]);
    expect(rows[0]).toEqual({ enrollmentNo: "Q-0001", fullName: "Maria D'Souza", phone: "9876543210", dateOfBirth: "2000-01-01" });
  });

  it("rejects missing columns", () => {
    const { rows, errors } = parseCandidatesCsv(csv("enrollment_no,full_name\nA-0001,Asha"), 500);
    expect(rows).toEqual([]);
    expect(errors.map((e) => e.field).sort()).toEqual(["date_of_birth", "phone"]);
  });

  it("rejects an empty file and too many rows", () => {
    expect(parseCandidatesCsv(csv(HEADER), 500).errors[0]?.message).toMatch(/no candidates/);
    const lines = Array.from({ length: 6 }, (_, i) => `E-000${i},Name Name,9876543210,2000-01-01`);
    expect(parseCandidatesCsv(csv([HEADER, ...lines].join("\n")), 5).errors[0]?.message).toMatch(/at most 5/);
  });
});

describe("normalizePhone", () => {
  it.each([
    ["+91 98765 43210", "9876543210"],
    ["919876543210", "9876543210"],
    ["09876543210", "9876543210"],
    ["98765-43210", "9876543210"],
  ])("%s -> %s", (input, expected) => {
    expect(normalizePhone(input)).toBe(expected);
  });
});
