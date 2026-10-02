import mongoose, { HydratedDocument, Model, Schema, Types } from "mongoose";
import { DATE_PATTERN } from "../../utils/date";

/**
 * PHARMACY
 *
 *   MedicineBatch  — one delivery of one medicine: batch no., expiry, units left, cost and selling price.
 *                    Stock of a medicine = the sum of its unexpired batches. Dispensing takes units from
 *                    the batch that expires first (FEFO); expired batches are never dispensed.
 *   StockMovement  — every change of a batch (purchase, dispense, adjustment, write-off): the audit trail
 *                    that explains today's quantity. Append-only.
 *   Purchase       — a supplier delivery; saving it receives the stock (creates the batches).
 *   Dispense       — medicines handed over against a prescription (or a counter sale); creates the bill.
 *
 * Money is in poisha (integer). Quantities are whole units (tablets, bottles, tubes …).
 */

// ------------------------------------------------------------------ batch

export interface IMedicineBatch {
  medicine: Types.ObjectId;
  batchNo: string;
  expiryDate: string; // YYYY-MM-DD
  quantity: number; // units left
  initialQuantity: number;
  unitCost: number; // poisha, what we paid
  unitPrice: number; // poisha, what the patient pays (MRP)
  purchase: Types.ObjectId | null;
  supplier: string;
  receivedAt: Date;
  writtenOff: boolean; // expired / damaged stock removed from sale
}
export type MedicineBatchDocument = HydratedDocument<IMedicineBatch>;

const MedicineBatchSchema = new Schema<IMedicineBatch>(
  {
    medicine: { type: Schema.Types.ObjectId, ref: "Medicine", required: true },
    batchNo: { type: String, required: true, trim: true, maxlength: 60 },
    expiryDate: { type: String, required: true, match: DATE_PATTERN },
    quantity: { type: Number, required: true, min: 0 },
    initialQuantity: { type: Number, required: true, min: 0 },
    unitCost: { type: Number, required: true, min: 0 },
    unitPrice: { type: Number, required: true, min: 0 },
    purchase: { type: Schema.Types.ObjectId, ref: "Purchase", default: null },
    supplier: { type: String, trim: true, maxlength: 120, default: "" },
    receivedAt: { type: Date, required: true },
    writtenOff: { type: Boolean, default: false },
  },
  { timestamps: true, optimisticConcurrency: true },
);
// FEFO lookups and the expiry report
MedicineBatchSchema.index({ medicine: 1, expiryDate: 1 });
MedicineBatchSchema.index({ expiryDate: 1, quantity: 1 });

export const MedicineBatchModel: Model<IMedicineBatch> =
  mongoose.models.MedicineBatch || mongoose.model<IMedicineBatch>("MedicineBatch", MedicineBatchSchema);

// ------------------------------------------------------------------ movement

export const MOVEMENT_TYPES = ["purchase", "dispense", "adjust", "write_off", "return"] as const;
export type MovementType = (typeof MOVEMENT_TYPES)[number];

export interface IStockMovement {
  medicine: Types.ObjectId;
  batch: Types.ObjectId;
  type: MovementType;
  quantity: number; // + in, − out
  balanceAfter: number; // units left in the batch after this movement
  reason: string;
  ref: { type: "purchase" | "dispense" | null; id: Types.ObjectId | null };
  by: Types.ObjectId | null;
  at: Date;
}

const StockMovementSchema = new Schema<IStockMovement>({
  medicine: { type: Schema.Types.ObjectId, ref: "Medicine", required: true },
  batch: { type: Schema.Types.ObjectId, ref: "MedicineBatch", required: true },
  type: { type: String, enum: MOVEMENT_TYPES, required: true },
  quantity: { type: Number, required: true },
  balanceAfter: { type: Number, required: true },
  reason: { type: String, trim: true, maxlength: 200, default: "" },
  ref: {
    type: { type: String, enum: ["purchase", "dispense", null], default: null },
    id: { type: Schema.Types.ObjectId, default: null },
  },
  by: { type: Schema.Types.ObjectId, ref: "User", default: null },
  at: { type: Date, required: true },
});
StockMovementSchema.index({ medicine: 1, at: -1 });
StockMovementSchema.index({ type: 1, at: -1 });

export const StockMovementModel: Model<IStockMovement> =
  mongoose.models.StockMovement || mongoose.model<IStockMovement>("StockMovement", StockMovementSchema);

