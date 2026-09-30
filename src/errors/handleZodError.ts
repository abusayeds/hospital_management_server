import { ZodError } from "zod";
import { TFieldError, TNormalizedError } from "../interface/error";

const handleZodError = (err: ZodError): TNormalizedError => {
  const details: TFieldError[] = err.issues.map((issue) => ({
    path: issue.path.join("."),
    message: issue.message,
  }));
  return { statusCode: 400, code: "VALIDATION_ERROR", message: "Some fields are missing or invalid.", details };
};

export default handleZodError;
