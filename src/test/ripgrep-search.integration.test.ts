import * as assert from "assert";
import * as path from "path";
import * as child_process from "child_process";
import * as fs from "fs";
import {
  runRipgrep,
  searchWithRipgrep,
  RipgrepMatch,
} from "../utils/ripgrep-search";

describe("RipGrep Search Integration Tests", () => {
  const fixturesDir = path.join(__dirname, "fixtures");

  beforeAll(() => {
    try {
      child_process.execSync("rg --version", { encoding: "utf8" });
    } catch (err) {
      throw new Error("Ripgrep is not installed, skipping test");
    }
  });

  describe("runRipgrep", () => {
    it("can execute ripgrep and find string patterns", () => {
      const results = runRipgrep("TestWord1", fixturesDir);
      expect(results.length).toBeGreaterThan(0);

      // TestWord1 should be found in the testRipgrep.txt file
      const firstMatch = results[0];
      expect(firstMatch).toContain("testRipgrep.txt");
      expect(firstMatch).toContain("TestWord1");
    });

    it("returns empty array when no matches found", () => {
      const results = runRipgrep(
        "ThisShouldNotExistInAnyFile123456",
        fixturesDir
      );
      expect(results).toEqual([]);
    });

    it("can find multiple occurrences of a term", () => {
      const results = runRipgrep("test", fixturesDir);
      expect(results.length).toBeGreaterThan(1);

      // The word "test" should appear multiple times
      const joinedResults = results.join("\n");
      expect(joinedResults).toContain("test file");
    });
  });

  describe("searchWithRipgrep", () => {
    it("returns valid match objects for matches", async () => {
      const matches = await searchWithRipgrep("TestWord1", fixturesDir);
      expect(matches.length).toBeGreaterThan(0);

      // Check the first match
      const firstMatch = matches[0];
      expect(firstMatch.filePath.endsWith("testRipgrep.txt")).toBe(true);
      expect(firstMatch.lineNumber).toBeGreaterThanOrEqual(0);
      expect(firstMatch.columnNumber).toBeGreaterThanOrEqual(0);
      expect(firstMatch.matchText).toContain("TestWord1");
    });

    it("handles case-insensitive searches correctly", async () => {
      // Should find TestWord1 even when searching for lowercase
      const matches = await searchWithRipgrep("testword1", fixturesDir);
      expect(matches.length).toBeGreaterThan(0);

      // Find the match in our test file
      const testFileMatch = matches.find((m) =>
        m.filePath.endsWith("testRipgrep.txt")
      );
      expect(testFileMatch).toBeDefined();

      // Get the file content
      const fileContent = fs.readFileSync(testFileMatch!.filePath, "utf8");
      const lines = fileContent.split("\n");
      const line = lines[testFileMatch!.lineNumber];

      // Should find either "TestWord1" or "testword1" depending on the line matched
      expect(line).toContain("TestWord1");
    });

    it("can find phrases with spaces", async () => {
      const matches = await searchWithRipgrep("test file", fixturesDir);
      expect(matches.length).toBeGreaterThan(0);

      // Check that we found the phrase
      const match = matches.find((m) => m.filePath.endsWith("testRipgrep.txt"));
      expect(match).toBeDefined();

      expect(match!.matchText).toContain("test file");
    });

    it("returns empty array for non-existent terms", async () => {
      const matches = await searchWithRipgrep(
        "ThisShouldNotExistInAnyFile123456",
        fixturesDir
      );
      expect(matches).toEqual([]);
    });
  });
});
