import mongoose, { HydratedDocument, Schema, Types } from "mongoose";
import { basePlugin, IBaseFields, IBaseMethods } from "../../../models/plugins/basePlugin";
import { MEAL_TIMINGS, MealTiming } from "../../../shared/clinical-rules";
import { DATE_PATTERN } from "../../../utils/date";

/**
 * VISIT — the medical record of one consultation (one per appointment).
 *
 * Life cycle: open (the doctor is writing) → closed (signed). A closed visit is READ-ONLY.
 * Corrections after closing are ADDENDA: who, when, what and why — the original text is
 * never changed. Visits are never hard-deleted (basePlugin soft delete is not exposed).
 */
export const VISIT_STATUSES = ["open", "closed"] as const;
export type VisitStatus = (typeof VISIT_STATUSES)[number];

export const MEDICINE_ROUTES = ["oral", "topical", "inhalation", "injection", "eye", "ear", "nasal", "rectal", "other"];

export type PrescriptionItem = {
  medicine?: Types.ObjectId | null; // catalogue entry (null = typed free text)
  brandName: string; // snapshots: the record must read the same even if the catalogue changes
  genericName?: string;
  strength?: string;
  form?: string;
  dosePattern: string; // "1+0+1"
  timing?: MealTiming | null;
  durationDays?: number | null; // null + continued = "continue"
  continued?: boolean;
  route?: string;
  instructionsEn?: string;
  instructionsBn?: string;
  note?: string;
};

export type Investigation = { labTest?: Types.ObjectId | null; name: string; note?: string };

export type Addendum = { text: string; reason: string; by: Types.ObjectId; byName: string; at: Date };

export type AllergyOverride = { medicine: string; allergy: string; reason: string; by: Types.ObjectId; at: Date };

export interface IVisit extends IBaseFields {
  appointment: Types.ObjectId;
  patient: Types.ObjectId;
  doctor: Types.ObjectId;
  date: string; // YYYY-MM-DD (Dhaka)
  status: VisitStatus;
  chiefComplaints: string[];
  historyOfPresentIllness?: string;
  pastHistory?: string;
  examination?: string;
  provisionalDiagnosis?: string;
  finalDiagnosis?: string;
  investigations: Investigation[];
  prescription: PrescriptionItem[];
  adviceEn?: string;
  adviceBn?: string;
  followUp?: { date?: string | null; note?: string } | null;
  referral?: { to?: string; reason?: string } | null;
  vitalsSnapshot?: Record<string, unknown> | null; // copied from the nurse's reading when closed
  allergyOverrides: AllergyOverride[];
  aiSummaryUsed: boolean;
  prescriptionNo?: string | null; // RX-000123, given when the visit is closed (printed + QR)
  openedAt: Date;
  closedAt?: Date | null;
  closedBy?: Types.ObjectId | null;
  addenda: Addendum[];
}

export type VisitDocument = HydratedDocument<IVisit, IBaseMethods>;

const text = (max: number) => ({ type: String, trim: true, maxlength: max, default: "" });

const PrescriptionItemSchema = new Schema<PrescriptionItem>(
  {
    medicine: { type: Schema.Types.ObjectId, ref: "Medicine", default: null },
    brandName: { type: String, required: true, trim: true, maxlength: 150 },
    genericName: text(150),
    strength: text(60),
    form: text(40),
    dosePattern: { type: String, required: true, trim: true, maxlength: 30 },
    timing: { type: String, enum: [...MEAL_TIMINGS, null], default: null },
    durationDays: { type: Number, min: 1, max: 365, default: null },
    continued: { type: Boolean, default: false },
    route: { type: String, enum: MEDICINE_ROUTES, default: "oral" },
    instructionsEn: text(300),
    instructionsBn: text(300),
    note: text(200),
  },
  { _id: false },
);

