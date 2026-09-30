/* eslint-disable @typescript-eslint/no-explicit-any */
import express, { Request, Response } from "express";
import { z } from "zod";
import { authenticate } from "../../../middlewares/authenticate";
import { requireAnyPermission, requirePermission } from "../../../middlewares/authorize";
import validateRequest from "../../../middlewares/validateRequest";
import catchAsync from "../../../utils/catchAsync";
import { addDays, DATE_PATTERN, startOfDhakaDay, todayInDhaka } from "../../../utils/date";
import sendResponse from "../../../utils/sendResponse";
import { ChatSessionModel } from "../../ai/chat/chat.model";
import { AppointmentModel } from "../appointment/appointment.model";
import { getTodayBoard } from "../queue/queue.service";

const toCountMap = (rows: { _id: string; count: number }[]) => Object.fromEntries(rows.map((r) => [r._id, r.count]));

/**
 * "Today at a glance" — counts only, no patient details, so every operational role can
 * see it (reception, doctors, nurses, management, admin). Full analytics come in Phase 7.
 */
export const getToday = async (date = todayInDhaka()) => {
  const [facets] = await AppointmentModel.aggregate([
    { $match: { date } },
    {
      $facet: {
        byStatus: [{ $group: { _id: "$status", count: { $sum: 1 } } }],
        bySource: [{ $match: { status: { $ne: "cancelled" } } }, { $group: { _id: "$source", count: { $sum: 1 } } }],
        byDepartment: [
          { $match: { status: { $ne: "cancelled" } } },
          { $group: { _id: "$department", count: { $sum: 1 } } },
          { $lookup: { from: "departments", localField: "_id", foreignField: "_id", as: "dept" } },
          { $project: { _id: 0, department: { $first: "$dept.name" }, count: 1 } },
          { $sort: { count: -1 } },
        ],
        // Minutes from check-in until the doctor called the patient
        wait: [
          { $match: { checkedInAt: { $ne: null }, consultationStartedAt: { $ne: null } } },
          {
            $group: {
              _id: null,
              avg: { $avg: { $divide: [{ $subtract: ["$consultationStartedAt", "$checkedInAt"] }, 60000] } },
              n: { $sum: 1 },
            },
          },
        ],
      },
    },
  ]);
  const byStatus = toCountMap(facets.byStatus);
  const board = await getTodayBoard();
  const total = Object.values(byStatus).reduce((s: number, n) => s + (n as number), 0);
  return {
    date,
    total,
    booked: byStatus.booked ?? 0,
    waiting: byStatus.checked_in ?? 0,
    inConsultation: byStatus.in_consultation ?? 0,
    completed: byStatus.completed ?? 0,
    cancelled: byStatus.cancelled ?? 0,
    noShow: byStatus.no_show ?? 0,
    checkedInTotal: (byStatus.checked_in ?? 0) + (byStatus.in_consultation ?? 0) + (byStatus.completed ?? 0),
    bySource: toCountMap(facets.bySource),
    byDepartment: facets.byDepartment,
    averageWaitMinutes: facets.wait[0] ? Math.round(facets.wait[0].avg) : null,
    doctorsSittingToday: board.filter((d) => d.sitsToday).length,
    doctorsInSessionNow: board.filter((d) => d.inSessionNow || d.currentSerial !== null).length,
    doctors: board,
  };
};

/** Management live overview: today plus a 7-day trend, fees and assistant usage */
const getStats = async (date: string) => {
  const weekStart = addDays(date, -6);
  const [facets] = await AppointmentModel.aggregate([
    { $match: { date: { $gte: weekStart, $lte: date } } },
    {
      $facet: {
        byStatus: [{ $match: { date } }, { $group: { _id: "$status", count: { $sum: 1 } } }],
        bySource: [{ $match: { date } }, { $group: { _id: "$source", count: { $sum: 1 } } }],
        byDepartment: [
          { $match: { date, status: { $ne: "cancelled" } } },
          { $group: { _id: "$department", count: { $sum: 1 } } },
          { $lookup: { from: "departments", localField: "_id", foreignField: "_id", as: "dept" } },
          { $project: { _id: 0, department: { $first: "$dept.name" }, count: 1 } },
          { $sort: { count: -1 } },
        ],
        // Fees in poisha (feeSnapshot): expected for everyone not cancelled / no-show, "seen" for completed
        revenue: [
          { $match: { date, status: { $nin: ["cancelled", "no_show"] } } },
          {
            $group: {
              _id: null,
              expected: { $sum: "$feeSnapshot" },
              collected: { $sum: { $cond: [{ $eq: ["$status", "completed"] }, "$feeSnapshot", 0] } },
            },
          },
        ],
        last7Days: [
          { $match: { status: { $ne: "cancelled" } } },
          { $group: { _id: "$date", count: { $sum: 1 } } },
          { $sort: { _id: 1 } },
        ],
      },
    },
  ]);

  const dayStart = startOfDhakaDay(date);
  const dayEnd = startOfDhakaDay(addDays(date, 1));
  const [chatSessions, emergencies, pendingHandoffs] = await Promise.all([
    ChatSessionModel.countDocuments({ createdAt: { $gte: dayStart, $lt: dayEnd } }),
    ChatSessionModel.countDocuments({ emergency: true, updatedAt: { $gte: dayStart, $lt: dayEnd } }),
    ChatSessionModel.countDocuments({ needsHuman: true }),
  ]);

  const byStatus = toCountMap(facets.byStatus);
  const bySource = toCountMap(facets.bySource);
  const total = facets.byStatus.reduce((sum: number, r: any) => sum + r.count, 0);
  const perDay = toCountMap(facets.last7Days);

  return {
    date,
    appointments: {
      total,
      byStatus,
      bySource,
      noShowRate: total ? Math.round(((byStatus.no_show ?? 0) / total) * 100) : 0,
    },
    byDepartment: facets.byDepartment,
    revenue: facets.revenue[0]
      ? { expected: facets.revenue[0].expected, collected: facets.revenue[0].collected }
      : { expected: 0, collected: 0 },
    ai: { chatSessions, bookingsByAi: bySource.chatbot ?? 0, emergencies, pendingHandoffs },
    last7Days: Array.from({ length: 7 }, (_, i) => {
      const d = addDays(weekStart, i);
      return { date: d, count: perDay[d] ?? 0 };
    }),
  };
};

const dateQuery = z.object({ query: z.object({ date: z.string().regex(DATE_PATTERN, "use YYYY-MM-DD").optional() }) });

const router = express.Router();
router.use(authenticate());
router.get(
  "/today",
  requireAnyPermission(["appointment:read", "report:operations"]),
  catchAsync(async (_req: Request, res: Response) => {
    sendResponse(res, { statusCode: 200, success: true, message: "Today at a glance", data: await getToday() });
  }),
);
router.get(
  "/stats",
  requirePermission("report:operations"),
  validateRequest(dateQuery),
  catchAsync(async (req: Request, res: Response) => {
    const date = (req.query.date as string) || todayInDhaka();
    sendResponse(res, { statusCode: 200, success: true, message: "Dashboard stats", data: await getStats(date) });
  }),
);

export const DashboardRoutes = router;
