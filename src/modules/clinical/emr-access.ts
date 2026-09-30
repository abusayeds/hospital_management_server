import { Request } from "express";
import { Types } from "mongoose";
import { roleHasPermission } from "../../config/permissions";
import AppError from "../../errors/AppError";
import { assertCanAccess } from "../../middlewares/authorize";
import { todayInDhaka } from "../../utils/date";
import { AppointmentModel } from "../hospital/appointment/appointment.model";
import { findDoctorForUser } from "../hospital/doctor/doctor.service";

/**
 * OBJECT-LEVEL ACCESS TO MEDICAL RECORDS — one place, used by every clinical endpoint.
 *
 * The permission (visit:read) says "doctors may read medical records". This file says
 * "THIS doctor may read THIS patient's record": only when the patient has (or had, or will
 * have) an appointment with them — unless the user holds the broader `emr:read_all`.
 * Denials answer 403 and are written to the audit log (assertCanAccess).
 */

type User = NonNullable<Request["user"]>;

/** The doctor profile id linked to the signed-in user, or null */
export const doctorIdOf = async (user: User): Promise<string | null> => {
  const doctor = await findDoctorForUser(user.id);
  return doctor ? String(doctor._id) : null;
};

export const canOpenEmr = async (user: User, patientId: string): Promise<boolean> => {
  if (roleHasPermission(user.role, "emr:read_all")) return true;
  if (!roleHasPermission(user.role, "visit:read")) return false;
  const doctorId = await doctorIdOf(user);
  if (!doctorId || !Types.ObjectId.isValid(patientId)) return false;
  const relation = await AppointmentModel.exists({
    patient: patientId,
    doctor: doctorId,
    status: { $ne: "cancelled" },
  });
  return Boolean(relation);
};

export const assertEmrAccess = async (req: Request, patientId: string) => {
  if (!Types.ObjectId.isValid(patientId)) throw new AppError(400, "Invalid patient id.", "INVALID_ID");
  await assertCanAccess(req, await canOpenEmr(req.user!, patientId), { entityType: "Patient", entityId: patientId });
};

/**
 * Vitals history: doctors follow the EMR rule above; nurses may see the history of a
 * patient who is in today's list (they need the previous readings to compare).
 */
export const assertVitalsAccess = async (req: Request, patientId: string) => {
  const role = req.user!.role;
  if (roleHasPermission(role, "visit:read") || roleHasPermission(role, "emr:read_all"))
    return assertEmrAccess(req, patientId);
  const today = Types.ObjectId.isValid(patientId)
    ? await AppointmentModel.exists({
        patient: patientId,
        date: todayInDhaka(),
        status: { $in: ["checked_in", "in_consultation", "completed"] },
      })
    : null;
  await assertCanAccess(req, Boolean(today), { entityType: "Patient", entityId: patientId });
};
