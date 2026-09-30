import mongoose from "mongoose";
import { TFieldError, TNormalizedError } from "../interface/error";

// Mongoose schema validation (e.g. a required field missing on save)
const handleValidationError = (err: mongoose.Error.ValidationError): TNormalizedError => {
  const details: TFieldError[] = Object.values(err.errors).map((e) => ({
    path: e.path,
    message: e.message,
  }));
  return { statusCode: 400, code: "VALIDATION_ERROR", message: "Some fields are missing or invalid.", details };
};

export default handleValidationError;
