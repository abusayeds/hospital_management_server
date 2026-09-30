import mongoose from "mongoose";
import AppError from "../../src/errors/AppError";
import { normalizeError } from "../../src/middlewares/globalErrorHandler";

describe("normalizeError", () => {
  it("invalid ObjectId (CastError) → 400 INVALID_ID", () => {
    const result = normalizeError(new mongoose.Error.CastError("ObjectId", "abc", "_id"));
    expect(result.statusCode).toBe(400);
    expect(result.code).toBe("INVALID_ID");
  });

  it("Mongo duplicate key (E11000) → 409 DUPLICATE_KEY without leaking the value", () => {
    const result = normalizeError({ code: 11000, keyValue: { phone: "01711111111" } });
    expect(result.statusCode).toBe(409);
    expect(result.code).toBe("DUPLICATE_KEY");
    expect(JSON.stringify(result)).not.toContain("01711111111");
  });

  it("AppError keeps its status, code and message", () => {
    expect(normalizeError(new AppError(404, "Doctor not found."))).toEqual({
      statusCode: 404,
      code: "NOT_FOUND",
      message: "Doctor not found.",
      details: undefined,
    });
  });

  it("unknown errors become 500 INTERNAL_ERROR", () => {
    const result = normalizeError(new Error("db exploded"));
    expect(result.statusCode).toBe(500);
    expect(result.code).toBe("INTERNAL_ERROR");
  });
});
