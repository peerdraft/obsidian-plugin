import { defineConfig } from 'eslint/config';
import obsidianmd from 'eslint-plugin-obsidianmd';
import nodePlugin from 'eslint-plugin-n';

export default defineConfig([
  { ignores: ['main.js', 'dist/', 'coverage/'] },
  ...obsidianmd.configs.recommended,
  {
    languageOptions: {
      parserOptions: {
        projectService: {
          allowDefaultProject: ['eslint.config.*'],
        },
      },
    },
  },
  {
    files: ['src/**/*.ts'],
    plugins: { n: nodePlugin },
    settings: {
      node: {
        allowModules: ['src'],
      },
    },
    rules: {
      'n/no-extraneous-import': 'warn',
    },
  },
]);
