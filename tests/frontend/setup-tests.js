import '@testing-library/jest-dom';

// Mock environment variables
Object.defineProperty(window, 'env', {
  value: {
    VITE_API_BASE_URL: 'http://localhost:8000/api',
    VITE_APP_NAME: 'Aviator'
  },
  writable: false
});

// Mock localStorage
const localStorageMock = {
  getItem: jest.fn(),
  setItem: jest.fn(),
  removeItem: jest.fn(),
  clear: jest.fn()
};
global.localStorage = localStorageMock;

// Mock fetch and global APIs
global.fetch = jest.fn(() =>
  Promise.resolve({
    json: () => Promise.resolve({}),
    ok: true,
    status: 200
  })
);

// Suppress specific console warnings during tests
console.warn = jest.fn();
console.error = jest.fn();
