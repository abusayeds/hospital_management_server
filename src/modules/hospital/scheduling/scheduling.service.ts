/* eslint-disable @typescript-eslint/no-explicit-any */
import { ClientSession, Types } from "mongoose";
import AppError from "../../../errors/AppError";
import { addDays, isValidDateString, nowMinutesInDhaka, todayInDhaka } from "../../../utils/date";
import { DoctorModel } from "../doctor/doctor.model";
import { AppointmentModel } from "../appointment/appointment.model";
import { getSettings } from "../settings/settings.service";
import { computeDaySlots, DaySlots } from "./slotEngine";

export const loadActiveDoctor = async (doctorId: string, session?: ClientSession) => {
  if (!Types.ObjectId.isValid(doctorId)) throw new AppError(400, "Invalid doctor id.", "INVALID_ID");
  const doctor = await DoctorModel.findOne({ _id: doctorId, isActive: true })
    .populate("department", "name nameBn")
    .session(session ?? null);
  if (!doctor) throw new AppError(404, "Doctor not found or not currently active.");
  return doctor;
};

/** Throws a friendly 400 unless `date` is today..today+bookingWindowDays */
export const assertBookableDate = async (date: string) => {
  if (!isValidDateString(date)) throw new AppError(400, "Date must be in YYYY-MM-DD format.");
  const today = todayInDhaka();
  if (date < today) throw new AppError(400, `That date has passed. Today is ${today}.`);
  const { bookingWindowDays } = await getSettings();
  if (date > addDays(today, bookingWindowDays)) {
    throw new AppError(400, `Appointments can be booked up to ${bookingWindowDays} days ahead.`);
  }
};

/** Slot grid for one doctor on one date: schedule − leave − active bookings − past times */
export const getDaySlotsFor = async (doctor: any, date: string, session?: ClientSession): Promise<DaySlots> => {
  const bookings = await AppointmentModel.find(
    // holdsSlot = booked / checked_in / in_consultation (cancelled and no-show free the slot)
    { doctor: doctor._id, date, holdsSlot: true },
    { slotTime: 1, sessionKey: 1 },
  )
    .session(session ?? null)
    .lean<{ slotTime: string; sessionKey: string }[]>();

  return computeDaySlots({
    date,
    sessions: doctor.sessions,
    leaves: doctor.leaves,
    bookings,
    nowMinutes: date === todayInDhaka() ? nowMinutesInDhaka() : null,
  });
};

export const getDoctorSlots = async (doctorId: string, date: string) => {
  if (!isValidDateString(date)) throw new AppError(400, "Date must be in YYYY-MM-DD format.");
  const doctor = await loadActiveDoctor(doctorId);
  return getDaySlotsFor(doctor, date);
};

/** Next `days` dates with free slots — powers the date strip in the booking stepper */
export const getAvailabilityCalendar = async (doctorId: string, days: number) => {
  const doctor = await loadActiveDoctor(doctorId);
  const { bookingWindowDays } = await getSettings();
  const today = todayInDhaka();
  const result = [];
  for (let i = 0; i <= Math.min(days, bookingWindowDays); i++) {
    const date = addDays(today, i);
    const day = await getDaySlotsFor(doctor, date);
    result.push({
      date,
      onLeave: day.onLeave,
      leaveReason: day.leaveReason,
      sits: day.sessions.length > 0,
      availableCount: day.availableCount,
      nextAvailable: day.nextAvailable?.time ?? null,
    });
  }
  return result;
};
