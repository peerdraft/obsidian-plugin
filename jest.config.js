/** @type {import('jest').Config} */
module.exports = {
  testEnvironment: 'jsdom',
  roots: ['<rootDir>/src'],
  transform: {
    '^.+\\.tsx?$': ['ts-jest', {
      tsconfig: 'tsconfig.json',
      useESM: true,
    }],
    '^.+\\.m?js$': ['ts-jest', {
      tsconfig: { allowJs: true, module: 'CommonJS', target: 'ES2020', esModuleInterop: true },
      useESM: false,
    }],
  },
  moduleNameMapper: {
    '^src/(.*)$': '<rootDir>/src/$1',
  },
  testMatch: ['**/*.test.ts'],
  setupFilesAfterEnv: ['<rootDir>/jest.setup.js'],
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/**/*.d.ts',
    '!src/**/index.ts',
  ],
  coverageDirectory: 'coverage',
  coverageReporters: ['text', 'lcov'],
  verbose: true,
  // Compile ESM dependencies to CommonJS for Jest, including file-type's
  // transitive dependencies. Allowlisting alone does not transform JavaScript.
  transformIgnorePatterns: [
    'node_modules/(?!(dexie|y-codemirror.next|y-indexeddb|y-webrtc|y-websocket|yjs|file-type|token-types|ieee754|strtok3|uint8array-extras|@tokenizer/inflate|@borewit/text-codec)/)',
  ],
  extensionsToTreatAsEsm: ['.ts'],
};
