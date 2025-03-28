// Mock browser APIs that aren't available in Jest
global.localStorage = {
  getItem: jest.fn(),
  setItem: jest.fn(),
  removeItem: jest.fn(),
  clear: jest.fn(),
  length: 0,
  key: jest.fn(),
};

// Mock window.URL
global.URL = {
  createObjectURL: jest.fn(),
  revokeObjectURL: jest.fn(),
};

// Mock TextEncoder and TextDecoder if they don't exist
if (typeof TextEncoder === 'undefined') {
  global.TextEncoder = require('util').TextEncoder;
}
if (typeof TextDecoder === 'undefined') {
  global.TextDecoder = require('util').TextDecoder;
}

// Mock Obsidian API
jest.mock('obsidian', () => ({
  MarkdownView: jest.fn(),
  Modal: jest.fn(),
  Notice: jest.fn(),
  Platform: {
    isDesktopApp: true,
    isMobileApp: false,
  },
  Plugin: jest.fn(),
  PluginSettingTab: jest.fn(),
  Setting: jest.fn(),
  TFile: jest.fn(),
  TFolder: jest.fn(),
  requestUrl: jest.fn().mockReturnValue({ json: {} }),
  normalizePath: (path) => path,
}), { virtual: true });

// Add any other global setup needed for tests