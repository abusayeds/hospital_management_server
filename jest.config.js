/** Jest + ts-jest. API tests run against an in-memory MongoDB (never the real database). */
module.exports = {
  testEnvironment: "node",
  roots: ["<rootDir>/tests"],
  testMatch: ["**/*.test.ts"],
  // Transpile only (isolatedModules in tsconfig): type checking is `npm run typecheck`
  transform: { "^.+\\.ts$": ["ts-jest", { diagnostics: false }] },
  globalSetup: "<rootDir>/tests/setup/global-setup.ts",
  globalTeardown: "<rootDir>/tests/setup/global-teardown.ts",
  setupFiles: ["<rootDir>/tests/setup/test-env.ts"],
  // One file at a time: simpler logs and no contention on the in-memory server
  maxWorkers: 1,
  testTimeout: 30000,
};
