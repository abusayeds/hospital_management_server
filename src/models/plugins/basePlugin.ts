/* eslint-disable @typescript-eslint/no-explicit-any */
import { Schema, Types } from "mongoose";

/**
 * Applied to every domain model (patients, visits, invoices, ...):
 *  - timestamps: createdAt / updatedAt
 *  - audit fields: createdBy / updatedBy (set by services from the logged-in user)
 *  - soft delete: isDeleted / deletedAt / deletedBy
 *
 * Medical and financial records must never be hard-deleted, so "delete" only
 * flags the document, and normal queries skip flagged documents automatically.
 * To include them (e.g. an audit screen), call `.setOptions({ withDeleted: true })`.
 */
export interface IBaseFields {
  createdBy?: Types.ObjectId | null;
  updatedBy?: Types.ObjectId | null;
  isDeleted: boolean;
  deletedAt?: Date | null;
  deletedBy?: Types.ObjectId | null;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface IBaseMethods {
  softDelete(deletedBy?: Types.ObjectId | string | null): Promise<unknown>;
  restore(): Promise<unknown>;
}

const QUERY_HOOKS = [
  "find",
  "findOne",
  "findOneAndUpdate",
  "countDocuments",
  "updateOne",
  "updateMany",
  "distinct",
] as const;

export const basePlugin = (schema: Schema) => {
  schema.add({
    createdBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    updatedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    isDeleted: { type: Boolean, default: false, index: true },
    deletedAt: { type: Date, default: null },
    deletedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
  });
  schema.set("timestamps", true);

  // Hide soft-deleted documents unless the caller explicitly asks for them.
  // $ne: true (not === false) also matches older documents without the field.
  for (const hook of QUERY_HOOKS) {
    schema.pre(hook as any, function (this: any) {
      if (this.getOptions().withDeleted) return;
      if (this.getFilter().isDeleted === undefined) this.where({ isDeleted: { $ne: true } });
    });
  }

  schema.pre("aggregate", function () {
    if ((this.options as any).withDeleted) return;
    this.pipeline().unshift({ $match: { isDeleted: { $ne: true } } });
  });

  schema.methods.softDelete = function (deletedBy?: Types.ObjectId | string | null) {
    this.isDeleted = true;
    this.deletedAt = new Date();
    this.deletedBy = deletedBy ?? null;
    return this.save();
  };

  schema.methods.restore = function () {
    this.isDeleted = false;
    this.deletedAt = null;
    this.deletedBy = null;
    return this.save();
  };
};
