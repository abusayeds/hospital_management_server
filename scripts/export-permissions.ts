// Usage: npm run shared:export   (alias: npm run permissions:export)
// Copies the files the browser must share with the API to the frontend, so menus,
// buttons and instant colour feedback use exactly the same rules as the server:
//   src/config/permissions.ts   → frontend/src/lib/permissions.ts
//   src/shared/clinical-rules.ts → frontend/src/lib/clinical-rules.ts
// Run it after changing either file (tests/unit/permissions.test.ts fails if you forget).
import fs from "fs";
import path from "path";

export const SHARED_FILES = [
  {
    source: path.join(__dirname, "../src/config/permissions.ts"),
    target: path.join(__dirname, "../../frontend/src/lib/permissions.ts"),
    label: "backend/src/config/permissions.ts",
  },
  {
    source: path.join(__dirname, "../src/shared/clinical-rules.ts"),
    target: path.join(__dirname, "../../frontend/src/lib/clinical-rules.ts"),
    label: "backend/src/shared/clinical-rules.ts",
  },
];

// Kept for the original permission test
export const SOURCE = SHARED_FILES[0].source;
export const TARGET = SHARED_FILES[0].target;

const header = (label: string) =>
  `// GENERATED FILE — do not edit. Source: ${label}\n` + "// Regenerate with `npm run shared:export` in backend/.\n\n";

// Line endings are normalised to LF so Windows (CRLF) checkouts compare equal
export const normalizeEol = (text: string) => text.replace(/\r\n/g, "\n");

export const buildCopy = (file: (typeof SHARED_FILES)[number]) =>
  header(file.label) + normalizeEol(fs.readFileSync(file.source, "utf8"));
export const buildFrontendCopy = () => buildCopy(SHARED_FILES[0]);

if (require.main === module) {
  for (const file of SHARED_FILES) {
    fs.writeFileSync(file.target, buildCopy(file));
    console.log(`Wrote ${path.relative(process.cwd(), file.target)}`);
  }
}
