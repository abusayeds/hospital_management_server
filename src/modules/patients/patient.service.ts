/* eslint-disable @typescript-eslint/no-explicit-any */
import { Request } from "express";
import { ClientSession, Types } from "mongoose";
import { Permission, roleHasPermission } from "../../config/permissions";
import AppError from "../../errors/AppError";
import { buildPagination } from "../../interface/global.interface";
import { nextCode } from "../../models/counter.model";
import { encryptField, maskTail } from "../../utils/crypto";
import { ageOn, todayInDhaka } from "../../utils/date";
import { escapeRegex } from "../../utils/escapeRegex";
import { normalizeBdPhone, phoneSearchPrefix } from "../../utils/phone";
import { recordAudit } from "../audit/audit.service";
import { IPatient, PatientDocument, PatientModel } from "./patient.model";

// ------------------------------------------------------------------ names & duplicates

/** "Md. Rahim  Uddin" / "Mohammad Rahim Uddin" → "md rahim uddin" */
export const normalizeName = (name: string): string =>
  name
    .toLowerCase()
    .replace(/[^\p{L}\s]/gu, " ")
    .replace(/\b(mohammad|mohammed|muhammad|mohd|md)\b/g, "md")
    .replace(/\s+/g, " ")
    .trim();

const levenshtein = (a: string, b: string): number => {
  const prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const temp = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = temp;
    }
  }
  return prev[b.length];
};

/** Same person? Equal after normalising, a 1–2 letter typo, or one name contains the other */
export const namesLookAlike = (a: string, b: string): boolean => {
  if (a === b) return true;
  if (Math.min(a.length, b.length) >= 5 && (a.includes(b) || b.includes(a))) return true;
  return levenshtein(a, b) <= Math.max(1, Math.floor(Math.max(a.length, b.length) * 0.15));
};

// ------------------------------------------------------------------ date of birth

/** Only an age was given → 1 July of that year (mid-year keeps the estimate within ±6 months) */
export const estimateDob = (ageYears: number, today = todayInDhaka()): Date =>
  new Date(Date.UTC(Number(today.slice(0, 4)) - ageYears, 6, 1));

// ------------------------------------------------------------------ serializers (per permission level)

/**
 * BASIC — front desk, nurses, lab, pharmacy: who the patient is and how to reach them.
 * Allergy names are included as safety flags (they matter at every counter);
 * chronic conditions, notes and anything clinical are NOT — only whether they exist.
 */
export const toPatientBasic = (p: any) => ({
  id: String(p._id),
  patientCode: p.patientCode,
  name: p.name,
  nameBn: p.nameBn,
  gender: p.gender,
  age: ageOn(p.dateOfBirth),
  dateOfBirth: p.dobEstimated ? null : p.dateOfBirth.toISOString().slice(0, 10),
  dobEstimated: p.dobEstimated,
  phone: p.phone,
  altPhone: p.altPhone,
  address: p.address,
  bloodGroup: p.bloodGroup,
  allergies: p.allergies ?? [],
  hasChronicConditions: (p.chronicConditions ?? []).length > 0,
  emergencyContact: p.emergencyContact,
  nidMasked: p.nidLast4 ? maskTail(`0000000000${p.nidLast4}`, 4) : null,
  registrationSource: p.registrationSource,
  lastVisitDate: p.lastVisitDate,
  createdAt: p.createdAt,
});

/** FULL — doctors (patient:read_full): adds the clinical background */
export const toPatientFull = (p: any) => ({
  ...toPatientBasic(p),
  chronicConditions: p.chronicConditions ?? [],
  notes: p.notes,
});

export type PatientView = "basic" | "full";
export const viewFor = (role: Parameters<typeof roleHasPermission>[0]): PatientView =>
  roleHasPermission(role, "patient:read_full" as Permission) ? "full" : "basic";
export const serializePatient = (p: any, view: PatientView) => (view === "full" ? toPatientFull(p) : toPatientBasic(p));

// ------------------------------------------------------------------ search

