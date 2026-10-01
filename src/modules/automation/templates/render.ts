import type { TemplateButton, TemplateContent, TemplateVariable } from "../models/template.model";
import { formatDateFor, formatTimeFor, toBanglaDigits } from "../time";

/**
 * A TINY, SAFE TEMPLATE ENGINE. The only syntax is {{name}} — no sections, loops, partials, HTML or
 * code, so an admin-edited template can never execute anything. Values are plain text: braces are
 * stripped and length is capped, so a value cannot inject another placeholder.
 * validateTemplate() runs when a template is SAVED; a template that passes always renders.
 */

const TAG = /\{\{([^{}]*)\}\}/g;
const NAME = /^[a-zA-Z_][a-zA-Z0-9_]{0,40}$/;
export const MAX_BUTTONS = 3; // WhatsApp reply buttons
export const MAX_BUTTON_LABEL = 20;

export type Lang = "bn" | "en";

/** Placeholder names used in a text, in order of appearance */
export const placeholders = (text: string) => [...text.matchAll(TAG)].map((m) => m[1].trim());

/** All problems with a template, as readable messages (empty = valid) */
export const validateTemplate = (content: TemplateContent, variables: TemplateVariable[]): string[] => {
  const errors: string[] = [];
  const declared = new Set(variables.map((v) => v.name));
  for (const v of variables) if (!NAME.test(v.name)) errors.push(`Variable name "${v.name}" is not allowed.`);

  for (const lang of ["bn", "en"] as const) {
    const body = content.bodies[lang] ?? "";
    if (!body.trim()) errors.push(`The ${lang} text is empty.`);
    for (const name of placeholders(body)) {
      if (!NAME.test(name)) errors.push(`{{${name}}} in the ${lang} text is not a valid placeholder.`);
      else if (!declared.has(name)) errors.push(`{{${name}}} in the ${lang} text is not a declared variable.`);
    }
    // Leftover braces mean a typo like "{{name}" or "{name}}"
    if (/\{\{|\}\}/.test(body.replace(TAG, ""))) errors.push(`The ${lang} text has unmatched {{ or }}.`);
  }

  if (content.buttons.length > MAX_BUTTONS) errors.push(`At most ${MAX_BUTTONS} buttons are allowed.`);
  for (const b of content.buttons) {
    if (!b.action) errors.push("Every button needs an action.");
    for (const lang of ["bn", "en"] as const)
      if (!b.label?.[lang]?.trim() || b.label[lang].length > MAX_BUTTON_LABEL)
        errors.push(`Button "${b.action}" needs a ${lang} label of 1–${MAX_BUTTON_LABEL} characters.`);
  }

  for (const p of content.whatsappParams ?? [])
    if (!declared.has(p)) errors.push(`WhatsApp template parameter "${p}" is not a declared variable.`);
  if (content.whatsappParams?.length && !content.whatsappTemplateName)
    errors.push("WhatsApp parameters are set but the WhatsApp template name is empty.");
  if (content.whatsappTemplateName && !/^[a-z0-9_]{1,512}$/.test(content.whatsappTemplateName))
    errors.push("WhatsApp template names use lowercase letters, digits and underscores only.");
  return errors;
};

const clean = (v: unknown) =>
  String(v ?? "")
    .replace(/[{}]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);

/** Turn a raw value into what the patient reads: dates/times localised, digits per hospital setting */
export const formatValue = (variable: TemplateVariable | undefined, raw: unknown, lang: Lang, numerals: Lang) => {
  let value = clean(raw);
  if (value && variable?.type === "date" && /^\d{4}-\d{2}-\d{2}$/.test(value)) value = formatDateFor(value, lang);
  if (value && variable?.type === "time" && /^\d{2}:\d{2}$/.test(value)) value = formatTimeFor(value, lang);
  if (value && variable?.type === "money") value = lang === "bn" ? `${value} টাকা` : `Tk ${value}`;
  return lang === "bn" && numerals === "bn" ? toBanglaDigits(value) : value;
};

export type Rendered = {
  text: string;
  buttons: { action: string; label: string }[];
  whatsappParams: string[]; // values for the approved template's {{1}}, {{2}} …
  missing: string[]; // required variables without a value
};

export const renderTemplate = (
  tpl: TemplateContent & { variables: TemplateVariable[] },
  lang: Lang,
  values: Record<string, unknown>,
  numerals: Lang = "bn",
): Rendered => {
  const byName = new Map(tpl.variables.map((v) => [v.name, v]));
  const formatted: Record<string, string> = {};
  for (const v of tpl.variables) formatted[v.name] = formatValue(v, values[v.name], lang, numerals);
  const missing = tpl.variables.filter((v) => v.required && !formatted[v.name]).map((v) => v.name);
  // A line whose placeholders are all OPTIONAL and empty is left out (no dangling "Directions:")
  const text = tpl.bodies[lang]
    .split("\n")
    .filter((line) => {
      const names = placeholders(line);
      return !names.length || names.some((n) => formatted[n] || byName.get(n)?.required);
    })
    .map((line) => line.replace(TAG, (_, name: string) => (byName.has(name.trim()) ? formatted[name.trim()] : "")))
    .join("\n")
    .replace(/[ \t]+\n/g, "\n")
    .trim();
  return {
    text,
    buttons: tpl.buttons.map((b: TemplateButton) => ({ action: b.action, label: b.label[lang] })),
    whatsappParams: (tpl.whatsappParams ?? []).map((p) => formatted[p] || "-"),
    missing,
  };
};

/** Sample values declared on the template (admin preview) */
export const sampleValues = (variables: TemplateVariable[]) =>
  Object.fromEntries(variables.map((v) => [v.name, v.sample]));
