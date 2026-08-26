/**
 * Smart File Prioritization
 *
 * Ranks workspace files by relevance so Bantam reads the right files first
 * instead of guessing. Scores files on multiple signals:
 *   - recency (last modified / accessed)
 *   - dependency centrality (how many files import it)
 *   - test coverage (has a corresponding test?)
 *   - size (prefer smaller files for quick reads)
 *   - keyword match (does the file content match the task?)
 */

class SmartFilePriority {
  constructor(options = {}) {
    this.maxResults = options.maxResults ?? 10;
    this.weights = {
      recency: options.weights?.recency ?? 0.15,
      centrality: options.weights?.centrality ?? 0.25,
      coverage: options.weights?.coverage ?? 0.20,
      size: options.weights?.size ?? 0.15,
      keyword: options.weights?.keyword ?? 0.25,
    };
    this.fileStats = new Map();
    this.dependencyGraph = new Map();
    this.initialized = false;
  }

  /**
   * Initialize the prioritizer with file metadata.
   * @param {Array<{path: string, size: number, mtime: number}>} files
   * @param {Map<string, string[]>} deps - dependency graph (file → [imports])
   * @param {Set<string>} coveredFiles - files that have test coverage
   */
  initialize(files, deps, coveredFiles) {
    this.fileStats = new Map();
    this.dependencyGraph = deps || new Map();
    this.coveredFiles = coveredFiles || new Set();

    for (const file of files) {
      this.fileStats.set(file.path, {
        path: file.path,
        size: file.size ?? 0,
        mtime: file.mtime ?? Date.now(),
        score: 0,
        breakdown: {},
      });
    }

    this.initialized = true;
    return this;
  }

  /**
   * Score all files and return the top N ranked by relevance.
   * @param {string} taskDescription - what the user is trying to do
   * @param {Map<string, string>} [fileContents] - optional file contents for keyword matching
   * @returns {Array<{path: string, score: number, breakdown: object}>}
   */
  rank(taskDescription, fileContents) {
    if (!this.initialized) {
      throw new Error('SmartFilePriority not initialized. Call initialize() first.');
    }

    const normalizedTask = taskDescription.toLowerCase();
    const keywords = this._extractKeywords(normalizedTask);

    for (const [path, stats] of this.fileStats) {
      const scores = {};

      // Recency score (0-1): newer files score higher
      scores.recency = this._scoreRecency(stats.mtime);

      // Centrality score (0-1): files imported by many others score higher
      scores.centrality = this._scoreCentrality(path);

      // Coverage score (0-1): files with tests score higher
      scores.coverage = this._scoreCoverage(path);

      // Size score (0-1): smaller files score higher (easier to read)
      scores.size = this._scoreSize(stats.size);

      // Keyword score (0-1): files matching task keywords score higher
      scores.keyword = this._scoreKeyword(path, keywords, fileContents?.get(path));

      // Weighted sum
      const total =
        scores.recency * this.weights.recency +
        scores.centrality * this.weights.centrality +
        scores.coverage * this.weights.coverage +
        scores.size * this.weights.size +
        scores.keyword * this.weights.keyword;

      stats.score = total;
      stats.breakdown = scores;
    }

    // Sort by score descending, return top N
    const ranked = Array.from(this.fileStats.values())
      .sort((a, b) => b.score - a.score)
      .slice(0, this.maxResults);

    return ranked;
  }

  /**
   * Score a single file without re-scoring everything.
   * @param {string} path
   * @param {string} taskDescription
   * @param {string} [content]
   * @returns {{score: number, breakdown: object}}
   */
  scoreFile(path, taskDescription, content) {
    const stats = this.fileStats.get(path);
    if (!stats) return { score: 0, breakdown: {} };

    const normalizedTask = taskDescription.toLowerCase();
    const keywords = this._extractKeywords(normalizedTask);

    const scores = {
      recency: this._scoreRecency(stats.mtime),
      centrality: this._scoreCentrality(path),
      coverage: this._scoreCoverage(path),
      size: this._scoreSize(stats.size),
      keyword: this._scoreKeyword(path, keywords, content),
    };

    const total =
      scores.recency * this.weights.recency +
      scores.centrality * this.weights.centrality +
      scores.coverage * this.weights.coverage +
      scores.size * this.weights.size +
      scores.keyword * this.weights.keyword;

    return { score: total, breakdown: scores };
  }

  // ---- Private scoring methods ----

  _extractKeywords(text) {
    // Remove common stop words and extract meaningful tokens
    const stopWords = new Set([
      'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been',
      'to', 'of', 'in', 'on', 'at', 'by', 'for', 'with', 'that',
      'this', 'it', 'and', 'or', 'not', 'no', 'do', 'does', 'did',
      'have', 'has', 'had', 'will', 'would', 'could', 'should',
      'may', 'might', 'can', 'need', 'want', 'make', 'made',
      'get', 'got', 'go', 'going', 'also', 'just', 'very', 'more',
      'most', 'some', 'any', 'all', 'each', 'every', 'both',
      'its', 'our', 'your', 'my', 'we', 'you', 'he', 'she', 'they',
      'what', 'which', 'who', 'how', 'where', 'when', 'why',
      'about', 'after', 'before', 'between', 'from', 'into',
      'through', 'during', 'above', 'below', 'up', 'down',
      'out', 'off', 'over', 'under', 'again', 'further',
      'then', 'once', 'here', 'there', 'build', 'add', 'create',
      'fix', 'implement', 'change', 'update', 'remove',
    ]);

    return text
      .split(/[^a-z0-9]+/)
      .filter(w => w.length > 2 && !stopWords.has(w));
  }

  _scoreRecency(mtime) {
    const now = Date.now();
    const ageHours = (now - mtime) / (1000 * 60 * 60);
    // Exponential decay: files modified within last hour score ~1, older score less
    // Brand new files (ageHours=0) score exactly 1; files >200h old score 0
    if (ageHours <= 0) return 1;
    return Math.max(0, Math.min(1, 1 - ageHours / 200));
  }

  _scoreCentrality(path) {
    // Count how many files import this one
    let importCount = 0;
    for (const [, imports] of this.dependencyGraph) {
      if (imports.includes(path)) importCount++;
    }

    if (this.fileStats.size === 0) return 0.5;
    // Normalize: max centrality when imported by half the codebase
    return Math.min(1, importCount / Math.max(1, this.fileStats.size / 2));
  }

  _scoreCoverage(path) {
    return this.coveredFiles.has(path) ? 1 : 0.3;
  }

  _scoreSize(size) {
    if (size === 0) return 0.5;
    // Prefer files under 200 lines; penalize files over 500 lines
    if (size <= 100) return 1;
    if (size <= 200) return 0.8;
    if (size <= 500) return 0.5;
    return Math.max(0.1, 1 - (size - 500) / 1000);
  }

  _scoreKeyword(path, keywords, content) {
    if (keywords.length === 0) return 0.5;

    let matches = 0;
    let total = keywords.length;

    const pathLower = path.toLowerCase();

    for (const kw of keywords) {
      // Check path
      if (pathLower.includes(kw)) {
        matches += 1;
        continue;
      }

      // Check content if available
      if (content && content.toLowerCase().includes(kw)) {
        matches += 0.5; // Partial credit for content match
      }
    }

    return matches / total;
  }

  /**
   * Get a summary of the prioritization results.
   * @returns {object}
   */
  summary() {
    return {
      totalFiles: this.fileStats.size,
      initialized: this.initialized,
      maxResults: this.maxResults,
      weights: { ...this.weights },
    };
  }
}

export { SmartFilePriority };