/**
 * One box, three kinds of input:
 *  - "TL-000123" / "tl123" / "123"  → patient code
 *  - "01711", "8801711222333"       → phone prefix (all family members sharing it)
 *  - anything else                  → name (English or Bangla), case-insensitive
 */
export const searchPatients = async ({ q, page, limit }: { q?: string; page: number; limit: number }) => {
  const filter: Record<string, unknown> = {};
  const text = q?.trim();
  if (text) {
    const or: Record<string, unknown>[] = [];
    const code = text.match(/^(?:tl-?)?0*(\d{1,6})$/i);
    if (code) or.push({ patientCode: `TL-${code[1].padStart(6, "0")}` });
    const phonePrefix = phoneSearchPrefix(text);
    if (phonePrefix) {
      const rx = new RegExp(`^${escapeRegex(phonePrefix)}`);
      or.push({ phone: rx }, { altPhone: rx });
    }
    if (!phonePrefix || /[a-zঀ-৿]/i.test(text)) {
      const rx = new RegExp(escapeRegex(text), "i");
      or.push({ name: rx }, { nameBn: rx });
    }
    filter.$or = or;
  }
  const [items, total] = await Promise.all([
    PatientModel.find(filter)
      .sort(text ? { lastVisitDate: -1, createdAt: -1 } : { createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit),
    PatientModel.countDocuments(filter),
  ]);
  return { items, pagination: buildPagination(page, limit, total) };
};

// ------------------------------------------------------------------ create

export type PatientInput = {
  name: string;
  nameBn?: string;
  gender: IPatient["gender"];
  dateOfBirth?: string; // YYYY-MM-DD
  ageYears?: number; // used when the date of birth is unknown
  phone: string;
  altPhone?: string;
  address?: IPatient["address"];
  bloodGroup?: IPatient["bloodGroup"];
  allergies?: string[];
  chronicConditions?: string[];
  emergencyContact?: { name?: string; phone?: string; relation?: string };
  nid?: string;
  notes?: string;
  registrationSource?: IPatient["registrationSource"];
};

const cleanList = (items?: string[]) => [...new Set((items ?? []).map((s) => s.trim()).filter(Boolean))];

/** Input → database fields (phones normalised, NID encrypted, DOB from age if needed) */
const toFields = (input: Partial<PatientInput>) => {
  const fields: Record<string, unknown> = {};
  if (input.name !== undefined) {
    fields.name = input.name.trim();
    fields.nameKey = normalizeName(input.name);
  }
  if (input.nameBn !== undefined) fields.nameBn = input.nameBn.trim() || undefined;
  if (input.gender !== undefined) fields.gender = input.gender;
  if (input.dateOfBirth) {
    fields.dateOfBirth = new Date(`${input.dateOfBirth}T00:00:00Z`);
    fields.dobEstimated = false;
  } else if (input.ageYears !== undefined) {
    fields.dateOfBirth = estimateDob(input.ageYears);
    fields.dobEstimated = true;
  }
  if (input.phone !== undefined) fields.phone = normalizeBdPhone(input.phone);
  if (input.altPhone !== undefined)
    fields.altPhone = input.altPhone ? normalizeBdPhone(input.altPhone, "altPhone") : undefined;
  if (input.address !== undefined) fields.address = input.address;
  if (input.bloodGroup !== undefined) fields.bloodGroup = input.bloodGroup || undefined;
  if (input.allergies !== undefined) fields.allergies = cleanList(input.allergies);
  if (input.chronicConditions !== undefined) fields.chronicConditions = cleanList(input.chronicConditions);
  if (input.emergencyContact !== undefined) {
    const ec = input.emergencyContact;
    fields.emergencyContact = {
      ...ec,
      phone: ec.phone ? normalizeBdPhone(ec.phone, "emergencyContact.phone") : undefined,
    };
  }
  if (input.nid !== undefined) {
    const nid = input.nid.replace(/\s/g, "");
    fields.nidEncrypted = nid ? encryptField(nid) : null;
    fields.nidLast4 = nid ? nid.slice(-4) : null;
  }
  if (input.notes !== undefined) fields.notes = input.notes.trim() || undefined;
  return fields;
};

/** Patients on the same phone whose name looks like `name` (family members with other names are fine) */
export const findPossibleDuplicates = async (phone: string, name: string, session?: ClientSession) => {
  const key = normalizeName(name);
  const samePhone = await PatientModel.find({ phone })
    .session(session ?? null)
    .limit(20);
  return samePhone.filter((p: any) => namesLookAlike(p.nameKey, key));
};

type Actor = { req?: Request; userId?: string | null };

export const createPatient = async (
  input: PatientInput,
  { req, allowDuplicate = false, session }: Actor & { allowDuplicate?: boolean; session?: ClientSession },
) => {
  if (!input.dateOfBirth && input.ageYears === undefined) {
    throw new AppError(400, "Enter the date of birth or the age.", "VALIDATION_ERROR", [
      { path: "body.ageYears", message: "date of birth or age is required" },
    ]);
  }
  const fields = toFields(input);

  if (!allowDuplicate) {
    const matches = await findPossibleDuplicates(fields.phone as string, input.name, session);
    if (matches.length) {
      throw new AppError(409, "A patient with this phone number and a similar name already exists.", "DUPLICATE_KEY", {
        possibleDuplicates: matches.map(toPatientBasic),
      });
    }
  }

  const patientCode = await nextCode("patient", "TL", session);
  const [doc] = await PatientModel.create(
    [
      {
        ...fields,
        patientCode,
        registrationSource: input.registrationSource ?? "reception",
        registeredBy: req?.user?.id ?? null,
        createdBy: req?.user?.id ?? null,
      },
    ],
    { session },
  );
  await recordAudit({
    req,
    action: "CREATE",
    entityType: "Patient",
    entityId: doc._id,
    after: { patientCode, name: doc.name, source: doc.registrationSource },
    meta: allowDuplicate ? { duplicateWarningOverridden: true } : undefined,
  });
  return doc as PatientDocument;
};

// ------------------------------------------------------------------ read / update

export const findPatientOrThrow = async (id: string, session?: ClientSession) => {
  if (!Types.ObjectId.isValid(id)) throw new AppError(400, "Invalid patient id.", "INVALID_ID");
  const doc = await PatientModel.findById(id).session(session ?? null);
  if (!doc) throw new AppError(404, "Patient not found.");
  return doc as PatientDocument;
};

/** Opening a full profile is recorded (who looked at which patient, when) */
export const getPatientForView = async (req: Request, id: string) => {
  const doc = await findPatientOrThrow(id);
  const view = viewFor(req.user!.role);
  await recordAudit({ req, action: "VIEW", entityType: "Patient", entityId: doc._id, meta: { view } });
  return serializePatient(doc, view);
};

// What the audit log keeps for patient edits: demographic fields only, never NID
const snapshot = (p: any) => ({
  name: p.name,
  nameBn: p.nameBn,
  gender: p.gender,
  dateOfBirth: p.dateOfBirth?.toISOString().slice(0, 10),
  phone: p.phone,
  altPhone: p.altPhone,
  address: p.address,
  bloodGroup: p.bloodGroup,
  allergies: p.allergies,
  chronicConditionsCount: p.chronicConditions?.length ?? 0,
  emergencyContact: p.emergencyContact,
  nidChanged: undefined as boolean | undefined,
});

export const updatePatient = async (req: Request, id: string, input: Partial<PatientInput>) => {
  const doc = await findPatientOrThrow(id);
  const before = snapshot(doc);
  doc.set({ ...toFields(input), updatedBy: req.user!.id });
  await doc.save();
  const after = { ...snapshot(doc), nidChanged: input.nid !== undefined ? true : undefined };
  await recordAudit({ req, action: "UPDATE", entityType: "Patient", entityId: doc._id, before, after });
  return serializePatient(doc, viewFor(req.user!.role));
};

export const patientService = {
  searchPatients,
  createPatient,
  findPatientOrThrow,
  getPatientForView,
  updatePatient,
  findPossibleDuplicates,
  serializePatient,
  viewFor,
};
