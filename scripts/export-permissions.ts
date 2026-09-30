// Usage: npm run permissions:export
// Copies src/config/permissions.ts to the frontend so menus and buttons use the
// exact same rules as the API. Run it after every change to the permission map
// (tests/permissions-sync.test.ts fails if you forget).
import fs from "fs";
import path from "path";

export const SOURCE = path.join(__dirname, "../src/config/permissions.ts");
export const TARGET = path.join(__dirname, "../../frontend/src/lib/permissions.ts");
export const HEADER =
  "// GENERATED FILE — do not edit. Source: backend/src/config/permissions.ts\n" +
  "// Regenerate with `npm run permissions:export` in backend/.\n\n";

export const buildFrontendCopy = () => HEADER + fs.readFileSync(SOURCE, "utf8");

if (require.main === module) {
  fs.writeFileSync(TARGET, buildFrontendCopy());
  console.log(`Wrote ${path.relative(process.cwd(), TARGET)}`);
}
