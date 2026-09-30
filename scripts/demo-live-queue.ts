// Usage: npm run demo:live
// DEMO HELPER (development only). Seeded "today" follows the real clock, so late in the
// evening every session is over and the queues are empty. Before a live demo this puts a
// few doctors' queues "in progress" again: for each, the last patients of today become
// 1 in consultation, 4 waiting (checked in) and 3 not arrived — so the reception board,
// the doctor's queue and the waiting-room TV all have something to show.
import mongoose from "mongoose";
import { env } from "../src/config/env";
import { connectDatabase, disconnectDatabase } from "../src/config/database";
import { AppointmentModel } from "../src/modules/hospital/appointment/appointment.model";
import { DoctorModel } from "../src/modules/hospital/doctor/doctor.model";
import { todayInDhaka } from "../src/utils/date";
import { logger } from "../src/utils/logger";

const DOCTORS = 4;

const run = async () => {
  if (env.NODE_ENV === "production") throw new Error("demo:live is disabled in production");
  await connectDatabase();
  const date = todayInDhaka();
  const now = Date.now();

  // Doctors with the most appointments today (the demo doctor first if they sit today)
  const busiest = await AppointmentModel.aggregate<{ _id: mongoose.Types.ObjectId; n: number }>([
    { $match: { date, status: { $ne: "cancelled" } } },
    { $group: { _id: "$doctor", n: { $sum: 1 } } },
    { $sort: { n: -1 } },
  ]);
  const demoDoctor = await DoctorModel.findOne({ user: { $ne: null } }, { _id: 1 });
  const ids = busiest.map((b) => String(b._id));
  const chosen = [...new Set([...(demoDoctor && ids.includes(String(demoDoctor._id)) ? [String(demoDoctor._id)] : []), ...ids])].slice(0, DOCTORS);
  if (!chosen.length) {
    logger.warn("No appointments today — run `npm run seed:reset` first (on a day the doctors sit).");
    return;
  }

  for (const doctorId of chosen) {
    const rows = await AppointmentModel.find({ doctor: doctorId, date, status: { $in: ["completed", "no_show", "checked_in", "in_consultation", "booked"] } }).sort({ slotTime: -1 }).limit(8);
    const plan = ["booked", "booked", "booked", "checked_in", "checked_in", "checked_in", "checked_in", "in_consultation"] as const;
    for (const [i, appt] of rows.entries()) {
      const status = plan[i];
      const minutesAgo = (plan.length - i) * 6;
      appt.set({
        status,
        holdsSlot: true,
        completedAt: null,
        consultationStartedAt: status === "in_consultation" ? new Date(now - 4 * 60000) : null,
        calledAt: status === "in_consultation" ? new Date(now - 4 * 60000) : null,
        checkedInAt: status === "booked" ? null : new Date(now - minutesAgo * 60000),
        priority: i === 4 ? "elderly" : i === 5 && appt.priority === "emergency" ? "emergency" : appt.priority === "emergency" ? "normal" : appt.priority,
        statusHistory: [
          { status: "booked", at: new Date(now - 86_400_000) },
          ...(status === "booked" ? [] : [{ status: "checked_in", at: new Date(now - minutesAgo * 60000) }]),
          ...(status === "in_consultation" ? [{ status: "in_consultation", at: new Date(now - 4 * 60000) }] : []),
        ],
      });
      await appt.save();
    }
    const doctor = await DoctorModel.findById(doctorId, { title: 1, name: 1 });
    logger.info(`Live queue ready: ${doctor?.title} ${doctor?.name} (${rows.length} patients)`);
  }
};

run()
  .catch((err) => {
    logger.error({ err }, "demo:live failed");
    process.exitCode = 1;
  })
  .finally(() => disconnectDatabase());
