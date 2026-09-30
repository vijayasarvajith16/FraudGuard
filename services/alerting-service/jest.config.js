'use strict';

/** @type {import('jest').Config} */
module.exports = {
  testEnvironment: 'node',
  testMatch: ['<rootDir>/tests/**/*.test.js'],
  // Replica-set startup (and the first mongod download) can take a while.
  testTimeout: 60_000,
  collectCoverageFrom: ['src/**/*.js', '!src/index.js'],
};
