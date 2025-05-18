import * as vscode from "vscode";
import { RecencyTracker } from "../recencyTracker";

// Mock context to simulate ExtensionContext
class MockContext {
  public globalState = {
    get: jest.fn(),
    update: jest.fn().mockResolvedValue(undefined),
    keys: jest.fn() as unknown as () => readonly string[],
  };
  public workspaceState = {
    get: jest.fn(),
    update: jest.fn(),
    keys: jest.fn() as unknown as () => readonly string[],
  };
  public subscriptions: any[] = [];
}

describe("RecencyTracker", () => {
  let mockContext: vscode.ExtensionContext;
  let tracker: RecencyTracker;

  beforeEach(() => {
    // Set up mocks
    mockContext = new MockContext() as unknown as vscode.ExtensionContext;
    (mockContext.globalState.get as jest.Mock).mockReturnValue({});
    tracker = new RecencyTracker(mockContext);
  });

  test("load should fetch data from storage", async () => {
    const mockData = {
      "/path/to/file#symbolName": {
        path: "/path/to/file",
        lastAccessed: Date.now() - 3600000, // 1 hour ago
        accessCount: 5,
      },
    };
    (mockContext.globalState.get as jest.Mock).mockReturnValue(mockData);

    await tracker.load();

    expect(mockContext.globalState.get).toHaveBeenCalledWith(
      "olly.recencyEntries",
      {}
    );
  });

  test("recordAccess should store new entries", async () => {
    const filePath = "/path/to/file";
    const symbolName = "testSymbol";

    await tracker.recordAccess(filePath, symbolName);

    expect(mockContext.globalState.update).toHaveBeenCalled();
    const updateCall = (mockContext.globalState.update as jest.Mock).mock
      .calls[0];
    expect(updateCall[0]).toBe("olly.recencyEntries");

    // Should contain our entry
    const entries = updateCall[1];
    expect(entries[`${filePath}#${symbolName}`]).toBeDefined();
    expect(entries[`${filePath}#${symbolName}`].path).toBe(filePath);
    expect(entries[`${filePath}#${symbolName}`].accessCount).toBe(1);
  });

  test("recordAccess should increment counter for existing entries", async () => {
    const filePath = "/path/to/file";
    const symbolName = "testSymbol";
    const mockData = {
      [`${filePath}#${symbolName}`]: {
        path: filePath,
        lastAccessed: Date.now() - 3600000, // 1 hour ago
        accessCount: 5,
      },
    };
    (mockContext.globalState.get as jest.Mock).mockReturnValue(mockData);

    await tracker.recordAccess(filePath, symbolName);

    expect(mockContext.globalState.update).toHaveBeenCalled();
    const updateCall = (mockContext.globalState.update as jest.Mock).mock
      .calls[0];
    const entries = updateCall[1];
    expect(entries[`${filePath}#${symbolName}`].accessCount).toBe(6); // Incremented
  });

  test("getScore should return 0 for unknown entries", async () => {
    const result = await tracker.getScore("/unknown/path", "unknownSymbol");

    expect(result.score).toBe(0);
    expect(result.accessCount).toBe(0);
  });

  test("getScore should calculate scores based on recency and frequency", async () => {
    const filePath = "/path/to/file";
    const symbolName = "testSymbol";
    const now = Date.now();

    // Recently accessed file
    const recentMockData = {
      [`${filePath}#${symbolName}`]: {
        path: filePath,
        lastAccessed: now - 60000, // 1 minute ago
        accessCount: 10,
      },
    };

    (mockContext.globalState.get as jest.Mock).mockReturnValue(recentMockData);

    const recentScore = await tracker.getScore(filePath, symbolName);

    // Should have a high score due to recency and frequency
    expect(recentScore.score).toBeGreaterThan(0);
    expect(recentScore.accessCount).toBe(10);
  });

  test("older entries should have lower scores than recent ones", async () => {
    const filePath = "/path/to/file";
    const symbolName = "testSymbol";
    const now = Date.now();

    // Test with a very recent file
    const recentMockData = {
      [`${filePath}#${symbolName}`]: {
        path: filePath,
        lastAccessed: now, // just now
        accessCount: 5,
      },
    };

    (mockContext.globalState.get as jest.Mock).mockReturnValue(recentMockData);
    const recentScore = await tracker.getScore(filePath, symbolName);

    // Test with a much older file (same access count)
    const oldMockData = {
      [`${filePath}#${symbolName}`]: {
        path: filePath,
        lastAccessed: now - 60 * 60 * 24 * 7 * 1000, // 7 days ago
        accessCount: 5, // Same access count to isolate recency factor
      },
    };

    (mockContext.globalState.get as jest.Mock).mockReturnValue(oldMockData);
    const oldScore = await tracker.getScore(filePath, symbolName);

    // Recent should have higher score with same access count
    // Use toBeGreaterThanOrEqual to account for potential rounding effects
    expect(recentScore.score).toBeGreaterThanOrEqual(oldScore.score + 1);
  });

  test("higher frequency should increase score", async () => {
    const filePath = "/path/to/file";
    const symbolName = "testSymbol";
    const now = Date.now();

    // Test with very low frequency
    const lowFreqMockData = {
      [`${filePath}#${symbolName}`]: {
        path: filePath,
        lastAccessed: now, // Same time
        accessCount: 1,
      },
    };

    (mockContext.globalState.get as jest.Mock).mockReturnValue(lowFreqMockData);
    const lowFreqScore = await tracker.getScore(filePath, symbolName);

    // Test with much higher frequency
    const highFreqMockData = {
      [`${filePath}#${symbolName}`]: {
        path: filePath,
        lastAccessed: now, // Same time
        accessCount: 20, // Much higher access count
      },
    };

    (mockContext.globalState.get as jest.Mock).mockReturnValue(
      highFreqMockData
    );
    const highFreqScore = await tracker.getScore(filePath, symbolName);

    // Higher frequency should increase score
    // Use toBeGreaterThanOrEqual to account for potential rounding effects
    expect(highFreqScore.score).toBeGreaterThanOrEqual(lowFreqScore.score + 1);
  });

  test("clear should remove all entries", async () => {
    await tracker.clear();

    expect(mockContext.globalState.update).toHaveBeenCalledWith(
      "olly.recencyEntries",
      {}
    );
  });
});
