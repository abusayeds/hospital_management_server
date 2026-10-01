import { z } from "zod";
import { makeCatalog } from "./catalog.factory";
import { LabTestModel, MEDICINE_FORMS, MedicineModel, SERVICE_CATEGORIES, ServiceModel } from "./catalog.models";

// Money in the API is integer poisha (৳500 = 50000)
const poisha = z.number().int().min(0).max(100_000_000);

export const serviceCatalog = makeCatalog({
  model: ServiceModel,
  entityType: "Service",
  searchFields: ["name", "nameBn"],
  sort: { category: 1, name: 1 },
  createBody: z.object({
    name: z.string().trim().min(2).max(120),
    nameBn: z.string().trim().max(120).optional(),
    category: z.enum(SERVICE_CATEGORIES),
    price: poisha,
    isActive: z.boolean().optional(),
  }),
  extraListQuery: { category: z.enum(SERVICE_CATEGORIES).optional() },
  readPermissions: ["bill:read"],
  managePermission: "master_data:manage",
});

const labParameter = z.object({
  name: z.string().trim().min(1).max(80),
  unit: z.string().trim().max(30).optional(),
  normalMin: z.number().nullable().optional(),
  normalMax: z.number().nullable().optional(),
  normalText: z.string().trim().max(80).optional(),
});

export const labTestCatalog = makeCatalog({
  model: LabTestModel,
  entityType: "LabTest",
  searchFields: ["name", "code", "category"],
  sort: { category: 1, name: 1 },
  createBody: z.object({
    name: z.string().trim().min(2).max(150),
    code: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^[A-Z0-9-]{2,20}$/, "2–20 letters, numbers or dashes"),
    category: z.string().trim().min(2).max(60),
    price: poisha,
    sampleType: z.string().trim().min(2).max(60),
    preparationNote: z.string().trim().max(300).optional(),
    preparationNoteBn: z.string().trim().max(300).optional(),
    turnaroundHours: z
      .number()
      .int()
      .min(0)
      .max(24 * 30),
    parameters: z
      .array(labParameter)
      .max(60)
      .refine(
        (ps) => ps.every((p) => p.normalMin == null || p.normalMax == null || p.normalMin <= p.normalMax),
        "normalMin must not exceed normalMax",
      )
      .default([]),
    isActive: z.boolean().optional(),
  }),
  extraListQuery: { category: z.string().trim().max(60).optional() },
  // bill:collect: the cash counter adds tests to a counter bill (prices from the catalogue)
  readPermissions: ["lab_order:read", "lab_order:create", "bill:collect"],
  managePermission: "master_data:manage",
});

export const medicineCatalog = makeCatalog({
  model: MedicineModel,
  entityType: "Medicine",
  searchFields: ["brandName", "genericName", "manufacturer"],
  sort: { brandName: 1 },
  createBody: z.object({
    genericName: z.string().trim().min(2).max(150),
    brandName: z.string().trim().min(1).max(150),
    strength: z.string().trim().max(60).optional(),
    form: z.enum(MEDICINE_FORMS),
    manufacturer: z.string().trim().max(120).optional(),
    isActive: z.boolean().optional(),
  }),
  extraListQuery: { form: z.enum(MEDICINE_FORMS).optional() },
  readPermissions: ["prescription:create", "prescription:read_medication", "stock:read"],
  managePermission: "master_data:manage",
});
