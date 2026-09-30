import type { AuthUser } from "./modules/auth/auth.types";

declare global {
  namespace Express {
    interface Request {
      // Set by the authenticate middleware; undefined on public routes
      user?: AuthUser;
    }
  }
}

export {};
