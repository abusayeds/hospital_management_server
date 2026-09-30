import mongoose, { ClientSession, Schema } from "mongoose";

// One document per sequence, e.g. { _id: "patient", seq: 123 } or
// { _id: "queue:2026-09-29:<doctorId>", seq: 7 } for a daily per-doctor serial.
interface ICounter {
  _id: string;
  seq: number;
}

const CounterSchema = new Schema<ICounter>(
  {
    _id: { type: String, required: true },
    seq: { type: Number, default: 0 },
  },
  { versionKey: false },
);

export const CounterModel = mongoose.models.Counter || mongoose.model<ICounter>("Counter", CounterSchema);

/**
 * Returns the next number in a named sequence.
 *
 * `$inc` inside a single findOneAndUpdate is atomic on the MongoDB server, so two
 * receptionists registering patients at the same moment can never receive the
 * same number (unlike "count documents + 1", which races). `upsert` creates the
 * counter on first use. Pass a session to make it part of a transaction.
 */
export const getNextSequence = async (name: string, session?: ClientSession): Promise<number> => {
  const counter = await CounterModel.findOneAndUpdate(
    { _id: name },
    { $inc: { seq: 1 } },
    { new: true, upsert: true, session },
  ).lean<ICounter>();
  return counter!.seq;
};

/** formatCode("TL", 123) → "TL-000123" */
export const formatCode = (prefix: string, value: number, digits = 6): string =>
  `${prefix}-${String(value).padStart(digits, "0")}`;

/** Convenience: next formatted code, e.g. nextCode("patient", "TL") → "TL-000124" */
export const nextCode = async (name: string, prefix: string, session?: ClientSession): Promise<string> =>
  formatCode(prefix, await getNextSequence(name, session));
