import mongoose, { Schema } from "mongoose";
import { basePlugin, IBaseFields } from "../../../models/plugins/basePlugin";

// All prices are integers in POISHA (see utils/money.ts).

// ------------------------------------------------------------------ Service
export const SERVICE_CATEGORIES = ["consultation", "procedure", "other"] as const;

export interface IService extends IBaseFields {
  name: string;
  nameBn?: string;
  category: (typeof SERVICE_CATEGORIES)[number];
  price: number;
  isActive: boolean;
}

const ServiceSchema = new Schema<IService>({
  name: { type: String, required: true, trim: true, maxlength: 120 },
  nameBn: { type: String, trim: true, maxlength: 120 },
  category: { type: String, enum: SERVICE_CATEGORIES, required: true, index: true },
  price: { type: Number, required: true, min: 0 },
  isActive: { type: Boolean, default: true, index: true },
});
ServiceSchema.index({ name: 1 });
ServiceSchema.plugin(basePlugin);

export const ServiceModel = mongoose.models.Service || mongoose.model<IService>("Service", ServiceSchema);

// ------------------------------------------------------------------ Lab test (catalog only; orders come in Phase 4)
export interface ILabParameter {
  name: string;
  unit?: string;
  normalMin?: number | null;
  normalMax?: number | null;
  normalText?: string; // for non-numeric results, e.g. "Negative", "Nil"
}

export interface ILabTest extends IBaseFields {
  name: string;
  code: string;
  category: string;
  price: number;
  sampleType: string;
  preparationNote?: string;
  preparationNoteBn?: string;
  turnaroundHours: number;
  parameters: ILabParameter[];
  isActive: boolean;
}

const LabParameterSchema = new Schema<ILabParameter>(
  {
    name: { type: String, required: true, trim: true },
    unit: { type: String, trim: true },
    normalMin: { type: Number, default: null },
    normalMax: { type: Number, default: null },
    normalText: { type: String, trim: true },
  },
  { _id: false },
);

const LabTestSchema = new Schema<ILabTest>({
  name: { type: String, required: true, trim: true, maxlength: 150 },
  code: { type: String, required: true, trim: true, uppercase: true, unique: true, maxlength: 20 },
  category: { type: String, required: true, trim: true, index: true },
  price: { type: Number, required: true, min: 0 },
  sampleType: { type: String, required: true, trim: true },
  preparationNote: { type: String, trim: true, maxlength: 300 },
  preparationNoteBn: { type: String, trim: true, maxlength: 300 },
  turnaroundHours: { type: Number, required: true, min: 0 },
  parameters: { type: [LabParameterSchema], default: [] },
  isActive: { type: Boolean, default: true, index: true },
});
LabTestSchema.index({ name: 1 });
LabTestSchema.plugin(basePlugin);

export const LabTestModel = mongoose.models.LabTest || mongoose.model<ILabTest>("LabTest", LabTestSchema);

// ------------------------------------------------------------------ Medicine (catalog only)
export const MEDICINE_FORMS = ["tablet", "capsule", "syrup", "suspension", "injection", "drops", "cream", "ointment", "inhaler", "suppository", "powder", "gel", "other"] as const;

export interface IMedicine extends IBaseFields {
  genericName: string;
  brandName: string;
  strength?: string;
  form: (typeof MEDICINE_FORMS)[number];
  manufacturer?: string;
  isActive: boolean;
}

const MedicineSchema = new Schema<IMedicine>({
  genericName: { type: String, required: true, trim: true, maxlength: 150 },
  brandName: { type: String, required: true, trim: true, maxlength: 150 },
  strength: { type: String, trim: true, maxlength: 60 },
  form: { type: String, enum: MEDICINE_FORMS, required: true },
  manufacturer: { type: String, trim: true, maxlength: 120 },
  isActive: { type: Boolean, default: true, index: true },
});
// Text index: whole-word search across brand and generic names (prescription autocomplete, Phase 4)
MedicineSchema.index({ brandName: "text", genericName: "text" }, { weights: { brandName: 3, genericName: 2 } });
// Prefix search ("Napa" → "Napa Extra") uses these
MedicineSchema.index({ brandName: 1 });
MedicineSchema.index({ genericName: 1 });
MedicineSchema.plugin(basePlugin);

export const MedicineModel = mongoose.models.Medicine || mongoose.model<IMedicine>("Medicine", MedicineSchema);
