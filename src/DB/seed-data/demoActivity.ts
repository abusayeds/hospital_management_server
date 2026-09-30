/* eslint-disable @typescript-eslint/no-explicit-any */
import { CounterModel } from "../../models/counter.model";
import { AppointmentModel } from "../../modules/hospital/appointment/appointment.model";
import { DoctorModel } from "../../modules/hospital/doctor/doctor.model";
import { findLeave, sessionKeyOf, slotTimesOf } from "../../modules/hospital/scheduling/slotEngine";
import { normalizeName } from "../../modules/patients/patient.service";
import { PatientModel } from "../../modules/patients/patient.model";
import { addDays, nowMinutesInDhaka, todayInDhaka, toMinutes, weekdayOf } from "../../utils/date";
import { logger } from "../../utils/logger";

/**
 * DEMO ACTIVITY — 150 fictional patients, 30 days of history, a busy "today" and some
 * future bookings, so dashboards, queues and the TV look alive in a demo.
 * All names and numbers are invented. A seeded random generator makes every run
 * produce the same data. Runs only when the database has no patients yet.
 */

// ---------------------------------------------------------------- deterministic randomness
const rng = (() => {
  let a = 20260929;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
})();
const pick = <T>(list: readonly T[]): T => list[Math.floor(rng() * list.length)];
const chance = (p: number) => rng() < p;
const between = (min: number, max: number) => min + Math.floor(rng() * (max - min + 1));

