/* eslint-disable @typescript-eslint/no-explicit-any */
import { Request } from "express";
import { Types } from "mongoose";
import { z } from "zod";
import AppError from "../../../errors/AppError";
import { recordAudit } from "../../audit/audit.service";
import { getSettings } from "../../hospital/settings/settings.service";
import { AutomationRuleSettingModel } from "../models/ruleSetting.model";
import { MessageTemplateModel } from "../models/template.model";
import { getRule } from "./registry";
import type { AnyRule, RuleContext } from "./types";

/** Settings every rule has (validated here; rule-specific timings use the rule's own schema) */
export const baseConfigSchema = z
  .object({
    quietHoursOverride: z.boolean(),
    dailyLimit: z.number().int().min(1).max(100_000),
    channels: z
      .array(z.enum(["whatsapp", "sms"]))
      .min(1)
      .max(2),
    templateKey: z.string().regex(/^[a-z][a-z0-9_]{2,60}$/),
  })
  .partial()
  .strict();

export type RuleState = { enabled: boolean; config: any; updatedAt: Date | null };

export const ruleState = async (rule: AnyRule): Promise<RuleState> => {
  const doc = await AutomationRuleSettingModel.findOne({ key: rule.key }).lean<any>();
  return {
    enabled: doc?.enabled ?? rule.enabledByDefault,
    config: { ...rule.defaults, ...(doc?.config ?? {}) },
    updatedAt: doc?.updatedAt ?? null,
  };
};

/** Everything a rule needs to plan or prepare, at a given moment */
export const ruleContext = async (rule: AnyRule, now: Date): Promise<RuleContext<any> & RuleState> => {
  const [state, settings] = await Promise.all([ruleState(rule), getSettings()]);
  return { ...state, now, settings };
};

export const updateRuleSettings = async (
  req: Request,
  key: string,
  input: { enabled?: boolean; config?: Record<string, unknown> },
) => {
  const rule = getRule(key);
  if (!rule) throw new AppError(404, "Automation rule not found.");
  const before = await ruleState(rule);
  let config = before.config;
  if (input.config) {
    const base = Object.fromEntries(Object.entries(input.config).filter(([k]) => k in baseConfigSchema.shape));
    const own = Object.fromEntries(Object.entries(input.config).filter(([k]) => !(k in baseConfigSchema.shape)));
    const a = baseConfigSchema.safeParse(base);
    const b = rule.configSchema.safeParse(own);
    const issues = [...(a.success ? [] : a.error.issues), ...(b.success ? [] : b.error.issues)];
    if (issues.length)
      throw new AppError(
        400,
        `Invalid setting "${issues[0].path.join(".")}": ${issues[0].message}`,
        "VALIDATION_ERROR",
        issues.map((i) => ({ path: `body.config.${i.path.join(".")}`, message: i.message })),
      );
    if (a.data?.templateKey && !(await MessageTemplateModel.exists({ key: a.data.templateKey })))
      throw new AppError(400, `Template "${a.data.templateKey}" does not exist.`, "VALIDATION_ERROR");
    config = { ...config, ...a.data, ...b.data };
  }
  const enabled = input.enabled ?? before.enabled;
  // Store only what differs from the code defaults, so new defaults still reach untouched settings
  const overrides = Object.fromEntries(
    Object.entries(config).filter(([k, v]) => JSON.stringify(v) !== JSON.stringify(rule.defaults[k])),
  );
  await AutomationRuleSettingModel.updateOne(
    { key },
    { $set: { enabled, config: overrides, updatedBy: new Types.ObjectId(req.user!.id) } },
    { upsert: true },
  );
  await recordAudit({
    req,
    action: "UPDATE",
    entityType: "AutomationRule",
    meta: { key },
    before: { enabled: before.enabled, config: before.config },
    after: { enabled, config },
  });
  return ruleState(rule);
};
