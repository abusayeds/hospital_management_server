import mongoose, { HydratedDocument, Schema, Types } from "mongoose";
import { basePlugin, IBaseFields, IBaseMethods } from "../../../models/plugins/basePlugin";
import { DATE_PATTERN } from "../../../utils/date";

/**
 * LAB ORDER — the tests ordered for one patient at one visit, through their life cycle:
 *
 *   ordered → sample_collected → processing → awaiting_verification → ready → delivered
 *                                     ↑______ rejected (with reason) ______|
 *   (cancelled is possible until the report is verified)
 *
 * FOUR-EYES: the person who verifies the results must not be the one who entered them
 * (HospitalSettings.labFourEyes, on by default). Verified results never change.
 */
export const LAB_STATUSES = [
  "ordered",
  "sample_collected",
  "processing",
  "awaiting_verification",
  "ready",
  "delivered",
  "cancelled",
] as const;
export type LabStatus = (typeof LAB_STATUSES)[number];

export const LAB_FLAGS = ["normal", "low", "high", "abnormal", "critical"] as const;

export type LabResult = {
  name: string;
  unit?: string;
  normalMin?: number | null;
  normalMax?: number | null;
  normalText?: string;
  value: string;
  flag: (typeof LAB_FLAGS)[number] | null;
};

export type LabOrderTest = {
  labTest: Types.ObjectId;
  name: string; // snapshots from the catalogue at ordering time
  code: string;
  sampleType: string;
  price: number; // poisha
  results: LabResult[];
  comment?: string;
};

export type LabHistory = { status: LabStatus; at: Date; by?: Types.ObjectId | null; note?: string };

export interface ILabOrder extends IBaseFields {
  orderNo: string; // LAB-000123 — also the report number printed with the QR
  patient: Types.ObjectId;
  visit?: Types.ObjectId | null;
  doctor?: Types.ObjectId | null;
  date: string; // YYYY-MM-DD (Dhaka) ordered
  priority: "routine" | "urgent";
  status: LabStatus;
  tests: LabOrderTest[];
  clinicalNote?: string; // from the doctor (e.g. the provisional diagnosis)
  orderedBy: Types.ObjectId;
  sampleCollectedAt?: Date | null;
  sampleCollectedBy?: Types.ObjectId | null;
  resultsEnteredBy?: Types.ObjectId | null;
  resultsEnteredAt?: Date | null;
  verifiedBy?: Types.ObjectId | null;
  verifiedAt?: Date | null;
  deliveredBy?: Types.ObjectId | null;
  deliveredAt?: Date | null;
  cancelReason?: string | null;
  worstFlag?: (typeof LAB_FLAGS)[number] | null;
  history: LabHistory[];
}

export type LabOrderDocument = HydratedDocument<ILabOrder, IBaseMethods>;

const ResultSchema = new Schema<LabResult>(
  {
    name: { type: String, required: true },
    unit: String,
    normalMin: { type: Number, default: null },
    normalMax: { type: Number, default: null },
    normalText: String,
    value: { type: String, default: "", maxlength: 200 },
    flag: { type: String, enum: [...LAB_FLAGS, null], default: null },
  },
  { _id: false },
);

const LabOrderSchema = new Schema<ILabOrder>({
  orderNo: { type: String, required: true, unique: true },
  patient: { type: Schema.Types.ObjectId, ref: "Patient", required: true },
  visit: { type: Schema.Types.ObjectId, ref: "Visit", default: null },
  doctor: { type: Schema.Types.ObjectId, ref: "Doctor", default: null },
  date: { type: String, required: true, match: DATE_PATTERN },
  priority: { type: String, enum: ["routine", "urgent"], default: "routine" },
  status: { type: String, enum: LAB_STATUSES, default: "ordered" },
  tests: {
    type: [
      new Schema<LabOrderTest>(
        {
          labTest: { type: Schema.Types.ObjectId, ref: "LabTest", required: true },
          name: { type: String, required: true },
          code: { type: String, required: true },
          sampleType: String,
          price: { type: Number, default: 0 },
          results: { type: [ResultSchema], default: [] },
          comment: { type: String, maxlength: 500, default: "" },
        },
        { _id: false },
      ),
    ],
    validate: [(v: unknown[]) => v.length > 0, "At least one test is required"],
  },
  clinicalNote: { type: String, maxlength: 500, default: "" },
  orderedBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
  sampleCollectedAt: { type: Date, default: null },
  sampleCollectedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
  resultsEnteredBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
  resultsEnteredAt: { type: Date, default: null },
  verifiedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
  verifiedAt: { type: Date, default: null },
  deliveredBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
  deliveredAt: { type: Date, default: null },
  cancelReason: { type: String, default: null },
  worstFlag: { type: String, enum: [...LAB_FLAGS, null], default: null },
  history: {
    type: [
      new Schema<LabHistory>(
        {
          status: { type: String, enum: LAB_STATUSES, required: true },
          at: { type: Date, required: true },
          by: { type: Schema.Types.ObjectId, ref: "User", default: null },
          note: { type: String, maxlength: 300 },
        },
        { _id: false },
      ),
    ],
    default: [],
  },
});

// The lab board (by status), a patient's reports, a doctor's orders
LabOrderSchema.index({ status: 1, priority: 1, createdAt: 1 });
LabOrderSchema.index({ patient: 1, createdAt: -1 });
LabOrderSchema.index({ doctor: 1, createdAt: -1 });
LabOrderSchema.index({ visit: 1 });
LabOrderSchema.plugin(basePlugin);

export const LabOrderModel =
  mongoose.models.LabOrder ||
  mongoose.model<ILabOrder, mongoose.Model<ILabOrder, object, IBaseMethods>>("LabOrder", LabOrderSchema);
