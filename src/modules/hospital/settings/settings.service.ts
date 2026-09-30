import { Request } from "express";
import { env } from "../../../config/env";
import { serialize } from "../../../utils/serialize";
import { recordAudit } from "../../audit/audit.service";
import { HospitalSettingsModel, IHospitalSettings } from "./settings.model";

export type HospitalSettings = Omit<
  IHospitalSettings,
  "key" | "isDeleted" | "createdBy" | "updatedBy" | "deletedAt" | "deletedBy"
>;

// First run: start from the values in .env so nothing is blank
const defaults = (): HospitalSettings => ({
  name: env.HOSPITAL_NAME,
  nameBn: "টেস্টোলাইফ হাসপাতাল",
  address: env.HOSPITAL_ADDRESS,
  addressBn: "আরশিনগর, আমতলা, বসিলা ব্রিজের কাছে, কেরানীগঞ্জ, ঢাকা",
  phones: [],
  emergencyPhone: env.HOSPITAL_EMERGENCY_PHONE,
  openingHours: env.HOSPITAL_OPD_HOURS,
  openingHoursBn: "শনিবার–বৃহস্পতিবার, সকাল ৯টা – রাত ৯টা",
  bookingWindowDays: 14,
  cancellationCutoffMinutes: 60,
  defaultSlotMinutes: 10,
  displayNotice:
    "অনুগ্রহ করে আপনার সিরিয়াল নম্বরের জন্য অপেক্ষা করুন · Please wait for your serial number to be called",
  labFourEyes: true,
  assistantDailyAiBudget: 3000,
  assistantEmergencyKeywords: [],
  assistantTakeoverReminderMinutes: 5,
});

// Settings are read on every booking; cache them in memory and drop the cache on update.
let cache: HospitalSettings | null = null;
let loading: Promise<HospitalSettings> | null = null;

const loadSettings = async (): Promise<HospitalSettings> => {
  let doc;
  try {
    doc = await HospitalSettingsModel.findOneAndUpdate(
      { key: "default" },
      { $setOnInsert: { key: "default", ...defaults() } },
      { upsert: true, new: true },
    );
  } catch (err) {
    // Two processes created the document at the same moment: the unique index kept one; read it
    if ((err as { code?: number }).code !== 11000) throw err;
    doc = await HospitalSettingsModel.findOne({ key: "default" });
  }
  cache = serialize<HospitalSettings>(doc);
  return cache;
};

export const getSettings = (): Promise<HospitalSettings> => {
  if (cache) return Promise.resolve(cache);
  // Many requests arriving before the first load share ONE database round trip
  loading ??= loadSettings().finally(() => {
    loading = null;
  });
  return loading;
};

export const updateSettings = async (req: Request, input: Partial<HospitalSettings>) => {
  const before = await getSettings();
  const doc = await HospitalSettingsModel.findOneAndUpdate(
    { key: "default" },
    { $set: { ...input, updatedBy: req.user!.id } },
    { new: true, upsert: true, runValidators: true },
  );
  cache = serialize<HospitalSettings>(doc);
  await recordAudit({ req, action: "UPDATE", entityType: "HospitalSettings", before, after: cache });
  return cache;
};

/** Public subset — safe for the website, the TV screen and (Phase 5) the chatbot */
export const getPublicHospitalInfo = async () => {
  const s = await getSettings();
  return {
    name: s.name,
    nameBn: s.nameBn,
    address: s.address,
    addressBn: s.addressBn,
    phones: s.phones,
    emergencyPhone: s.emergencyPhone,
    email: s.email,
    openingHours: s.openingHours,
    openingHoursBn: s.openingHoursBn,
    logoUrl: s.logoUrl,
    bookingWindowDays: s.bookingWindowDays,
  };
};

/** Tests reset the cache between databases */
export const clearSettingsCache = () => {
  cache = null;
};
