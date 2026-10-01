/* eslint-disable @typescript-eslint/no-explicit-any */
import { Request } from "express";
import { Types } from "mongoose";
import AppError from "../../../errors/AppError";
import { recordAudit } from "../../audit/audit.service";
import {
  IMessageTemplate,
  MessageTemplateDocument,
  MessageTemplateModel,
  TemplateContent,
} from "../models/template.model";
import { DEFAULT_TEMPLATES } from "./defaults";
import { renderTemplate, sampleValues, validateTemplate } from "./render";

/**
 * Templates: defaults from code are inserted once (never overwrite an admin's edits); every save is
 * validated, bumps the version and keeps the previous content for rollback.
 */

/** Insert missing default templates (startup, seed, tests) */
export const ensureDefaultTemplates = async () => {
  for (const t of DEFAULT_TEMPLATES) {
    const errors = validateTemplate(t, t.variables);
    if (errors.length) throw new Error(`Default template ${t.key} is invalid: ${errors.join(" ")}`);
    await MessageTemplateModel.updateOne({ key: t.key }, { $setOnInsert: { ...t, version: 1 } }, { upsert: true });
  }
};

export const getTemplate = async (key: string): Promise<MessageTemplateDocument> => {
  let doc = (await MessageTemplateModel.findOne({ key })) as MessageTemplateDocument | null;
  if (!doc && DEFAULT_TEMPLATES.some((t) => t.key === key)) {
    await ensureDefaultTemplates();
    doc = (await MessageTemplateModel.findOne({ key })) as MessageTemplateDocument | null;
  }
  if (!doc) throw new AppError(404, `Message template "${key}" not found.`);
  return doc;
};

const contentOf = (t: any): TemplateContent => ({
  bodies: { bn: t.bodies.bn, en: t.bodies.en },
  buttons: (t.buttons ?? []).map((b: any) => ({ action: b.action, label: { bn: b.label.bn, en: b.label.en } })),
  whatsappTemplateName: t.whatsappTemplateName ?? null,
  whatsappLanguages: { bn: t.whatsappLanguages?.bn ?? "bn", en: t.whatsappLanguages?.en ?? "en" },
  whatsappParams: [...(t.whatsappParams ?? [])],
});

export const templateView = (t: any) => ({
  id: String(t._id),
  key: t.key,
  description: t.description,
  category: t.category,
  channels: t.channels,
  variables: t.variables.map((v: any) => ({ name: v.name, type: v.type, required: v.required, sample: v.sample })),
  ...contentOf(t),
  isActive: t.isActive,
  version: t.version,
  history: (t.history ?? []).map((h: any) => ({ version: h.version, savedAt: h.savedAt, ...contentOf(h) })).reverse(),
  updatedAt: t.updatedAt,
});

export const listTemplates = async (category?: string) =>
  (
    await MessageTemplateModel.find(category ? { category } : {})
      .sort({ category: 1, key: 1 })
      .lean<any[]>()
  ).map(templateView);

export type TemplateUpdate = Partial<TemplateContent> & {
  description?: string;
  isActive?: boolean;
  variables?: IMessageTemplate["variables"];
};

export const updateTemplate = async (req: Request, key: string, input: TemplateUpdate) => {
  const doc = await getTemplate(key);
  const next = { ...contentOf(doc), ...input } as TemplateContent;
  const variables = input.variables ?? doc.variables;
  const errors = validateTemplate(next, variables);
  if (errors.length)
    throw new AppError(
      400,
      errors[0],
      "VALIDATION_ERROR",
      errors.map((message) => ({ path: "body", message })),
    );
  const before = templateView(doc.toObject());
  doc.history.push({ ...contentOf(doc), version: doc.version, savedAt: new Date(), savedBy: doc.updatedBy ?? null });
  if (doc.history.length > 20) doc.history.splice(0, doc.history.length - 20);
  doc.set({ ...next, variables, version: doc.version + 1, updatedBy: new Types.ObjectId(req.user!.id) });
  if (input.description !== undefined) doc.description = input.description;
  if (input.isActive !== undefined) doc.isActive = input.isActive;
  await doc.save();
  await recordAudit({
    req,
    action: "UPDATE",
    entityType: "MessageTemplate",
    entityId: doc._id,
    before: { version: before.version, bodies: before.bodies },
    after: { version: doc.version, bodies: doc.bodies },
  });
  return templateView(doc.toObject());
};

/** Restore an older version (as a NEW version, so history stays complete) */
export const rollbackTemplate = async (req: Request, key: string, version: number) => {
  const doc = await getTemplate(key);
  const old = doc.history.find((h: any) => h.version === version);
  if (!old) throw new AppError(404, `Version ${version} not found.`);
  return updateTemplate(req, key, contentOf(old));
};

/** Preview with sample (or given) data — both languages, inside and outside WhatsApp's 24-hour window */
export const previewTemplate = (
  t: TemplateContent & { variables: IMessageTemplate["variables"] },
  numerals: "bn" | "en",
  values?: Record<string, unknown>,
) => {
  const data = { ...sampleValues(t.variables), ...(values ?? {}) };
  const out = {} as Record<"bn" | "en", unknown>;
  for (const lang of ["bn", "en"] as const) {
    const r = renderTemplate(t, lang, data, numerals);
    out[lang] = {
      session: { text: r.text, buttons: r.buttons.map((b) => b.label) },
      template: t.whatsappTemplateName
        ? {
            name: t.whatsappTemplateName,
            language: t.whatsappLanguages[lang],
            parameters: r.whatsappParams,
            buttons: r.buttons.map((b) => b.label),
          }
        : null,
      missing: r.missing,
    };
  }
  return { errors: validateTemplate(t, t.variables), preview: out };
};