// ---------------------------------------------------------------- names (English → Bangla)
const BN: Record<string, string> = {
  Md: "মো.",
  Abdul: "আব্দুল",
  Rahim: "রহিম",
  Karim: "করিম",
  Jamal: "জামাল",
  Kamal: "কামাল",
  Rafiq: "রফিক",
  Habib: "হাবিব",
  Nasir: "নাসির",
  Mizanur: "মিজানুর",
  Anisur: "আনিসুর",
  Faruk: "ফারুক",
  Shahidul: "শহিদুল",
  Monir: "মনির",
  Tareq: "তারেক",
  Sabbir: "সাব্বির",
  Rakib: "রাকিব",
  Imran: "ইমরান",
  Sohel: "সোহেল",
  Babul: "বাবুল",
  Jahid: "জাহিদ",
  Masud: "মাসুদ",
  Rashed: "রাশেদ",
  Fahim: "ফাহিম",
  Nayeem: "নাঈম",
  Riyad: "রিয়াদ",
  Shakil: "শাকিল",
  Gopal: "গোপাল",
  Sujon: "সুজন",
  Pradip: "প্রদীপ",
  Biplob: "বিপ্লব",
  Fatema: "ফাতেমা",
  Ayesha: "আয়েশা",
  Nasrin: "নাসরিন",
  Shirin: "শিরিন",
  Rokeya: "রোকেয়া",
  Salma: "সালমা",
  Rehana: "রেহানা",
  Parvin: "পারভীন",
  Jesmin: "জেসমিন",
  Sharmin: "শারমিন",
  Taslima: "তাসলিমা",
  Sumaiya: "সুমাইয়া",
  Tahmina: "তাহমিনা",
  Rumana: "রুমানা",
  Farzana: "ফারজানা",
  Shapla: "শাপলা",
  Moriom: "মরিয়ম",
  Hasina: "হাসিনা",
  Kulsum: "কুলসুম",
  Rabeya: "রাবেয়া",
  Jannatul: "জান্নাতুল",
  Mim: "মিম",
  Rina: "রিনা",
  Mitu: "মিতু",
  Shikha: "শিখা",
  Hossain: "হোসেন",
  Rahman: "রহমান",
  Islam: "ইসলাম",
  Ahmed: "আহমেদ",
  Uddin: "উদ্দিন",
  Mia: "মিয়া",
  Sarkar: "সরকার",
  Chowdhury: "চৌধুরী",
  Talukder: "তালুকদার",
  Mollah: "মোল্লা",
  Sheikh: "শেখ",
  Bhuiyan: "ভূঁইয়া",
  Akter: "আক্তার",
  Begum: "বেগম",
  Khatun: "খাতুন",
  Das: "দাস",
  Saha: "সাহা",
  Roy: "রায়",
  Paul: "পাল",
  Ferdous: "ফেরদৌস",
};
const MALE = [
  "Abdul",
  "Rahim",
  "Karim",
  "Jamal",
  "Kamal",
  "Rafiq",
  "Habib",
  "Nasir",
  "Mizanur",
  "Anisur",
  "Faruk",
  "Shahidul",
  "Monir",
  "Tareq",
  "Sabbir",
  "Rakib",
  "Imran",
  "Sohel",
  "Babul",
  "Jahid",
  "Masud",
  "Rashed",
  "Fahim",
  "Nayeem",
  "Riyad",
  "Shakil",
];
const FEMALE = [
  "Fatema",
  "Ayesha",
  "Nasrin",
  "Shirin",
  "Rokeya",
  "Salma",
  "Rehana",
  "Parvin",
  "Jesmin",
  "Sharmin",
  "Taslima",
  "Sumaiya",
  "Tahmina",
  "Rumana",
  "Farzana",
  "Shapla",
  "Moriom",
  "Hasina",
  "Kulsum",
  "Rabeya",
  "Jannatul",
  "Mim",
];
const SURNAMES = [
  "Hossain",
  "Rahman",
  "Islam",
  "Ahmed",
  "Uddin",
  "Mia",
  "Sarkar",
  "Chowdhury",
  "Talukder",
  "Mollah",
  "Sheikh",
  "Bhuiyan",
  "Ferdous",
];
const FEMALE_SURNAMES = ["Akter", "Begum", "Khatun", "Islam", "Rahman", "Chowdhury", "Ferdous"];
const HINDU = {
  male: ["Gopal", "Sujon", "Pradip", "Biplob"],
  female: ["Rina", "Mitu", "Shikha"],
  surnames: ["Das", "Saha", "Roy", "Paul"],
};
const AREAS = [
  "Arshinagar",
  "Amtola",
  "Aganagar",
  "Zinzira",
  "Kalindi",
  "Hasnabad",
  "Kholamora",
  "Shubhadya",
  "Ruhitpur",
  "Konda",
  "Tegharia",
];
const ALLERGIES = ["Penicillin", "Sulfa drugs", "Aspirin", "Seafood", "Dust"];
const CHRONIC = ["Diabetes", "Hypertension", "Asthma", "Hypothyroidism", "IHD", "CKD"];
const REASONS = [
  "Fever for 3 days",
  "Follow-up visit",
  "Headache",
  "Cough and cold",
  "Chest discomfort",
  "Back pain",
  "Skin rash",
  "Check-up",
  "Stomach pain",
  "Joint pain",
];

const makeName = (gender: "male" | "female") => {
  if (chance(0.08)) return `${pick(gender === "male" ? HINDU.male : HINDU.female)} ${pick(HINDU.surnames)}`;
  if (gender === "male") return `${chance(0.3) ? "Md " : ""}${pick(MALE)} ${pick(SURNAMES)}`;
  return `${pick(FEMALE)} ${pick(FEMALE_SURNAMES)}`;
};
const toBangla = (name: string) =>
  name.split(" ").every((w) => BN[w])
    ? name
        .split(" ")
        .map((w) => BN[w])
        .join(" ")
    : undefined;
const makePhone = () => `+880${pick(["13", "15", "16", "17", "18", "19"])}${String(between(10000000, 99999999))}`;

// ---------------------------------------------------------------- patients

