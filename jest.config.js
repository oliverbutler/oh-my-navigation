module.exports = {
  preset: "ts-jest",
  testEnvironment: "node",
  roots: ["<rootDir>/src"],
  testMatch: ["**/*.test.ts"],
  transform: {
    "^.+\\.tsx?$": "ts-jest",
  },
  moduleFileExtensions: ["ts", "tsx", "js", "jsx", "json", "node"],
  setupFilesAfterEnv: [],
  collectCoverage: true,
  collectCoverageFrom: ["src/**/*.ts", "!src/test/**", "!**/*.d.ts"],
  verbose: true,
  injectGlobals: true,
};
