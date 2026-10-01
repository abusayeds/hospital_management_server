import mongoose, { HydratedDocument, Schema, Types } from "mongoose";

/**
 * MESSAGE TEMPLATE — the words of every automated message, editable by the admin.
 *  - bodies per language (bn, en) with {{variable}} placeholders; only DECLARED variables are allowed
 *    and every placeholder is checked when the template is saved, never discovered at send time
 *  - buttons: quick replies shown inside WhatsApp's 24-hour window (and in the web chat)
 *  - whatsappTemplateName + whatsappParams: the Meta-approved template used OUTSIDE the 24-hour
 *    window, and which variables fill its {{1}}, {{2}} … parameters, in order
 *  - every save bumps `version` and keeps the previous one in `history` (rollback)
 */

export const TEMPLATE_CATEGORIES = [
  "confirmation",
  "reminder",
  "follow_up",
  "no_show",
  "report",
  "promotion",
  "alert",
  "service",
] as const;
export type TemplateCategory = (typeof TEMPLATE_CATEGORIES)[number];

export const VARIABLE_TYPES = ["string", "date", "time", "number", "money", "url"] as const;
export type TemplateVariable = {
  name: string;
  type: (typeof VARIABLE_TYPES)[number];
  required: boolean;
  sample: string;
};
export type TemplateButton = { action: string; label: { bn: string; en: string } };

export type TemplateContent = {
  bodies: { bn: string; en: string };
  buttons: TemplateButton[];
  whatsappTemplateName?: string | null;
  whatsappLanguages: { bn: string; en: string }; // Meta language codes, e.g. "bn", "en_US"
  whatsappParams: string[]; // variable names, in {{1}}, {{2}} order
};

export interface IMessageTemplate extends TemplateContent {
  key: string;
  description: string;
  category: TemplateCategory;
  channels: ("whatsapp" | "sms" | "inapp")[];
  variables: TemplateVariable[];
  isActive: boolean;
  version: number;
  history: (TemplateContent & { version: number; savedAt: Date; savedBy?: Types.ObjectId | null })[];
  updatedBy?: Types.ObjectId | null;
  createdAt?: Date;
  updatedAt?: Date;
}

export type MessageTemplateDocument = HydratedDocument<IMessageTemplate>;

const ButtonSchema = new Schema<TemplateButton>(
  { action: { type: String, required: true }, label: { bn: String, en: String } },
  { _id: false },
);

const contentFields = {
  bodies: {
    bn: { type: String, required: true, maxlength: 1500 },
    en: { type: String, required: true, maxlength: 1500 },
  },
  buttons: { type: [ButtonSchema], default: [] },
  whatsappTemplateName: { type: String, default: null, maxlength: 512 },
  whatsappLanguages: { bn: { type: String, default: "bn" }, en: { type: String, default: "en" } },
  whatsappParams: { type: [String], default: [] },
};

const TemplateSchema = new Schema<IMessageTemplate>(
  {
    key: { type: String, required: true, unique: true, match: /^[a-z][a-z0-9_]{2,60}$/ },
    description: { type: String, default: "", maxlength: 300 },
    category: { type: String, enum: TEMPLATE_CATEGORIES, required: true },
    channels: { type: [String], default: ["whatsapp", "sms"] },
    variables: {
      type: [
        new Schema<TemplateVariable>(
          {
            name: { type: String, required: true },
            type: { type: String, enum: VARIABLE_TYPES, default: "string" },
            required: { type: Boolean, default: true },
            sample: { type: String, default: "" },
          },
          { _id: false },
        ),
      ],
      default: [],
    },
    ...contentFields,
    isActive: { type: Boolean, default: true },
    version: { type: Number, default: 1 },
    history: {
      type: [
        new Schema(
          {
            ...contentFields,
            version: Number,
            savedAt: Date,
            savedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
          },
          { _id: false },
        ),
      ],
      default: [],
    },
    updatedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
  },
  { timestamps: true },
);

export const MessageTemplateModel =
  mongoose.models.MessageTemplate || mongoose.model<IMessageTemplate>("MessageTemplate", TemplateSchema);
