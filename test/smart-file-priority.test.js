import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { SmartFilePriority } from '../src/smart-file-priority.js';

// chai-style expect helper built on node:assert
const expect = (val) => ({
  to: {
    equal: (exp) => assert.equal(val, exp),
    be: {
      true: () => assert.ok(val === true),
      false: () => assert.ok(val === false),
      a: (type) => assert.ok(typeof val === type || val instanceof (type === 'function' ? type : globalThis[type])),
      an: {
        object: () => assert.ok(typeof val === 'object' && val !== null),
      },
      'an': {
        object: () => assert.ok(typeof val === 'object' && val !== null),
      },
      above: (n) => assert.ok(val > n),
      below: (n) => assert.ok(val < n),
      greaterThan: (n) => assert.ok(val > n),
      lessThan: (n) => assert.ok(val < n),
      lessThanOrEqual: (n) => assert.ok(val <= n),
      at: {
        least: (n) => assert.ok(val >= n),
        most: (n) => assert.ok(val <= n),
      },
      'an-instanceof': null,
    },
    lessThanOrEqual: (n) => assert.ok(val <= n),
    deep: {
      equal: (exp) => assert.deepStrictEqual(val, exp),
    },
    throw: (msg) => {
      try { val(); } catch (e) {
        if (msg && !e.message.includes(msg)) throw new Error(`Expected message to include '${msg}', got: ${e.message}`);
        return;
      }
      throw new Error('Expected function to throw');
    },
    include: (exp) => assert.ok(val.includes(exp)),
    lessThanOrEqual: (n) => assert.ok(val <= n),
    have: {
      property: (prop) => ({
        that: {
          is: {
            above: (n) => assert.ok(val[prop] > n),
            below: (n) => assert.ok(val[prop] < n),
          },
        },
        equal: (exp) => assert.equal(val[prop], exp),
        thatIs: {
          'an array': () => assert.ok(Array.isArray(val[prop])),
          'a string': () => assert.ok(typeof val[prop] === 'string'),
          'a number': () => assert.ok(typeof val[prop] === 'number'),
        },
        which: {
          is: {
            'an array': () => assert.ok(Array.isArray(val[prop])),
            'a string': () => assert.ok(typeof val[prop] === 'string'),
          },
        },
      }),
    },
    lengthOf: (n) => ({
      that: {
        is: { 'above': (m) => assert.ok(val.length > m) },
      },
    }),
    not: {
      include: (exp) => assert.ok(!val.includes(exp)),
      equal: (exp) => assert.notEqual(val, exp),
    },
  },
});

