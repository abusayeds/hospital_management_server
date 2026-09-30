import mongoose, { HydratedDocument, Schema, Types } from "mongoose";
import { ROLES, Role } from "../../config/permissions";
import { basePlugin, IBaseFields, IBaseMethods } from "../../models/plugins/basePlugin";

export interface IUser extends IBaseFields {
  name: string;
  email: string;
  phone?: string;
  passwordHash: string;
  role: Role;
  isActive: boolean;
  mustChangePassword: boolean;
  failedLoginCount: number;
  lockUntil?: Date | null;
  lastLoginAt?: Date | null;
  passwordChangedAt?: Date | null;
  // Link to the Doctor profile (the Doctor master data is reworked in Phase 3)
  doctorProfile?: Types.ObjectId | null;
}

export type UserDocument = HydratedDocument<IUser, IBaseMethods>;

const UserSchema = new Schema<IUser, mongoose.Model<IUser>, IBaseMethods>({
  name: { type: String, required: true, trim: true, maxlength: 100 },
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  phone: { type: String, trim: true },
  // select: false → never loaded unless a query explicitly asks for it (login, password change)
  passwordHash: { type: String, required: true, select: false },
  role: { type: String, enum: ROLES, required: true, index: true },
  isActive: { type: Boolean, default: true, index: true },
  mustChangePassword: { type: Boolean, default: false },
  failedLoginCount: { type: Number, default: 0 },
  lockUntil: { type: Date, default: null },
  lastLoginAt: { type: Date, default: null },
  passwordChangedAt: { type: Date, default: null },
  doctorProfile: { type: Schema.Types.ObjectId, ref: "Doctor", default: null },
});

UserSchema.plugin(basePlugin);

// Defense in depth: even if a query selects passwordHash, it never reaches a response
UserSchema.set("toJSON", {
  transform: (_doc, ret: Record<string, unknown>) => {
    ret.id = String(ret._id);
    delete ret._id;
    delete ret.__v;
    delete ret.passwordHash;
    delete ret.failedLoginCount;
    delete ret.isDeleted;
    delete ret.deletedAt;
    delete ret.deletedBy;
    return ret;
  },
});

export const UserModel =
  mongoose.models.User || mongoose.model<IUser, mongoose.Model<IUser, object, IBaseMethods>>("User", UserSchema);
