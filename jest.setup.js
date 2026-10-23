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

// Node's encoder returns byte arrays from a different realm than jsdom.
// Copy them into jsdom's Uint8Array so dependency instanceof checks succeed.
if (typeof TextEncoder === 'undefined') {
  const NodeTextEncoder = require('util').TextEncoder;
  global.TextEncoder = class TextEncoder extends NodeTextEncoder {
    encode(input) {
      return Uint8Array.from(super.encode(input));
    }
  };
}
if (typeof TextDecoder === 'undefined') {
  global.TextDecoder = require('util').TextDecoder;
}

// jsdom's `crypto` global lacks SubtleCrypto - patch it in from Node's
// webcrypto for tests only. Production code (Obsidian's Electron/mobile
// runtime) has a real Web Crypto implementation already.
if (typeof crypto !== 'undefined' && !crypto.subtle) {
  const { webcrypto } = require('node:crypto');
  crypto.subtle = webcrypto.subtle;
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
