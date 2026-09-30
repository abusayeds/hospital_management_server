import fs from "fs";
import { buildFrontendCopy, TARGET } from "../../scripts/export-permissions";
import { PERMISSIONS, ROLE_PERMISSIONS, ROLES, roleHasPermission } from "../../src/config/permissions";

describe("permission map", () => {
  it("defines permissions for exactly the 9 roles", () => {
    expect(Object.keys(ROLE_PERMISSIONS).sort()).toEqual([...ROLES].sort());
    expect(ROLES).toHaveLength(9);
  });

  it("only uses permissions that are declared", () => {
    for (const perms of Object.values(ROLE_PERMISSIONS)) {
      for (const p of perms) expect(Object.keys(PERMISSIONS)).toContain(p);
    }
  });

  // Least privilege spot checks — these mirror the rules in PROJECT_CONTEXT.md
  it.each([
    ["reception", "prescription:create"],
    ["reception", "patient:read_full"],
    ["nurse", "prescription:create"],
    ["doctor", "bill:discount"],
    ["pharmacist", "lab_report:read"],
    ["pharmacist", "patient:read_full"],
    ["accounts", "patient:read_full"],
    ["accounts", "visit:read"],
    ["management", "visit:create"],
    ["management", "patient:update"],
    ["lab_technician", "lab_report:verify"],
    ["super_admin", "patient:read_full"],
    ["patient", "patient:read_basic"],
    ["patient", "user:manage"],
  ] as const)("%s cannot %s", (role, permission) => {
    expect(roleHasPermission(role, permission)).toBe(false);
  });

  it("only super_admin manages users and reads audit logs", () => {
    for (const role of ROLES) {
      expect(roleHasPermission(role, "user:manage")).toBe(role === "super_admin");
      expect(roleHasPermission(role, "audit:read")).toBe(role === "super_admin");
    }
  });

  it("frontend copy is in sync (run `npm run permissions:export` if this fails)", () => {
    expect(fs.readFileSync(TARGET, "utf8")).toBe(buildFrontendCopy());
  });
});
