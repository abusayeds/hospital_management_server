import { TNormalizedError } from "../interface/error";

type MongoDuplicateKeyError = { code: 11000; keyValue?: Record<string, unknown> };

// MongoDB unique index violation (E11000), e.g. registering the same email twice
const handleDuplicateError = (err: MongoDuplicateKeyError): TNormalizedError => {
  const fields = Object.keys(err.keyValue ?? {});
  const label = fields.join(", ") || "value";
  return {
    statusCode: 409,
    code: "DUPLICATE_KEY",
    message: `A record with this ${label} already exists.`,
    // Report which field clashed, but not the value (it may be personal data)
    details: fields.map((path) => ({ path, message: "already exists" })),
  };
};

export default handleDuplicateError;
