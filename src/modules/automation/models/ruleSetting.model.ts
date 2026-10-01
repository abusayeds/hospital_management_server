import mongoose, { Schema, Types } from "mongoose";

/**
 * Admin overrides for one rule. Rules themselves (planner, preconditions, wording keys) live in code;
 * this document only stores what the admin changed: on/off, timings, quiet-hours override, channel
 * order, template choice. A rule without a document runs with its code defaults.
 */
export interface IAutomationRuleSetting {
  key: string;
  enabled: boolean;
  config: Record<string, unknown>;
  updatedBy?: Types.ObjectId | null;
  updatedAt?: Date;
}

const RuleSettingSchema = new Schema<IAutomationRuleSetting>(
  {
    key: { type: String, required: true, unique: true },
    enabled: { type: Boolean, required: true },
    config: { type: Schema.Types.Mixed, default: {} },
    updatedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
  },
  { timestamps: true },
);

export const AutomationRuleSettingModel =
  mongoose.models.AutomationRuleSetting ||
  mongoose.model<IAutomationRuleSetting>("AutomationRuleSetting", RuleSettingSchema);
