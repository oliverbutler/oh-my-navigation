import * as vscode from "vscode";

interface RecencyEntry {
  path: string;
  lastAccessed: number;
  accessCount: number;
}

export interface SymbolScore {
  score: number;
  lastAccessed: number;
  accessCount: number;
}

const MAX_ENTRIES = 1000; // Maximum number of entries to store
const RECENCY_WEIGHT = 0.7; // Weight for recency vs frequency
const DECAY_FACTOR = 0.9; // How much older entries decay in relevance
const MAX_SCORE = 100; // Maximum score to assign

/**
 * Tracks and scores file and symbol access based on recency and frequency
 */
export class RecencyTracker {
  private context: vscode.ExtensionContext;
  private entries: Map<string, RecencyEntry> = new Map();
  private loaded = false;

  constructor(context: vscode.ExtensionContext) {
    this.context = context;
  }

  /**
   * Load entries from persistent storage
   */
  async load(): Promise<void> {
    if (this.loaded) return;

    const storedEntries = this.context.globalState.get<
      Record<string, RecencyEntry>
    >("omn.recencyEntries", {});

    this.entries = new Map(Object.entries(storedEntries));
    this.loaded = true;
  }

  /**
   * Save entries to persistent storage
   */
  private async save(): Promise<void> {
    if (!this.loaded) return;

    const entries = Object.fromEntries(this.entries.entries());
    await this.context.globalState.update("omn.recencyEntries", entries);
  }

  /**
   * Record a file access
   * @param filePath The file path
   * @param symbolName Optional symbol name
   */
  async recordAccess(filePath: string, symbolName?: string): Promise<void> {
    await this.load();

    const key = symbolName ? `${filePath}#${symbolName}` : filePath;
    const now = Date.now();

    const entry = this.entries.get(key) || {
      path: filePath,
      lastAccessed: 0,
      accessCount: 0,
    };
    entry.lastAccessed = now;
    entry.accessCount++;

    this.entries.set(key, entry);

    // Prune if necessary
    if (this.entries.size > MAX_ENTRIES) {
      this.prune();
    }

    await this.save();
  }

  /**
   * Get a score for a file/symbol based on access patterns
   * @param filePath The file path
   * @param symbolName Optional symbol name
   */
  getScore(filePath: string, symbolName?: string): SymbolScore {
    const key = symbolName ? `${filePath}#${symbolName}` : filePath;
    const entry = this.entries.get(key);

    console.log("entry", entry, this.entries);

    if (!entry) {
      return { score: 0, lastAccessed: 0, accessCount: 0 };
    }

    // Calculate a score based on recency and frequency
    const now = Date.now();
    const ageInHours = (now - entry.lastAccessed) / (1000 * 60 * 60);

    // Recency factor - decays with age
    const recencyScore =
      Math.pow(DECAY_FACTOR, Math.min(ageInHours, 48)) * MAX_SCORE;

    // Frequency factor - caps at a reasonable maximum
    const frequencyScore = Math.min(entry.accessCount, 50) * (MAX_SCORE / 50);

    // Combined score
    const score =
      RECENCY_WEIGHT * recencyScore + (1 - RECENCY_WEIGHT) * frequencyScore;

    return {
      score: Math.round(score * 10) / 10, // Round to 1 decimal place
      lastAccessed: entry.lastAccessed,
      accessCount: entry.accessCount,
    };
  }

  /**
   * Get scores for multiple items
   * @param items Array of file paths or file+symbol combinations
   */
  getScores(keys: string[]): Map<string, SymbolScore> {
    this.load();

    const scores = new Map<string, SymbolScore>();

    for (const key of keys) {
      const score = this.getScore(key);
      scores.set(key, score);
    }

    return scores;
  }

  /**
   * Remove the least recently used entries when we exceed the maximum
   */
  private prune(): void {
    const entries = [...this.entries.entries()];

    // Sort by last accessed (oldest first)
    entries.sort((a, b) => a[1].lastAccessed - b[1].lastAccessed);

    // Remove oldest entries to get below the maximum
    const toRemove = entries.slice(0, entries.length - MAX_ENTRIES);

    for (const [key] of toRemove) {
      this.entries.delete(key);
    }
  }

  /**
   * Clear all entries
   */
  async clear(): Promise<void> {
    this.entries.clear();
    await this.context.globalState.update("omn.recencyEntries", {});
  }
}
