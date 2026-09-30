import type { ConversationDocument } from "./conversation.model";

/**
 * SHORT REFERENCES — the model never sees real database ids of patients, appointments or lab orders.
 * Tools hand it "P1", "A2", "L1"; the mapping lives on the conversation, so a reference invented by
 * the model (or copied from another chat) simply does not resolve. Ownership is still re-checked
 * against the verified phone before anything is done.
 */
export type RefKind = "P" | "A" | "L";

export const refFor = (conv: ConversationDocument, kind: RefKind, id: string): string => {
  for (const [ref, value] of conv.refs) if (value === id && ref.startsWith(kind)) return ref;
  let n = 1;
  while (conv.refs.has(`${kind}${n}`)) n += 1;
  conv.refs.set(`${kind}${n}`, id);
  conv.markModified("refs");
  return `${kind}${n}`;
};

export const resolveRef = (conv: ConversationDocument, kind: RefKind, ref: unknown): string | null => {
  const key = String(ref ?? "")
    .trim()
    .toUpperCase();
  if (key[0] !== kind || !/^[A-Z]\d{1,3}$/.test(key)) return null;
  return conv.refs.get(key) ?? null;
};
