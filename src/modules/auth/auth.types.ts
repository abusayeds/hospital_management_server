import type { Permission, Role } from "../../config/permissions";

// What `authenticate` attaches to req.user for the rest of the request
export type AuthUser = {
  id: string;
  name: string;
  email: string;
  role: Role;
  sessionId: string;
  mustChangePassword: boolean;
  permissions: readonly Permission[];
};
