import { checkPreferences, checkQuietHours } from "../../src/modules/automation/guards";
import type { AnyRule } from "../../src/modules/automation/rules/types";
import { DEFAULT_TEMPLATES } from "../../src/modules/automation/templates/defaults";
import { renderTemplate, validateTemplate } from "../../src/modules/automation/templates/render";
import { atDhaka, formatTimeFor, inQuietHours, quietHoursEndAfter } from "../../src/modules/automation/time";

const tpl = (bn: string, en: string, extra: Record<string, unknown> = {}) => ({
  bodies: { bn, en },
  buttons: [],
  whatsappTemplateName: null,
  whatsappLanguages: { bn: "bn", en: "en" },
  whatsappParams: [],
  variables: [
    { name: "name", type: "string" as const, required: true, sample: "Rahim" },
    { name: "date", type: "date" as const, required: true, sample: "2026-10-02" },
    { name: "time", type: "time" as const, required: true, sample: "10:30" },
    { name: "serial", type: "number" as const, required: true, sample: "7" },
  ],
  ...extra,
});

describe("template engine", () => {
  it("every default template is valid", () => {
    for (const t of DEFAULT_TEMPLATES) expect([t.key, validateTemplate(t, t.variables)]).toEqual([t.key, []]);
  });

  it("rejects undeclared variables, bad syntax and bad WhatsApp mapping at SAVE time", () => {
    const t = tpl("{{name}} {{unknown}}", "{{name}} {{#each x}}", { whatsappParams: ["missing"] });
    const errors = validateTemplate(t, t.variables);
    expect(errors.join("\n")).toMatch(/unknown.*not a declared variable/);
    expect(errors.join("\n")).toMatch(/#each x.*not a valid placeholder/);
    expect(errors.join("\n")).toMatch(/parameter "missing" is not a declared variable/);
    expect(validateTemplate(tpl("{{name}", "x"), tpl("", "").variables).join()).toMatch(/unmatched/);
  });

  it("renders Bangla with Bangla numerals, English with English digits", () => {
    const t = tpl(
      "{{name}}, {{date}} {{time}} সিরিয়াল {{serial}}",
      "{{name}}, {{date}} at {{time}}, serial {{serial}}",
    );
    const values = { name: "Rahim", date: "2026-10-02", time: "18:30", serial: 12 };
    expect(renderTemplate(t, "bn", values, "bn").text).toBe("Rahim, ২ অক্টোবর, শুক্রবার সন্ধ্যা ৬:৩০ সিরিয়াল ১২");
    expect(renderTemplate(t, "bn", values, "en").text).toBe("Rahim, 2 অক্টোবর, শুক্রবার সন্ধ্যা 6:30 সিরিয়াল 12");
    expect(renderTemplate(t, "en", values, "bn").text).toBe("Rahim, Fri, 2 Oct at 6:30 PM, serial 12");
  });

  it("values cannot inject placeholders or code; missing required values are reported", () => {
    const t = tpl("Hi {{name}}", "Hi {{name}}");
    expect(renderTemplate(t, "en", { name: "{{serial}}<script>" }, "en").text).toBe("Hi serial<script>");
    expect(renderTemplate(t, "en", {}, "en").missing).toEqual(["name", "date", "time", "serial"]);
  });

  it("leaves out a line whose optional values are all empty", () => {
    const t = tpl("x", "Hi {{name}}\nDirections: {{link}}\nBye", {
      variables: [
        { name: "name", type: "string", required: true, sample: "" },
        { name: "link", type: "url", required: false, sample: "" },
      ],
    });
    expect(renderTemplate(t, "en", { name: "Rahim" }, "en").text).toBe("Hi Rahim\nBye");
    expect(renderTemplate(t, "en", { name: "Rahim", link: "https://x.y" }, "en").text).toBe(
      "Hi Rahim\nDirections: https://x.y\nBye",
    );
  });

  it("maps WhatsApp template parameters in order, formatted like the text", () => {
    const t = tpl("x", "x", { whatsappTemplateName: "tl_x", whatsappParams: ["serial", "date"] });
    expect(renderTemplate(t, "en", { serial: 3, date: "2026-10-02" }, "en").whatsappParams).toEqual([
      "3",
      "Fri, 2 Oct",
    ]);
  });

  it("formats times for patients", () => {
    expect(formatTimeFor("09:05", "en")).toBe("9:05 AM");
    expect(formatTimeFor("12:00", "en")).toBe("12:00 PM");
    expect(formatTimeFor("09:05", "bn")).toBe("সকাল 9:05");
  });
});

describe("quiet hours", () => {
  it("handles a window that crosses midnight", () => {
    expect(inQuietHours(atDhaka("2026-10-02", "22:00"), "21:00", "09:00")).toBe(true);
    expect(inQuietHours(atDhaka("2026-10-02", "08:59"), "21:00", "09:00")).toBe(true);
    expect(inQuietHours(atDhaka("2026-10-02", "09:00"), "21:00", "09:00")).toBe(false);
    expect(quietHoursEndAfter(atDhaka("2026-10-02", "22:00"), "21:00", "09:00")).toEqual(
      atDhaka("2026-10-03", "09:00"),
    );
    expect(quietHoursEndAfter(atDhaka("2026-10-02", "06:00"), "21:00", "09:00")).toEqual(
      atDhaka("2026-10-02", "09:00"),
    );
  });

  it("defers non-urgent messages; urgent ones pass only when the rule allows it", () => {
    const night = atDhaka("2026-10-02", "23:00");
    const s = { quietHoursStart: "21:00", quietHoursEnd: "09:00" };
    expect(checkQuietHours(night, s, { quietHoursOverride: true }, false)).toMatchObject({
      action: "defer",
      reason: "quietHours",
    });
    expect(checkQuietHours(night, s, { quietHoursOverride: false }, true).action).toBe("defer");
    expect(checkQuietHours(night, s, { quietHoursOverride: true }, true).action).toBe("send");
  });
});

describe("patient preferences", () => {
  const rule = (category: AnyRule["category"], essential = false) => ({ category, essential }) as AnyRule;

  it("STOP silences reminders but essential messages still go; marketing needs opt-in", () => {
    const stopped = { optOutAll: true, marketing: true };
    expect(checkPreferences(rule("reminders"), stopped)).toMatchObject({ action: "skip", reason: "optOut" });
    expect(checkPreferences(rule("essential", true), stopped).action).toBe("send");
    expect(checkPreferences(rule("marketing"), stopped).action).toBe("skip");
    expect(checkPreferences(rule("marketing"), {}).action).toBe("skip"); // default: not opted in
    expect(checkPreferences(rule("marketing"), { marketing: true }).action).toBe("send");
  });

  it("a category switch only affects its own messages", () => {
    expect(checkPreferences(rule("followUps"), { followUps: false }).action).toBe("skip");
    expect(checkPreferences(rule("reminders"), { followUps: false }).action).toBe("send");
    expect(checkPreferences(rule("internal"), { optOutAll: true }).action).toBe("send");
  });
});
