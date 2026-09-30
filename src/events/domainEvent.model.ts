import mongoose, { Schema } from "mongoose";
import { DOMAIN_EVENT_NAMES } from "./catalog";

/**
 * Every published event, persisted (a lightweight outbox). `consumers` records each
 * internal subscriber's result, so failures are visible and Phase 6 automation can pick
 * up events it has not processed yet. Not soft-deleted: this is an append-style log.
 */
export const CONSUMER_STATUSES = ["pending", "done", "failed"] as const;

export interface IDomainEvent {
  name: (typeof DOMAIN_EVENT_NAMES)[number];
  payload: Record<string, unknown>;
  occurredAt: Date;
  consumers: {
    name: string;
    status: (typeof CONSUMER_STATUSES)[number];
    processedAt?: Date | null;
    error?: string | null;
  }[];
}

const DomainEventSchema = new Schema<IDomainEvent>(
  {
    name: { type: String, enum: DOMAIN_EVENT_NAMES, required: true },
    payload: { type: Schema.Types.Mixed, required: true },
    occurredAt: { type: Date, required: true, default: () => new Date() },
    consumers: {
      type: [
        new Schema(
          {
            name: { type: String, required: true },
            status: { type: String, enum: CONSUMER_STATUSES, default: "pending" },
            processedAt: { type: Date, default: null },
            error: { type: String, default: null, maxlength: 500 },
          },
          { _id: false },
        ),
      ],
      default: [],
    },
  },
  { versionKey: false },
);

DomainEventSchema.index({ occurredAt: -1 });
DomainEventSchema.index({ name: 1, occurredAt: -1 });
// "What has consumer X not processed yet?" (Phase 6)
DomainEventSchema.index({ "consumers.name": 1, "consumers.status": 1 });

export const DomainEventModel =
  mongoose.models.DomainEvent || mongoose.model<IDomainEvent>("DomainEvent", DomainEventSchema);
