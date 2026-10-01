import express, { Request, Response } from "express";
import { z } from "zod";
import { authenticate } from "../../../middlewares/authenticate";
import { requireAnyPermission, requirePermission } from "../../../middlewares/authorize";
import validateRequest from "../../../middlewares/validateRequest";
import { TIME_PATTERN } from "../../../utils/date";
import catchAsync from "../../../utils/catchAsync";
import sendResponse from "../../../utils/sendResponse";
import { getPublicHospitalInfo, getSettings, updateSettings } from "./settings.service";

const phone = z.string().trim().min(3).max(20);

const updateSettingsSchema = z.object({
  body: z
    .object({
      name: z.string().trim().min(2).max(120),
      nameBn: z.string().trim().min(2).max(120),
      address: z.string().trim().min(5).max(300),
      addressBn: z.string().trim().max(300),
      phones: z.array(phone).max(6),
      emergencyPhone: phone,
      email: z.string().trim().email().or(z.literal("")),
      openingHours: z.string().trim().min(3).max(120),
      openingHoursBn: z.string().trim().max(120),
      logoUrl: z.string().trim().url().or(z.literal("")),
      bookingWindowDays: z.number().int().min(1).max(90),
      cancellationCutoffMinutes: z
        .number()
        .int()
        .min(0)
        .max(24 * 60),
      defaultSlotMinutes: z.number().int().min(5).max(120),
      displayNotice: z.string().trim().max(300),
      labFourEyes: z.boolean(),
      assistantDailyAiBudget: z.number().int().min(0).max(1_000_000),
      assistantEmergencyKeywords: z.array(z.string().trim().min(2).max(60)).max(100),
      assistantTakeoverReminderMinutes: z.number().int().min(1).max(120),
      automationPaused: z.boolean(),
      quietHoursStart: z.string().regex(TIME_PATTERN, "Use HH:mm"),
      quietHoursEnd: z.string().regex(TIME_PATTERN, "Use HH:mm"),
      messageNumerals: z.enum(["bn", "en"]),
      automationDailyBudget: z.number().int().min(0).max(100_000),
      perPhoneDailyCap: z.number().int().min(1).max(20),
      dedupeWindowMinutes: z
        .number()
        .int()
        .min(0)
        .max(24 * 60),
      smsFallbackEnabled: z.boolean(),
      failureAlertThreshold: z.number().int().min(1).max(1000),
    })
    .partial(),
});

// ---- staff: full settings
export const SettingsRoutes = express.Router();
SettingsRoutes.use(authenticate());
SettingsRoutes.get(
  "/",
  requireAnyPermission(["settings:manage", "doctor:read"]),
  catchAsync(async (_req: Request, res: Response) => {
    sendResponse(res, { statusCode: 200, success: true, message: "Hospital settings", data: await getSettings() });
  }),
);
SettingsRoutes.patch(
  "/",
  requirePermission("settings:manage"),
  validateRequest(updateSettingsSchema),
  catchAsync(async (req: Request, res: Response) => {
    sendResponse(res, {
      statusCode: 200,
      success: true,
      message: "Settings saved",
      data: await updateSettings(req, req.body),
    });
  }),
);

// ---- public: no login (website, TV, chatbot)
export const PublicRoutes = express.Router();
PublicRoutes.get(
  "/hospital-info",
  catchAsync(async (_req: Request, res: Response) => {
    sendResponse(res, {
      statusCode: 200,
      success: true,
      message: "Hospital info",
      data: await getPublicHospitalInfo(),
    });
  }),
);
