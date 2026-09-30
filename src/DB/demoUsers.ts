import type { Role } from "../config/permissions";
import { hashPassword } from "../modules/auth/auth.service";
import { UserModel } from "../modules/users/user.model";
import { logger } from "../utils/logger";

// DEMO DATA ONLY — fictional staff, one account per role, all using DEMO_PASSWORD.
export const DEMO_USERS: { role: Role; email: string; name: string; phone: string }[] = [
  { role: "super_admin", email: "admin@testolife.test", name: "Tanvir Hasan", phone: "01700000201" },
  { role: "management", email: "management@testolife.test", name: "Dr. Kamal Uddin", phone: "01700000202" },
  { role: "reception", email: "reception@testolife.test", name: "Nasrin Akter", phone: "01700000203" },
  { role: "doctor", email: "doctor@testolife.test", name: "Dr. Farhana Rahman", phone: "01700000204" },
  { role: "nurse", email: "nurse@testolife.test", name: "Shirin Sultana", phone: "01700000205" },
  { role: "lab_technician", email: "lab@testolife.test", name: "Rafiqul Islam", phone: "01700000206" },
  { role: "pharmacist", email: "pharmacy@testolife.test", name: "Mahmudul Karim", phone: "01700000207" },
  { role: "accounts", email: "accounts@testolife.test", name: "Sharmin Jahan", phone: "01700000208" },
  { role: "patient", email: "patient@testolife.test", name: "Abdur Rahim", phone: "01700000209" },
];

/** Idempotent: creates missing demo accounts, never touches existing ones. */
export const seedDemoUsers = async (password: string) => {
  const passwordHash = await hashPassword(password);
  let created = 0;
  for (const u of DEMO_USERS) {
    const result = await UserModel.updateOne(
      { email: u.email },
      { $setOnInsert: { ...u, passwordHash, isActive: true, mustChangePassword: false } },
      { upsert: true },
    );
    created += result.upsertedCount;
  }
  logger.info(`Demo users: ${created} created, ${DEMO_USERS.length - created} already existed`);
};

/** Users from the pre-Phase-2 template (no passwordHash, role "admin"/"user") cannot sign in any more. */
export const removeLegacyUsers = async () => {
  const { deletedCount } = await UserModel.collection.deleteMany({ passwordHash: { $exists: false } });
  if (deletedCount) logger.info(`Removed ${deletedCount} legacy user record(s) from the old user module`);
};
