const { defineConfig } = require('cypress');

module.exports = defineConfig({
  projectId: 'aviator-e2e',
  viewportWidth: 1280,
  viewportHeight: 720,
  defaultCommandTimeout: 10000,
  requestTimeout: 10000,
  responseTimeout: 30000,
  video: false,
  screenshotOnRunFailure: true,
  
  env: {
    BASE_URL: 'http://localhost:3000',
    API_URL: 'http://localhost:8000/api'
  },

  e2e: {
    baseUrl: 'http://localhost:3000',
    specPattern: 'e2e/**/*.cy.{js,jsx,ts,tsx}',
    supportFile: 'support/e2e.js'
  },

  component: {
    devServer: {
      framework: 'react',
      bundler: 'vite'
    },
    specPattern: 'component/**/*.cy.{js,jsx,ts,tsx}'
  }
});
