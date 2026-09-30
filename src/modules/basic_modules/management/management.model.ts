import mongoose, { Schema } from "mongoose";

import type { TManagement } from "./management.interface";

const managementSchema = new Schema<TManagement>(
  {
    description: { type: String, required: true },
  },
  { timestamps: true },
);

export const PrivacyModel = mongoose.models.Privacy || mongoose.model<TManagement>("Privacy", managementSchema);
export const AboutModel = mongoose.models.About || mongoose.model<TManagement>("About", managementSchema);
export const TermsModel = mongoose.models.Terms || mongoose.model<TManagement>("Terms", managementSchema);
