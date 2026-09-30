import mongoose, { Schema } from "mongoose";
import { basePlugin, IBaseFields } from "../../../models/plugins/basePlugin";

export interface IDepartment extends IBaseFields {
  name: string;
  nameBn: string;
  description?: string;
  icon: string; // lucide icon key used by the UI, e.g. "heart-pulse"
  isActive: boolean;
  displayOrder: number;
}

const DepartmentSchema = new Schema<IDepartment>({
  name: { type: String, required: true, unique: true, trim: true, maxlength: 80 },
  nameBn: { type: String, required: true, trim: true, maxlength: 80 },
  description: { type: String, trim: true, maxlength: 300 },
  icon: { type: String, default: "stethoscope", trim: true, maxlength: 40 },
  isActive: { type: Boolean, default: true, index: true },
  displayOrder: { type: Number, default: 100 },
});
DepartmentSchema.index({ displayOrder: 1, name: 1 });

// timestamps, audit fields and soft delete (see models/plugins/basePlugin.ts)
DepartmentSchema.plugin(basePlugin);

export const DepartmentModel = mongoose.models.Department || mongoose.model<IDepartment>("Department", DepartmentSchema);
