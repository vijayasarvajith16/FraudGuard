'use strict';

/** @type {import('jest').Config} */
module.exports = {
  testEnvironment: 'node',
  testMatch: ['<rootDir>/tests/**/*.test.js'],
  // The first run downloads a MongoDB binary for mongodb-memory-server.
  testTimeout: 60_000,
  collectCoverageFrom: ['src/**/*.js', '!src/index.js'],
  coverageThreshold: { global: { lines: 85, branches: 75 } },
};
