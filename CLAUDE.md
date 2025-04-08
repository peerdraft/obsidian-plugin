# Peerdraft Obsidian Plugin Guidelines

## Build/Development Commands
- `npm run dev`: Run development build with watch mode
- `npm run build`: Build production version with type checking
- `npm run version`: Bump version numbers in manifest and versions.json
- `npm test`: Run tests (use `npm test -- -t "test name"` for single test)

## Code Style Guidelines

### TypeScript
- Strict null checks are enforced
- Avoid implicit any types
- Use proper type annotations for parameters and return values
- Check token validity in authentication flows

### Imports
- Import specific items rather than entire modules
- Use relative paths for internal imports
- Group imports by external/internal

### Naming Conventions
- Use PascalCase for classes and interfaces
- Use camelCase for variables, functions, and properties
- Prefix interfaces with "I" when appropriate
- Use descriptive, meaningful names

### Code Structure
- Organize code in feature-focused files/folders
- Keep files small and focused on a single responsibility
- Prefer composition over inheritance
- Place tests in src/tests directory with .test.ts extension

### Error Handling
- Use try/catch blocks for error-prone operations
- Return explicit error types or null/undefined with strictNullChecks
- Show user-friendly error notices with showNotice()

### Svelte Components
- Keep component logic minimal
- Use TypeScript with Svelte components
- Follow Svelte's reactivity principles