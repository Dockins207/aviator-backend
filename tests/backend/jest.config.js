module.exports = {
  testEnvironment: 'node',
  setupFilesAfterEnv: ['<rootDir>/setup-tests.js'],
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/../backend/src/$1'
  },
  transform: {
    '^.+\\.js$': 'babel-jest'
  },
  collectCoverageFrom: [
    '../backend/src/**/*.{js,jsx}',
    '!../backend/src/**/*.test.{js,jsx}',
    '!../backend/src/server.js',
    '!../backend/src/app.js'
  ],
  coverageThreshold: {
    global: {
      branches: 50,
      functions: 50,
      lines: 50,
      statements: 50
    }
  },
  testTimeout: 10000
};
