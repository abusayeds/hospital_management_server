import express, { Request, Response } from "express";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import validateRequest from "../middlewares/validateRequest";
import catchAsync from "../utils/catchAsync";
import sendResponse from "../utils/sendResponse";
import { verifyDocumentCode } from "./signing";

/**
 * PUBLIC DOCUMENT CHECK — the page a QR code opens (no login).
 * A pharmacist or another hospital scans the paper and sees whether it is genuine.
 * It shows only what is printed anyway, with the patient's name masked: never the
 * phone, address, diagnosis or medicines.
 */

export type VerifiedDocument = {
  type: "prescription" | "lab_report";
  number: string;
  date: string;
  issuedBy: string; // doctor / lab
  patient: string; // masked, e.g. "R**** A****"
  patientAge: number | null;
  signedAt: Date | null;
  corrections: number; // addenda after signing
};

type Resolver = (documentNo: string) => Promise<VerifiedDocument | null>;
const resolvers = new Map<string, Resolver>();

/** Each document type registers how to look up its number, by prefix ("RX", "LAB") */
export const registerDocumentResolver = (prefix: string, resolve: Resolver) => resolvers.set(prefix, resolve);

export const maskName = (name: string) =>
  name
    .trim()
    .split(/\s+/)
    .map((w) => `${w[0]}${"*".repeat(Math.max(2, w.length - 1))}`)
    .join(" ");

const verify = catchAsync(async (req: Request, res: Response) => {
  const documentNo = verifyDocumentCode(req.params.code);
  const resolve = documentNo ? resolvers.get(documentNo.split("-")[0]) : undefined;
  const doc = documentNo && resolve ? await resolve(documentNo) : null;
  sendResponse(res, {
    statusCode: 200,
    success: true,
    message: doc ? "Genuine document" : "This code does not match any document issued by the hospital",
    data: doc ? { valid: true, ...doc } : { valid: false },
  });
});

// Stops anyone from guessing codes quickly
const limiter = rateLimit({ windowMs: 60_000, limit: 30, standardHeaders: "draft-8", legacyHeaders: false });

const router = express.Router();
router.get(
  "/:code",
  limiter,
  validateRequest(z.object({ params: z.object({ code: z.string().trim().min(5).max(80) }) })),
  verify,
);

export const VerifyRoutes = router;
