import mongoose from "mongoose";
import { TNormalizedError } from "../interface/error";

// e.g. GET /doctors/not-an-id → Mongoose cannot cast "not-an-id" to ObjectId
const handleCastError = (err: mongoose.Error.CastError): TNormalizedError => ({
  statusCode: 400,
  code: "INVALID_ID",
  message: `Invalid value for "${err.path}".`,
  details: [{ path: err.path, message: `"${String(err.value)}" is not a valid ${err.kind}` }],
});

export default handleCastError;
