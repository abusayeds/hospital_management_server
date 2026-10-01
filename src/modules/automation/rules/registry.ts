import type { AnyRule } from "./types";

/** Every rule in the system, by key. Rules register themselves (rules/index.ts imports them all). */
const rules = new Map<string, AnyRule>();

export const registerRule = (rule: AnyRule) => {
  rules.set(rule.key, rule);
  return rule;
};
export const getRule = (key: string) => rules.get(key);
export const allRules = () => [...rules.values()];

/** Tests only */
export const unregisterRule = (key: string) => rules.delete(key);