const VisitSchema = new Schema<IVisit>({
  appointment: { type: Schema.Types.ObjectId, ref: "Appointment", required: true, unique: true },
  patient: { type: Schema.Types.ObjectId, ref: "Patient", required: true },
  doctor: { type: Schema.Types.ObjectId, ref: "Doctor", required: true },
  date: { type: String, required: true, match: DATE_PATTERN },
  status: { type: String, enum: VISIT_STATUSES, default: "open" },
  chiefComplaints: { type: [String], default: [] },
  historyOfPresentIllness: text(6000),
  pastHistory: text(2000),
  examination: text(3000),
  provisionalDiagnosis: text(500),
  finalDiagnosis: text(500),
  investigations: {
    type: [
      new Schema<Investigation>(
        {
          labTest: { type: Schema.Types.ObjectId, ref: "LabTest", default: null },
          name: { type: String, required: true, trim: true, maxlength: 150 },
          note: text(200),
        },
        { _id: false },
      ),
    ],
    default: [],
  },
  prescription: { type: [PrescriptionItemSchema], default: [] },
  adviceEn: text(2000),
  adviceBn: text(2000),
  followUp: {
    type: new Schema({ date: { type: String, match: DATE_PATTERN, default: null }, note: text(200) }, { _id: false }),
    default: null,
  },
  referral: { type: new Schema({ to: text(200), reason: text(300) }, { _id: false }), default: null },
  vitalsSnapshot: { type: Schema.Types.Mixed, default: null },
  allergyOverrides: {
    type: [
      new Schema<AllergyOverride>(
        {
          medicine: String,
          allergy: String,
          reason: { type: String, required: true, maxlength: 300 },
          by: { type: Schema.Types.ObjectId, ref: "User" },
          at: Date,
        },
        { _id: false },
      ),
    ],
    default: [],
  },
  aiSummaryUsed: { type: Boolean, default: false },
  prescriptionNo: { type: String, default: null },
  openedAt: { type: Date, required: true },
  closedAt: { type: Date, default: null },
  closedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
  addenda: {
    type: [
      new Schema<Addendum>(
        {
          text: { type: String, required: true, maxlength: 3000 },
          reason: { type: String, required: true, maxlength: 300 },
          by: { type: Schema.Types.ObjectId, ref: "User", required: true },
          byName: String,
          at: { type: Date, required: true },
        },
        { _id: true },
      ),
    ],
    default: [],
  },
});

// Patient history (newest first) and the doctor's day
VisitSchema.index({ patient: 1, date: -1 });
VisitSchema.index({ doctor: 1, date: -1 });
VisitSchema.index(
  { prescriptionNo: 1 },
  { unique: true, partialFilterExpression: { prescriptionNo: { $type: "string" } } },
);
VisitSchema.plugin(basePlugin);

export const VisitModel =
  mongoose.models.Visit || mongoose.model<IVisit, mongoose.Model<IVisit, object, IBaseMethods>>("Visit", VisitSchema);

// ------------------------------------------------------------------ prescription templates

/** A doctor's saved prescription (e.g. "Adult fever"). Private to the doctor who made it. */
export interface IPrescriptionTemplate extends IBaseFields {
  owner: Types.ObjectId; // User
  name: string;
  diagnosis?: string;
  items: PrescriptionItem[];
  adviceEn?: string;
  adviceBn?: string;
  investigations: Investigation[];
}

const TemplateSchema = new Schema<IPrescriptionTemplate>({
  owner: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
  name: { type: String, required: true, trim: true, maxlength: 80 },
  diagnosis: text(500),
  items: { type: [PrescriptionItemSchema], default: [] },
  adviceEn: text(2000),
  adviceBn: text(2000),
  investigations: {
    type: [
      new Schema<Investigation>(
        {
          labTest: { type: Schema.Types.ObjectId, ref: "LabTest", default: null },
          name: { type: String, required: true, trim: true, maxlength: 150 },
          note: text(200),
        },
        { _id: false },
      ),
    ],
    default: [],
  },
});
TemplateSchema.plugin(basePlugin);

export const PrescriptionTemplateModel =
  mongoose.models.PrescriptionTemplate ||
  mongoose.model<IPrescriptionTemplate, mongoose.Model<IPrescriptionTemplate, object, IBaseMethods>>(
    "PrescriptionTemplate",
    TemplateSchema,
  );
