import { env } from "../../../config/env";
import AppError from "../../../errors/AppError";
import { safeEqual } from "../../../utils/crypto";

// Kept apart from display.service so the socket layer can use it without importing the queue logic

export const isValidDisplayKey = (key: unknown): boolean => typeof key === "string" && key.length > 0 && safeEqual(key, env.QUEUE_DISPLAY_KEY);

export const assertDisplayKey = (key: unknown) => {
  if (!isValidDisplayKey(key)) throw new AppError(401, "This display is not authorised. Open it with the display key.", "UNAUTHORIZED");
};
