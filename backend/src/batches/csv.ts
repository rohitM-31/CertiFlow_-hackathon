/**
 * Parse and validate the candidates CSV.
 *
 * Pure function: no database. Checks EVERY row and returns ALL problems at once so the
 * centre can fix the file in one go. The caller saves nothing unless there are zero
 * errors (all-or-nothing).
 */
import { read, utils } from "xlsx";
import { z } from "zod";

export const REQUIRED_COLUMNS = ["enrollment_no", "full_name", "phone", "date_of_birth"] as const;

export interface CandidateRow {
  enrollmentNo: string;
  fullName: string;
  phone: string;
  dateOfBirth: string; // YYYY-MM-DD
}

export interface RowError {
  row: number; // row number as the user sees it in the file (header is row 1)
  field: string;
  message: string;
}

export interface ParseResult {
  rows: CandidateRow[];
  errors: RowError[];
}

/** Strip spaces/dashes and an optional +91 / 91 / 0 prefix. */
export function normalizePhone(raw: string): string {
  let digits = raw.replace(/[\s\-()]/g, "");
  if (digits.startsWith("+91")) digits = digits.slice(3);
  else if (digits.length === 12 && digits.startsWith("91")) digits = digits.slice(2);
  else if (digits.length === 11 && digits.startsWith("0")) digits = digits.slice(1);
  return digits;
}

function ageOn(dob: Date, today: Date): number {
  const age = today.getUTCFullYear() - dob.getUTCFullYear();
  const beforeBirthday =
    today.getUTCMonth() < dob.getUTCMonth() ||
    (today.getUTCMonth() === dob.getUTCMonth() && today.getUTCDate() < dob.getUTCDate());
  return beforeBirthday ? age - 1 : age;
}

const rowSchema = z.object({
  enrollmentNo: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z0-9-]{4,20}$/, "must be 4-20 letters, digits or dashes"),
  // Must start with a letter: also blocks spreadsheet formula injection (=, +, -, @).
  fullName: z
    .string()
    .trim()
    .min(2, "is too short")
    .max(100, "is too long")
    .regex(/^\p{L}[\p{L} .'-]*$/u, "may only contain letters, spaces and . ' -"),
  phone: z
    .string()
    .transform(normalizePhone)
    .pipe(z.string().regex(/^[6-9]\d{9}$/, "must be a 10-digit Indian mobile number")),
  dateOfBirth: z
    .string()
    .trim()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "must be a date in YYYY-MM-DD format")
    .refine((s) => {
      const d = new Date(`${s}T00:00:00Z`);
      return !Number.isNaN(d.getTime()) && d.toISOString().startsWith(s); // rejects 2001-02-30
    }, "is not a real date")
    .refine((s) => {
      const age = ageOn(new Date(`${s}T00:00:00Z`), new Date());
      return age >= 14 && age <= 70;
    }, "gives an age outside 14-70"),
});

const FIELD_TO_COLUMN: Record<keyof CandidateRow, string> = {
  enrollmentNo: "enrollment_no",
  fullName: "full_name",
  phone: "phone",
  dateOfBirth: "date_of_birth",
};

/** "Full Name " -> "full_name" */
function normalizeHeader(h: string): string {
  return h.trim().toLowerCase().replace(/[\s-]+/g, "_");
}

const fileError = (row: number, message: string): ParseResult => ({ rows: [], errors: [{ row, field: "file", message }] });

export function parseCandidatesCsv(buffer: Buffer, maxRows: number): ParseResult {
  let workbook;
  try {
    // raw: true keeps every cell as text, so "0987..." or "2001-05-04" are never
    // silently converted into numbers or dates.
    workbook = read(buffer, { type: "buffer", raw: true, dense: true });
  } catch {
    return fileError(0, "Could not read the file. Upload a .csv file.");
  }
  const sheetName = workbook.SheetNames[0];
  const sheet = sheetName ? workbook.Sheets[sheetName] : undefined;
  if (!sheet) return fileError(1, "The file is empty");

  const matrix = utils.sheet_to_json<unknown[]>(sheet, { header: 1, raw: true, defval: "", blankrows: false });
  const [headerRow, ...dataRows] = matrix;
  if (!headerRow) return fileError(1, "The file is empty");

  const headers = headerRow.map((h) => normalizeHeader(String(h ?? "")));
  const missing = REQUIRED_COLUMNS.filter((c) => !headers.includes(c));
  if (missing.length > 0) {
    return { rows: [], errors: missing.map((c) => ({ row: 1, field: c, message: `Missing column "${c}"` })) };
  }
  if (dataRows.length === 0) return fileError(2, "The file has no candidates");
  if (dataRows.length > maxRows) return fileError(0, `Too many rows: at most ${maxRows} candidates per batch`);

  const col = (name: string) => headers.indexOf(name);
  const text = (cells: unknown[], name: string) => String(cells[col(name)] ?? "").trim();
  const rows: CandidateRow[] = [];
  const errors: RowError[] = [];
  const firstSeenAt = new Map<string, number>(); // enrollmentNo -> row number

  dataRows.forEach((cells, i) => {
    const rowNumber = i + 2;
    const raw = {
      enrollmentNo: text(cells, "enrollment_no"),
      fullName: text(cells, "full_name"),
      phone: text(cells, "phone"),
      dateOfBirth: text(cells, "date_of_birth"),
    };
    const result = rowSchema.safeParse(raw);
    if (!result.success) {
      const reported = new Set<string>(); // one message per field per row
      for (const issue of result.error.issues) {
        const field = issue.path[0] as keyof CandidateRow;
        if (reported.has(field)) continue;
        reported.add(field);
        const column = FIELD_TO_COLUMN[field] ?? String(field);
        const message = raw[field] === "" ? "is required" : issue.message;
        errors.push({ row: rowNumber, field: column, message: `${column} ${message}` });
      }
      return;
    }
    const earlier = firstSeenAt.get(result.data.enrollmentNo);
    if (earlier !== undefined) {
      errors.push({ row: rowNumber, field: "enrollment_no", message: `enrollment_no ${result.data.enrollmentNo} is also on row ${earlier}` });
      return;
    }
    firstSeenAt.set(result.data.enrollmentNo, rowNumber);
    rows.push(result.data);
  });

  return { rows, errors };
}
