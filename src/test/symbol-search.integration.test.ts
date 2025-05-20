import * as assert from "assert";
import * as path from "path";
import * as child_process from "child_process";
import {
  runRipgrep,
  findSymbols,
  symbolPatterns,
} from "../utils/symbol-search";

// This is an integration test that actually runs ripgrep against test fixtures
// It depends on ripgrep being installed in the system

describe("Symbol Search Integration Tests", () => {
  const fixturesDir = path.join(__dirname, "fixtures");
  let ripgrepAvailable = false;

  // Check if ripgrep is available
  beforeAll(() => {
    try {
      child_process.execSync("rg --version", { encoding: "utf8" });
      ripgrepAvailable = true;
    } catch (err) {
      console.warn("Ripgrep (rg) not available, skipping integration tests");
    }
  });

  // Skip all tests if ripgrep is not available
  beforeEach(() => {
    if (!ripgrepAvailable) {
      throw new Error("Ripgrep is not installed, skipping test");
    }
  });

  describe("runRipgrep", () => {
    it("can execute ripgrep and find class patterns", async () => {
      // Use the actual runRipgrep function with our test fixtures
      const results = await runRipgrep(
        [symbolPatterns.class.patterns[0]],
        symbolPatterns.class.exts,
        fixturesDir
      );

      // Verify that we found the expected classes
      assert.ok(
        results.length >= 2,
        "Expected to find at least 2 class declarations"
      );

      const joinedResults = results.join("\n");
      assert.ok(
        joinedResults.includes("TestClass") &&
          joinedResults.includes("PrivateClass"),
        "Should find TestClass and PrivateClass"
      );
    });

    it("can execute ripgrep and find function patterns", async () => {
      // Use the actual runRipgrep function with our test fixtures
      const results = await runRipgrep(
        symbolPatterns.function.patterns,
        symbolPatterns.function.exts,
        fixturesDir
      );

      // Verify that we found the expected functions
      assert.ok(
        results.length >= 2,
        "Expected to find at least 2 function declarations"
      );

      const joinedResults = results.join("\n");
      assert.ok(
        joinedResults.includes("testFunction") &&
          joinedResults.includes("privateFunction"),
        "Should find testFunction and privateFunction"
      );
    });

    it("can execute ripgrep and find React component patterns", async () => {
      // Use the actual runRipgrep function with our test fixtures
      const results = await runRipgrep(
        symbolPatterns.react.patterns,
        symbolPatterns.react.exts,
        fixturesDir
      );

      // Verify that we found the expected React components
      assert.ok(
        results.length >= 2,
        "Expected to find at least 2 React components"
      );

      const joinedResults = results.join("\n");
      assert.ok(
        joinedResults.includes("Button") &&
          joinedResults.includes("Card") &&
          joinedResults.includes("ClassComponent"),
        "Should find Button, Card and ClassComponent components"
      );
    });
  });

  describe("findSymbols with real ripgrep", () => {
    it("can find all symbols when type is 'all'", async () => {
      const symbols = await findSymbols("all", fixturesDir);
      const symbolsByType = symbols.reduce((acc, symbol) => {
        acc[symbol.type] = (acc[symbol.type] || 0) + 1;
        return acc;
      }, {} as Record<string, number>);

      assert.ok(symbolsByType.class >= 2, "Should find at least 2 classes");
      assert.ok(
        symbolsByType.function >= 5,
        "Should find at least 5 functions"
      );
      assert.ok(symbolsByType.type >= 2, "Should find at least 2 types");
      assert.ok(
        symbolsByType.interface >= 2,
        "Should find at least 2 interfaces"
      );
      assert.ok(symbolsByType.zod >= 1, "Should find at least 1 Zod schema");
    });

    it("can find 'class' symbols", async () => {
      const symbols = await findSymbols("class", fixturesDir);
      expect(symbols).toHaveLength(3);

      expect(symbols).toStrictEqual([
        {
          symbol: "TestClass",
          file: "./testClass.ts",
          line: 2,
          startColumn: 14,
          endColumn: 22,
          type: "class",
        },
        {
          symbol: "PrivateClass",
          file: "./testClass.ts",
          line: 10,
          startColumn: 7,
          endColumn: 18,
          type: "class",
        },
        {
          symbol: "ClassComponent",
          file: "./testReact.tsx",
          line: 30,
          startColumn: 14,
          endColumn: 27,
          type: "class",
        },
      ]);
    });

    it("can find 'function' symbols", async () => {
      const symbols = await findSymbols("function", fixturesDir);
      expect(symbols).toHaveLength(8);

      expect(symbols).toStrictEqual([
        {
          file: "./testReact.tsx",
          line: 9,
          symbol: "Card",
          type: "function",
          startColumn: 17,
          endColumn: 20,
        },
        {
          file: "./testReact.tsx",
          line: 24,
          symbol: "MemoComponent",
          type: "function",
          startColumn: 47,
          endColumn: 59,
        },
        {
          file: "./testFunction.ts",
          line: 2,
          symbol: "testFunction",
          type: "function",
          startColumn: 17,
          endColumn: 28,
        },
        {
          file: "./testFunction.ts",
          line: 6,
          symbol: "privateFunction",
          type: "function",
          startColumn: 10,
          endColumn: 24,
        },
        {
          file: "./testReact.tsx",
          line: 4,
          symbol: "Button",
          type: "function",
          startColumn: 14,
          endColumn: 19,
        },
        {
          file: "./testFunction.ts",
          line: 10,
          symbol: "arrowFunction",
          type: "function",
          startColumn: 7,
          endColumn: 19,
        },
        {
          file: "./testFunction.ts",
          line: 14,
          symbol: "asyncArrowFunction",
          type: "function",
          startColumn: 7,
          endColumn: 24,
        },
        {
          file: "./testFunction.ts",
          line: 18,
          symbol: "exportedArrow",
          type: "function",
          startColumn: 14,
          endColumn: 26,
        },
      ]);
    });

    it("can find 'type' symbols", async () => {
      const symbols = await findSymbols("type", fixturesDir);
      expect(symbols).toHaveLength(2);

      expect(symbols).toStrictEqual([
        {
          symbol: "User",
          file: "./testTypes.ts",
          line: 2,
          startColumn: 13,
          endColumn: 16,
          type: "type",
        },
        {
          symbol: "InternalConfig",
          file: "./testTypes.ts",
          line: 8,
          startColumn: 6,
          endColumn: 19,
          type: "type",
        },
      ]);
    });

    it("can find 'interface' symbols", async () => {
      const symbols = await findSymbols("interface", fixturesDir);
      expect(symbols).toHaveLength(2);

      expect(symbols).toStrictEqual([
        {
          symbol: "ApiResponse",
          file: "./testTypes.ts",
          line: 13,
          type: "interface",
          startColumn: 18,
          endColumn: 28,
        },
        {
          symbol: "PrivateInterface",
          file: "./testTypes.ts",
          line: 19,
          type: "interface",
          startColumn: 11,
          endColumn: 26,
        },
      ]);
    });

    it("can find 'zod' symbols", async () => {
      const symbols = await findSymbols("zod", fixturesDir);
      expect(symbols).toHaveLength(1);

      expect(symbols).toStrictEqual([
        {
          symbol: "UserSchema",
          file: "./testTypes.ts",
          line: 26,
          type: "zod",
          startColumn: 14,
          endColumn: 23,
        },
      ]);
    });

    it("can find 'react' symbols", async () => {
      const symbols = await findSymbols("react", fixturesDir);
      expect(symbols).toHaveLength(4);

      expect(symbols).toStrictEqual([
        {
          symbol: "Button",
          file: "./testReact.tsx",
          line: 4,
          type: "react",
          startColumn: 14,
          endColumn: 19,
        },
        {
          symbol: "Card",
          file: "./testReact.tsx",
          line: 9,
          type: "react",
          startColumn: 17,
          endColumn: 20,
        },
        {
          symbol: "MemoizedComponent",
          file: "./testReact.tsx",
          line: 24,
          type: "react",
          startColumn: 7,
          endColumn: 23,
        },
        {
          symbol: "ClassComponent",
          file: "./testReact.tsx",
          line: 30,
          type: "react",
          startColumn: 14,
          endColumn: 27,
        },
      ]);
    });

    it("can find 'methods' symbols", async () => {
      const symbols = await findSymbols("method", fixturesDir);
      expect(symbols).toHaveLength(3);

      expect(symbols).toStrictEqual([
        {
          symbol: "testMethod",
          file: "./testClass.ts",
          line: 5,
          type: "method",
          startColumn: 10,
          endColumn: 19,
        },
        {
          symbol: "factoryMethod",
          file: "./testClass.ts",
          line: 11,
          type: "method",
          startColumn: 10,
          endColumn: 22,
        },
        {
          symbol: "render",
          file: "./testReact.tsx",
          line: 31,
          type: "method",
          startColumn: 3,
          endColumn: 8,
        },
      ]);
    });

    it("can find 'variable' symbols", async () => {
      const symbols = await findSymbols("variable", fixturesDir);
      expect(symbols).toHaveLength(7);

      const indentedVariable = symbols.find(
        (symbol) => symbol.symbol === "indentedVariable"
      );

      expect(indentedVariable).toStrictEqual({
        symbol: "indentedVariable",
        file: "./testReact.tsx",
        line: 5,
        type: "variable",
        startColumn: 9,
        endColumn: 24,
      });
    });
  });
});