// ------------------------------------------------------------------ purchase

export interface IPurchaseLine {
  medicine: Types.ObjectId;
  description: string; // "Napa 500 mg tablet" snapshot
  batchNo: string;
  expiryDate: string;
  quantity: number;
  unitCost: number;
  unitPrice: number;
  lineTotal: number; // quantity × unitCost
  batch: Types.ObjectId | null;
}
export interface IPurchase {
  purchaseNo: string; // PUR-000001
  supplier: string;
  supplierInvoiceNo: string;
  date: string;
  items: IPurchaseLine[];
  total: number;
  notes: string;
  receivedBy: Types.ObjectId | null;
}

const PurchaseSchema = new Schema<IPurchase>(
  {
    purchaseNo: { type: String, required: true, unique: true },
    supplier: { type: String, required: true, trim: true, maxlength: 120 },
    supplierInvoiceNo: { type: String, trim: true, maxlength: 60, default: "" },
    date: { type: String, required: true, match: DATE_PATTERN },
    items: [
      {
        _id: false,
        medicine: { type: Schema.Types.ObjectId, ref: "Medicine", required: true },
        description: { type: String, required: true },
        batchNo: { type: String, required: true },
        expiryDate: { type: String, required: true, match: DATE_PATTERN },
        quantity: { type: Number, required: true, min: 1 },
        unitCost: { type: Number, required: true, min: 0 },
        unitPrice: { type: Number, required: true, min: 0 },
        lineTotal: { type: Number, required: true, min: 0 },
        batch: { type: Schema.Types.ObjectId, ref: "MedicineBatch", default: null },
      },
    ],
    total: { type: Number, required: true, min: 0 },
    notes: { type: String, trim: true, maxlength: 500, default: "" },
    receivedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
  },
  { timestamps: true },
);
PurchaseSchema.index({ date: -1 });
PurchaseSchema.index({ supplier: 1, date: -1 });

export const PurchaseModel: Model<IPurchase> =
  mongoose.models.Purchase || mongoose.model<IPurchase>("Purchase", PurchaseSchema);

// ------------------------------------------------------------------ dispense

export interface IDispenseLine {
  medicine: Types.ObjectId;
  description: string;
  prescribedIndex: number | null; // which prescription line this fills (null = added at the counter)
  quantity: number;
  unitPrice: number;
  lineTotal: number;
  batches: { batch: Types.ObjectId; batchNo: string; expiryDate: string; quantity: number; unitPrice: number }[];
}
export interface IDispense {
  dispenseNo: string; // DSP-000001
  patient: Types.ObjectId;
  visit: Types.ObjectId | null;
  prescriptionNo: string | null;
  date: string;
  items: IDispenseLine[];
  total: number;
  notes: string;
  dispensedBy: Types.ObjectId | null;
  dispensedAt: Date;
}

const DispenseSchema = new Schema<IDispense>(
  {
    dispenseNo: { type: String, required: true, unique: true },
    patient: { type: Schema.Types.ObjectId, ref: "Patient", required: true },
    visit: { type: Schema.Types.ObjectId, ref: "Visit", default: null },
    prescriptionNo: { type: String, default: null },
    date: { type: String, required: true, match: DATE_PATTERN },
    items: [
      {
        _id: false,
        medicine: { type: Schema.Types.ObjectId, ref: "Medicine", required: true },
        description: { type: String, required: true },
        prescribedIndex: { type: Number, default: null },
        quantity: { type: Number, required: true, min: 1 },
        unitPrice: { type: Number, required: true, min: 0 },
        lineTotal: { type: Number, required: true, min: 0 },
        batches: [
          {
            _id: false,
            batch: { type: Schema.Types.ObjectId, ref: "MedicineBatch", required: true },
            batchNo: String,
            expiryDate: String,
            quantity: Number,
            unitPrice: Number, // poisha — batches of one medicine may be priced differently
          },
        ],
      },
    ],
    total: { type: Number, required: true, min: 0 },
    notes: { type: String, trim: true, maxlength: 500, default: "" },
    dispensedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    dispensedAt: { type: Date, required: true },
  },
  { timestamps: true },
);
DispenseSchema.index({ visit: 1 });
DispenseSchema.index({ patient: 1, date: -1 });
DispenseSchema.index({ date: -1 });

export const DispenseModel: Model<IDispense> =
  mongoose.models.Dispense || mongoose.model<IDispense>("Dispense", DispenseSchema);