const buildPatients = (count: number) => {
  const rows: any[] = [];
  let familyPhone: string | null = null;
  for (let i = 1; i <= count; i++) {
    const gender = chance(0.5) ? "male" : "female";
    const name = makeName(gender);
    // About 1 in 5 patients shares a phone with the previous one (family members)
    const phone: string = familyPhone && chance(0.2) ? familyPhone : makePhone();
    familyPhone = phone;
    const age = chance(0.15) ? between(1, 12) : between(18, 82);
    const dobKnown = chance(0.6);
    const today = todayInDhaka();
    rows.push({
      patientCode: `TL-${String(i).padStart(6, "0")}`,
      name,
      nameBn: toBangla(name),
      nameKey: normalizeName(name),
      gender,
      dateOfBirth: dobKnown
        ? new Date(Date.UTC(Number(today.slice(0, 4)) - age, between(0, 11), between(1, 28)))
        : new Date(Date.UTC(Number(today.slice(0, 4)) - age, 6, 1)),
      dobEstimated: !dobKnown,
      phone,
      address: { area: pick(AREAS), upazila: "Keraniganj", district: "Dhaka" },
      bloodGroup: chance(0.6) ? pick(["A+", "B+", "O+", "AB+", "A-", "B-", "O-"] as const) : undefined,
      allergies: chance(0.12) ? [pick(ALLERGIES)] : [],
      chronicConditions:
        age > 35 && chance(0.35)
          ? [pick(CHRONIC), ...(chance(0.3) ? [pick(CHRONIC)] : [])].filter((c, j, a) => a.indexOf(c) === j)
          : [],
      registrationSource: chance(0.1) ? "chatbot" : chance(0.1) ? "phone" : "reception",
      emergencyContact: chance(0.4)
        ? {
            name: makeName(chance(0.5) ? "male" : "female"),
            phone: makePhone(),
            relation: pick(["Son", "Daughter", "Wife", "Husband", "Brother", "Mother"]),
          }
        : undefined,
    });
  }
  return rows;
};

// ---------------------------------------------------------------- appointments

type Ctx = { patients: any[]; lastSeen: Map<string, string>; rows: any[]; counters: Map<string, number> };

const at = (date: string, time: string, plusMinutes = 0) =>
  new Date(new Date(`${date}T${time}:00+06:00`).getTime() + plusMinutes * 60000);