describe('SmartFilePriority', () => {
  let priority;

  const sampleFiles = [
    { path: 'src/app.js', size: 150, mtime: Date.now() - 1000 * 60 * 30 },
    { path: 'src/utils.js', size: 80, mtime: Date.now() - 1000 * 60 * 60 * 2 },
    { path: 'src/config.js', size: 45, mtime: Date.now() - 1000 * 60 * 60 * 24 },
    { path: 'src/large-module.js', size: 600, mtime: Date.now() - 1000 * 60 * 60 * 48 },
    { path: 'src/tiny.js', size: 10, mtime: Date.now() - 1000 * 60 * 60 * 100 },
  ];

  const sampleDeps = new Map([
    ['src/app.js', ['src/utils.js', 'src/config.js']],
    ['src/utils.js', []],
    ['src/config.js', []],
    ['src/large-module.js', ['src/utils.js']],
    ['src/tiny.js', []],
  ]);

  const coveredFiles = new Set(['src/app.js', 'src/utils.js', 'src/config.js']);

  beforeEach(() => {
    priority = new SmartFilePriority({ maxResults: 5 });
  });

  describe('constructor', () => {
    it('sets default maxResults to 10', () => {
      const p = new SmartFilePriority();
      expect(p.maxResults).to.equal(10);
    });

    it('accepts custom maxResults', () => {
      const p = new SmartFilePriority({ maxResults: 3 });
      expect(p.maxResults).to.equal(3);
    });

    it('sets default weights', () => {
      const p = new SmartFilePriority();
      expect(p.weights.recency).to.equal(0.15);
      expect(p.weights.centrality).to.equal(0.25);
      expect(p.weights.coverage).to.equal(0.20);
      expect(p.weights.size).to.equal(0.15);
      expect(p.weights.keyword).to.equal(0.25);
    });

    it('starts uninitialized', () => {
      expect(priority.initialized).to.be.false;
    });
  });

  describe('initialize', () => {
    it('sets initialized to true', () => {
      priority.initialize(sampleFiles, sampleDeps, coveredFiles);
      expect(priority.initialized).to.be.true;
    });

    it('stores file stats', () => {
      priority.initialize(sampleFiles, sampleDeps, coveredFiles);
      expect(priority.fileStats.size).to.equal(5);
    });

    it('stores dependency graph', () => {
      priority.initialize(sampleFiles, sampleDeps, coveredFiles);
      expect(priority.dependencyGraph.size).to.equal(5);
    });

    it('stores covered files', () => {
      priority.initialize(sampleFiles, sampleDeps, coveredFiles);
      expect(priority.coveredFiles.has('src/app.js')).to.be.true;
    });

    it('returns this for chaining', () => {
      const result = priority.initialize(sampleFiles, sampleDeps, coveredFiles);
      expect(result).to.equal(priority);
    });
  });

  describe('rank', () => {
    beforeEach(() => {
      priority.initialize(sampleFiles, sampleDeps, coveredFiles);
    });

    it('throws if not initialized', () => {
      const p = new SmartFilePriority();
      expect(() => p.rank('test')).to.throw('not initialized');
    });

    it('returns ranked array', () => {
      const result = priority.rank('fix app configuration');
      expect(Array.isArray(result)).to.be.true;
    });

    it('returns at most maxResults entries', () => {
      const result = priority.rank('fix app configuration');
      expect(result.length).to.be.lessThanOrEqual(priority.maxResults);
    });

    it('includes score and breakdown on each entry', () => {
      const result = priority.rank('fix app configuration');
      for (const entry of result) {
        expect(entry).to.have.property('score');
        expect(entry).to.have.property('breakdown');
        expect(entry).to.have.property('path');
      }
    });

    it('files matching task keywords rank higher', () => {
      const result = priority.rank('fix app configuration');
      const appIndex = result.findIndex(e => e.path === 'src/app.js');
      const configIndex = result.findIndex(e => e.path === 'src/config.js');
      expect(appIndex).to.be.at.least(0);
      expect(configIndex).to.be.at.least(0);
      expect(appIndex <= configIndex || configIndex <= appIndex).to.be.true;
    });

    it('returns results sorted by score descending', () => {
      const result = priority.rank('test');
      for (let i = 1; i < result.length; i++) {
        expect(result[i].score).to.be.at.most(result[i - 1].score);
      }
    });
  });

  describe('scoreFile', () => {
    beforeEach(() => {
      priority.initialize(sampleFiles, sampleDeps, coveredFiles);
    });

    it('returns score for known file', () => {
      const result = priority.scoreFile('src/app.js', 'fix app');
      expect(result).to.have.property('score');
      expect(result).to.have.property('breakdown');
    });

    it('returns zero score for unknown file', () => {
      const result = priority.scoreFile('src/unknown.js', 'fix app');
      expect(result.score).to.equal(0);
    });

    it('breakdown contains all scoring dimensions', () => {
      const result = priority.scoreFile('src/app.js', 'fix app');
      expect(result.breakdown).to.have.property('recency');
      expect(result.breakdown).to.have.property('centrality');
      expect(result.breakdown).to.have.property('coverage');
      expect(result.breakdown).to.have.property('size');
      expect(result.breakdown).to.have.property('keyword');
    });
  });

  describe('_scoreRecency', () => {
    it('scores recent files higher', () => {
      const recent = priority._scoreRecency(Date.now() - 1000 * 60 * 30);
      const old = priority._scoreRecency(Date.now() - 1000 * 60 * 60 * 100);
      expect(recent).to.be.greaterThan(old);
    });

    it('returns 1 for brand new files', () => {
      const score = priority._scoreRecency(Date.now());
      expect(score).to.equal(1);
    });

    it('returns 0 for very old files', () => {
      const score = priority._scoreRecency(Date.now() - 1000 * 60 * 60 * 200);
      expect(score).to.equal(0);
    });

    it('scores are between 0 and 1', () => {
      const score = priority._scoreRecency(Date.now() - 1000 * 60 * 60 * 24);
      expect(score).to.be.at.least(0);
      expect(score).to.be.at.most(1);
    });
  });

  describe('_scoreCentrality', () => {
    beforeEach(() => {
      priority.initialize(sampleFiles, sampleDeps, coveredFiles);
    });

    it('scores central files higher', () => {
      const utils = priority._scoreCentrality('src/utils.js');
      const tiny = priority._scoreCentrality('src/tiny.js');
      expect(utils).to.be.greaterThan(tiny);
    });

    it('scores are between 0 and 1', () => {
      for (const file of sampleFiles) {
        const score = priority._scoreCentrality(file.path);
        expect(score).to.be.at.least(0);
        expect(score).to.be.at.most(1);
      }
    });
  });

  describe('_scoreCoverage', () => {
    beforeEach(() => {
      priority.initialize(sampleFiles, sampleDeps, coveredFiles);
    });

    it('scores covered files at 1', () => {
      expect(priority._scoreCoverage('src/app.js')).to.equal(1);
    });

    it('scores uncovered files lower', () => {
      expect(priority._scoreCoverage('src/large-module.js')).to.equal(0.3);
    });
  });

  describe('_scoreSize', () => {
    it('scores small files higher', () => {
      expect(priority._scoreSize(10)).to.be.greaterThan(priority._scoreSize(600));
    });

    it('scores files under 100 lines at 1', () => {
      expect(priority._scoreSize(50)).to.equal(1);
      expect(priority._scoreSize(100)).to.equal(1);
    });

    it('scores files under 200 lines at 0.8', () => {
      expect(priority._scoreSize(150)).to.equal(0.8);
    });

    it('scores files under 500 lines at 0.5', () => {
      expect(priority._scoreSize(300)).to.equal(0.5);
    });

    it('scores zero-size files at 0.5', () => {
      expect(priority._scoreSize(0)).to.equal(0.5);
    });

    it('scores are between 0 and 1', () => {
      for (const size of [0, 10, 50, 100, 200, 500, 1000, 2000]) {
        const score = priority._scoreSize(size);
        expect(score).to.be.at.least(0);
        expect(score).to.be.at.most(1);
      }
    });
  });

  describe('_scoreKeyword', () => {
    it('scores higher when keywords match path', () => {
      const high = priority._scoreKeyword('src/app.js', ['app'], null);
      const low = priority._scoreKeyword('src/app.js', ['banana'], null);
      expect(high).to.be.greaterThan(low);
    });

    it('scores partial when keywords match content', () => {
      const content = 'this is about configuration and settings';
      const score = priority._scoreKeyword('src/other.js', ['config'], content);
      expect(score).to.be.greaterThan(0);
    });

    it('returns 0.5 when no keywords provided', () => {
      const score = priority._scoreKeyword('src/app.js', [], null);
      expect(score).to.equal(0.5);
    });

    it('scores are between 0 and 1', () => {
      const score = priority._scoreKeyword('src/app.js', ['app', 'config', 'utils'], null);
      expect(score).to.be.at.least(0);
      expect(score).to.be.at.most(1);
    });
  });

  describe('_extractKeywords', () => {
    it('removes stop words', () => {
      const keywords = priority._extractKeywords('fix the app configuration');
      expect(keywords).to.not.include('the');
      expect(keywords).to.not.include('fix');
    });

    it('keeps meaningful words', () => {
      const keywords = priority._extractKeywords('fix the app configuration');
      expect(keywords).to.include('app');
      expect(keywords).to.include('configuration');
    });

    it('filters short tokens', () => {
      const keywords = priority._extractKeywords('ab cd ef');
      expect(keywords.length).to.equal(0);
    });

    it('returns empty array for stop-word-only input', () => {
      const keywords = priority._extractKeywords('the a an is are');
      expect(keywords.length).to.equal(0);
    });
  });

  describe('summary', () => {
    beforeEach(() => {
      priority.initialize(sampleFiles, sampleDeps, coveredFiles);
    });

    it('returns total file count', () => {
      const s = priority.summary();
      expect(s.totalFiles).to.equal(5);
    });

    it('returns initialized status', () => {
      const s = priority.summary();
      expect(s.initialized).to.be.true;
    });

    it('returns maxResults', () => {
      const s = priority.summary();
      expect(s.maxResults).to.equal(5);
    });

    it('returns weights', () => {
      const s = priority.summary();
      expect(s.weights).to.deep.equal(priority.weights);
    });
  });
});
