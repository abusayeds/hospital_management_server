import { randomInt } from "crypto";
import { Request } from "express";
import { Types } from "mongoose";
import type { Role } from "../../config/permissions";
import AppError from "../../errors/AppError";
import { buildPagination } from "../../interface/global.interface";
import { escapeRegex } from "../../utils/escapeRegex";
import { generateTemporaryPassword } from "../../validators/password";
import { recordAudit } from "../audit/audit.service";
import { hashPassword, revokeAllSessions } from "../auth/auth.service";
import { UserDocument, UserModel } from "./user.model";

type ListFilters = { search?: string; role?: Role; status?: "active" | "inactive"; page: number; limit: number };
type CreateInput = { name: string; email: string; phone?: string; role: Role; temporaryPassword?: string };
type UpdateInput = Partial<{ name: string; email: string; phone: string; role: Role }>;

const newTemporaryPassword = () => generateTemporaryPassword((max) => randomInt(max));

const findOrThrow = async (id: string) => {
  const user = (await UserModel.findById(id)) as UserDocument | null;
  if (!user) throw new AppError(404, "User not found.");
  return user;
};

// Snapshot for the audit log: only fields that matter, never secrets
const snapshot = (u: UserDocument) => ({
  name: u.name,
  email: u.email,
  phone: u.phone ?? null,
  role: u.role,
  isActive: u.isActive,
  mustChangePassword: u.mustChangePassword,
});

/** The hospital must always keep at least one active super admin */
const assertNotLastSuperAdmin = async (user: UserDocument, message: string) => {
  if (user.role !== "super_admin" || !user.isActive) return;
  const others = await UserModel.countDocuments({ role: "super_admin", isActive: true, _id: { $ne: user._id } });
  if (others === 0) throw new AppError(409, message, "CONFLICT");
};

export const listUsers = async ({ search, role, status, page, limit }: ListFilters) => {
  const filter: Record<string, unknown> = {};
  if (role) filter.role = role;
  if (status) filter.isActive = status === "active";
  if (search) {
    const rx = new RegExp(escapeRegex(search), "i");
    filter.$or = [{ name: rx }, { email: rx }, { phone: rx }];
  }
  const [items, total] = await Promise.all([
    UserModel.find(filter)
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit),
    UserModel.countDocuments(filter),
  ]);
  return { items: items.map((u: UserDocument) => u.toJSON()), pagination: buildPagination(page, limit, total) };
};

export const getUser = async (id: string) => (await findOrThrow(id)).toJSON();

export const createUser = async (req: Request, input: CreateInput) => {
  if (await UserModel.exists({ email: input.email })) {
    throw new AppError(409, "A user with this email already exists.", "DUPLICATE_KEY", [
      { path: "body.email", message: "already exists" },
    ]);
  }
  const temporaryPassword = input.temporaryPassword ?? newTemporaryPassword();
  const user = (await UserModel.create({
    name: input.name,
    email: input.email,
    phone: input.phone,
    role: input.role,
    passwordHash: await hashPassword(temporaryPassword),
    mustChangePassword: true, // the admin knows this password, so the user must replace it
    createdBy: req.user!.id,
  })) as UserDocument;

  await recordAudit({ req, action: "CREATE", entityType: "User", entityId: user._id, after: snapshot(user) });
  // The temporary password is returned exactly once so the admin can hand it over
  return { user: user.toJSON(), temporaryPassword };
};

export const updateUser = async (req: Request, id: string, input: UpdateInput) => {
  const user = await findOrThrow(id);
  const before = snapshot(user);
  const roleChanging = input.role !== undefined && input.role !== user.role;

  if (roleChanging && String(user._id) === req.user!.id) {
    throw new AppError(409, "You cannot change your own role. Ask another administrator.", "CONFLICT");
  }
  if (roleChanging)
    await assertNotLastSuperAdmin(user, "This is the last active super admin; their role cannot be changed.");
  if (input.email && input.email !== user.email && (await UserModel.exists({ email: input.email }))) {
    throw new AppError(409, "A user with this email already exists.", "DUPLICATE_KEY", [
      { path: "body.email", message: "already exists" },
    ]);
  }

  if (input.name !== undefined) user.name = input.name;
  if (input.email !== undefined) user.email = input.email;
  if (input.phone !== undefined) user.phone = input.phone || undefined;
  if (input.role !== undefined) user.role = input.role;
  user.updatedBy = new Types.ObjectId(req.user!.id);
  await user.save();

  const after = snapshot(user);
  await recordAudit({
    req,
    action: roleChanging ? "ROLE_CHANGE" : "UPDATE",
    entityType: "User",
    entityId: user._id,
    before,
    after,
  });
  return user.toJSON();
};

export const setActive = async (req: Request, id: string, active: boolean) => {
  const user = await findOrThrow(id);
  if (user.isActive === active) return user.toJSON();

  if (!active) {
    if (String(user._id) === req.user!.id)
      throw new AppError(409, "You cannot deactivate your own account.", "CONFLICT");
    await assertNotLastSuperAdmin(user, "This is the last active super admin and cannot be deactivated.");
  }

  const before = snapshot(user);
  user.isActive = active;
  if (active) {
    user.failedLoginCount = 0;
    user.lockUntil = null;
  }
  user.updatedBy = new Types.ObjectId(req.user!.id);
  await user.save();

  // Deactivation ends every session at once (authenticate also rejects inactive users)
  if (!active) await revokeAllSessions(String(user._id), "deactivated");
  await recordAudit({
    req,
    action: active ? "ACTIVATE" : "DEACTIVATE",
    entityType: "User",
    entityId: user._id,
    before,
    after: snapshot(user),
  });
  return user.toJSON();
};

export const resetPassword = async (req: Request, id: string) => {
  const user = await findOrThrow(id);
  const temporaryPassword = newTemporaryPassword();
  user.passwordHash = await hashPassword(temporaryPassword);
  user.mustChangePassword = true;
  user.passwordChangedAt = new Date();
  user.failedLoginCount = 0;
  user.lockUntil = null;
  user.updatedBy = new Types.ObjectId(req.user!.id);
  await user.save();

  await revokeAllSessions(String(user._id), "password_reset");
  await recordAudit({ req, action: "PASSWORD_RESET", entityType: "User", entityId: user._id });
  return { user: user.toJSON(), temporaryPassword };
};

// Numbers for the admin dashboard
export const getUserSummary = async () => {
  const [total, active, byRole] = await Promise.all([
    UserModel.countDocuments({}),
    UserModel.countDocuments({ isActive: true }),
    UserModel.aggregate<{ _id: Role; count: number }>([{ $group: { _id: "$role", count: { $sum: 1 } } }]),
  ]);
  return { total, active, inactive: total - active, byRole: Object.fromEntries(byRole.map((r) => [r._id, r.count])) };
};

export const userService = { listUsers, getUser, createUser, updateUser, setActive, resetPassword, getUserSummary };
