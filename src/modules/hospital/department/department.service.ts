/* eslint-disable @typescript-eslint/no-explicit-any */
import { Request } from "express";
import AppError from "../../../errors/AppError";
import { escapeRegex } from "../../../utils/escapeRegex";
import { serialize } from "../../../utils/serialize";
import { recordAudit } from "../../audit/audit.service";
import { DoctorModel } from "../doctor/doctor.model";
import { DepartmentModel } from "./department.model";

type DepartmentInput = Partial<{ name: string; nameBn: string; description: string; icon: string; displayOrder: number; isActive: boolean }>;

const findOrThrow = async (id: string) => {
  const doc = await DepartmentModel.findById(id);
  if (!doc) throw new AppError(404, "Department not found.");
  return doc;
};

/** Departments with how many ACTIVE doctors each has (for the card grid and pickers) */
export const listDepartments = async ({ status }: { status?: "active" | "inactive" } = {}) => {
  const filter = status ? { isActive: status === "active" } : {};
  const [departments, counts] = await Promise.all([
    DepartmentModel.find(filter).sort({ displayOrder: 1, name: 1 }),
    DoctorModel.aggregate<{ _id: unknown; count: number }>([
      { $match: { isActive: true } },
      { $group: { _id: "$department", count: { $sum: 1 } } },
    ]),
  ]);
  const byId = new Map(counts.map((c) => [String(c._id), c.count]));
  return departments.map((d: any) => ({ ...serialize(d), doctorCount: byId.get(String(d._id)) ?? 0 }));
};

export const createDepartment = async (req: Request, input: DepartmentInput) => {
  if (await DepartmentModel.exists({ name: new RegExp(`^${escapeRegex(input.name ?? "")}$`, "i") })) {
    throw new AppError(409, "A department with this name already exists.", "DUPLICATE_KEY", [{ path: "body.name", message: "already exists" }]);
  }
  const doc = await DepartmentModel.create({ ...input, createdBy: req.user!.id });
  await recordAudit({ req, action: "CREATE", entityType: "Department", entityId: doc._id, after: serialize(doc) });
  return serialize(doc);
};

export const updateDepartment = async (req: Request, id: string, input: DepartmentInput) => {
  const doc = await findOrThrow(id);
  const before = serialize(doc);
  doc.set({ ...input, updatedBy: req.user!.id });
  await doc.save();
  await recordAudit({ req, action: "UPDATE", entityType: "Department", entityId: doc._id, before, after: serialize(doc) });
  return serialize(doc);
};

export const setDepartmentActive = async (req: Request, id: string, active: boolean) => {
  const doc = await findOrThrow(id);
  if (!active) {
    // A department cannot disappear from booking while doctors still work in it
    const activeDoctors = await DoctorModel.countDocuments({ department: doc._id, isActive: true });
    if (activeDoctors) {
      throw new AppError(409, `Move or deactivate its ${activeDoctors} active doctor(s) first.`, "CONFLICT");
    }
  }
  doc.isActive = active;
  doc.updatedBy = req.user!.id;
  await doc.save();
  await recordAudit({ req, action: active ? "ACTIVATE" : "DEACTIVATE", entityType: "Department", entityId: doc._id });
  return serialize(doc);
};

export const departmentService = { listDepartments, createDepartment, updateDepartment, setDepartmentActive };