/** One doctor, one day: choose patients, assign slots and serials, set a realistic status */
const bookDay = (doctor: any, date: string, ctx: Ctx, mode: "past" | "today" | "future") => {
  if (findLeave(doctor.leaves ?? [], date)) return;
  const sessions = (doctor.sessions ?? []).filter((s: any) => s.dayOfWeek === weekdayOf(date));
  const now = nowMinutesInDhaka();
  const used = new Set<string>();

  for (const session of sessions) {
    const key = sessionKeyOf(session);
    const times = slotTimesOf(session);
    const capacity = Math.min(session.maxPatients, times.length);
    const count =
      mode === "future"
        ? between(1, Math.ceil(capacity * 0.35))
        : between(Math.ceil(capacity * 0.35), Math.ceil(capacity * 0.8));
    const chosenTimes = times.slice(0, count);
    const started = toMinutes(session.startTime) <= now;
    const ended = toMinutes(session.endTime) <= now;
    let inConsultationSet = false;

    chosenTimes.forEach((slotTime, i) => {
      let patient = pick(ctx.patients);
      for (let tries = 0; used.has(String(patient._id)) && tries < 20; tries++) patient = pick(ctx.patients);
      if (used.has(String(patient._id))) return;
      used.add(String(patient._id));

      const seenKey = `${patient._id}:${doctor._id}`;
      const last = ctx.lastSeen.get(seenKey);
      const followUp = Boolean(last && last >= addDays(date, -doctor.followUpValidDays));
      const serialNo = i + 1;

      // ---- status for this row
      let status: string;
      if (mode === "past") status = chance(0.07) ? "cancelled" : chance(0.08) ? "no_show" : "completed";
      else if (mode === "future") status = chance(0.05) ? "cancelled" : "booked";
      else if (ended) status = chance(0.08) ? "no_show" : "completed";
      else if (!started) status = chance(0.25) ? "checked_in" : "booked";
      else {
        // session in progress: the first ones are done, one is with the doctor, some wait, the rest are coming
        const progress = Math.max(0, Math.floor((now - toMinutes(session.startTime)) / 12));
        if (i < progress - 1) status = chance(0.1) ? "no_show" : "completed";
        else if (!inConsultationSet) {
          status = "in_consultation";
          inConsultationSet = true;
        } else status = i < progress + 5 ? "checked_in" : "booked";
      }

      const history: any[] = [{ status: "booked", at: at(addDays(date, -between(0, 5)), "10:00") }];
      const row: any = {
        patient: patient._id,
        doctor: doctor._id,
        department: doctor.department,
        date,
        slotTime,
        sessionKey: key,
        serialNo,
        type: followUp ? "follow_up" : "new",
        feeSnapshot: followUp ? doctor.followUpFee : doctor.consultationFee,
        source: chance(0.15) ? "chatbot" : chance(0.15) ? "walk_in" : chance(0.1) ? "phone" : "reception",
        status,
        priority: chance(0.06)
          ? "emergency"
          : patient.dateOfBirth && Number(date.slice(0, 4)) - patient.dateOfBirth.getUTCFullYear() >= 65 && chance(0.6)
            ? "elderly"
            : "normal",
        holdsSlot: ["booked", "checked_in", "in_consultation"].includes(status),
        notes: chance(0.3) ? pick(REASONS) : undefined,
      };
      if (["checked_in", "in_consultation", "completed"].includes(status)) {
        row.checkedInAt = at(date, slotTime, -between(5, 25));
        history.push({ status: "checked_in", at: row.checkedInAt });
      }
      if (["in_consultation", "completed"].includes(status)) {
        row.consultationStartedAt = row.calledAt = at(date, slotTime, between(0, 20));
        history.push({ status: "in_consultation", at: row.consultationStartedAt });
      }
      if (status === "completed") {
        row.completedAt = at(date, slotTime, between(22, 35));
        history.push({ status: "completed", at: row.completedAt });
        ctx.lastSeen.set(seenKey, date);
        patient.lastVisitDate = date;
      }
      if (status === "cancelled") {
        row.cancelledAt = at(date, "08:00", -between(60, 2000));
        row.cancelReason = pick(["Patient called to cancel", "Booked by mistake", "Doctor unavailable"]);
        row.holdsSlot = false;
        history.push({ status: "cancelled", at: row.cancelledAt, note: row.cancelReason });
      }
      if (status === "no_show") history.push({ status: "no_show", at: at(date, session.endTime) });
      row.statusHistory = history;
      ctx.rows.push(row);
      if (mode !== "past") ctx.counters.set(`serial:${date}:${doctor._id}:${key}`, serialNo);
    });
  }
};

export const seedDemoActivity = async () => {
  if ((await PatientModel.estimatedDocumentCount()) > 0) return;

  const patients = await PatientModel.insertMany(buildPatients(150));
  await CounterModel.updateOne({ _id: "patient" }, { $max: { seq: patients.length } }, { upsert: true });

  const doctors = await DoctorModel.find({ isActive: true });
  const today = todayInDhaka();
  const ctx: Ctx = { patients, lastSeen: new Map(), rows: [], counters: new Map() };
  for (let d = 30; d >= 1; d--) for (const doctor of doctors) bookDay(doctor, addDays(today, -d), ctx, "past");
  for (const doctor of doctors) bookDay(doctor, today, ctx, "today");
  for (let d = 1; d <= 7; d++)
    for (const doctor of doctors) if (chance(0.7)) bookDay(doctor, addDays(today, d), ctx, "future");

  await AppointmentModel.insertMany(ctx.rows, { ordered: false });
  // Serial counters continue from the seeded bookings, so the next real booking gets the next number
  await CounterModel.bulkWrite(
    [...ctx.counters].map(([id, seq]) => ({
      updateOne: { filter: { _id: id }, update: { $max: { seq } }, upsert: true },
    })),
  );
  await PatientModel.bulkWrite(
    patients
      .filter((p: any) => p.lastVisitDate)
      .map((p: any) => ({
        updateOne: { filter: { _id: p._id }, update: { $set: { lastVisitDate: p.lastVisitDate } } },
      })),
  );
  logger.info(
    `Demo activity: ${patients.length} patients, ${ctx.rows.length} appointments (30 days history, today, next 7 days)`,
  );
};
