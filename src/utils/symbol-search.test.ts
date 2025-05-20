import { getFirstIdentifier } from "./symbol-search";

describe("Symbol Search", () => {
  describe("extractSymbol", () => {
    it("should extract the symbol from a line", () => {
      const line = "const foo = 'test';";
      const symbol = getFirstIdentifier(line);

      expect(symbol).toBe("foo");
    });

    it("should return null if no identifier is found", () => {
      const line = "const;";
      const symbol = getFirstIdentifier(line);

      expect(symbol).toBeNull();
    });

    it("should return for a function", () => {
      const line = "function foo() { return 'test'; }";
      const symbol = getFirstIdentifier(line);

      expect(symbol).toBe("foo");
    });
  });
});
