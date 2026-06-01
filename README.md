# Peerdraft

> Open your Obsidian notes to people, tools, and AI agents

Peerdraft is the collaboration layer between Obsidian and everything else. Connect your notes to other people and devices via real-time Obsidian-to-Obsidian sync or web editor, to tools via RESTful API, and to AI agents via MCP integration. Supports both real-time collaboration and asynchronous workflows. Changes sync automatically whether you're working together or independently.

**Note**: Only the creator of a shared document or folder (Peerdraft Space) needs an account. Collaborators can access and work on shared content without signing up.

Join our [Discord Server](https://discord.gg/bKtVfTAkXt)

## How to Use

- **Obsidian Plugin**: [Install](obsidian://show-plugin?id=peerdraft) from Community Plugins, share documents and folders via right-click menu
- **Web Editor**: Browser-based access for collaborators
- **RESTful API**: Programmatic access via [API](https://www.peerdraft.app/api/v1/docs)
- **MCP Server**: AI agent integration via [MCP](https://www.peerdraft.app/documentation/how-to-guides/getting-started-with-the-peerdraft-mcp)

## Features

- [Web Editor](https://www.peerdraft.app/#web-editor): Browser-based collaboration for non-Obsidian users
- [Persistent Sharing](https://www.peerdraft.app/documentation/explanations/what-is-the-difference-between-persistent-and-fleeting): Long-term collaboration with offline support and background sync
- [Fleeting Sessions](https://www.peerdraft.app/documentation/explanations/what-is-the-difference-between-persistent-and-fleeting): End-to-end encrypted WebRTC sessions for temporary collaboration
- [Folder Sharing](https://www.peerdraft.app/#features): Share entire folders (including subfolders), not just individual documents
- [Canvas Collaboration](https://www.peerdraft.app/#features): Real-time collaboration on Obsidian Canvas (beta)
- [Background Sync](https://www.peerdraft.app/#features): Automatically detects changes from AI tools or external editors
- [RESTful API](https://www.peerdraft.app/api/v1/docs): Programmatic access to shared documents for tool integration
- [MCP Integration](https://www.peerdraft.app/documentation/how-to-guides/getting-started-with-the-peerdraft-mcp): Connect AI agents to your shared Obsidian folders via Model Context Protocol

## Technical Architecture

- Built on Yjs CRDTs for conflict-free real-time synchronization
- End-to-end encryption via WebRTC for fleeting sessions (zero-knowledge, servers never see content)
- HTTPS encryption for persistent shares (server-side encryption in transit and at rest)
- Local-first architecture with universal access (Obsidian, web, API, MCP)
- Background sync automatically merges changes from any source

## Pricing

- **Free**: 10 persistent shares, unlimited fleeting sessions
- **Trial**: 10,000 persistent shares (14-day Pro trial for Free tier users)
- **Pro**: 10,000 persistent shares, all collaborators free forever
- **Business**: Unlimited persistent shares

[Details](https://www.peerdraft.app/#pricing)

## Documentation

- [API Reference](https://www.peerdraft.app/api/v1/docs): Complete REST API documentation
- [MCP Setup Guide](https://www.peerdraft.app/documentation/how-to-guides/getting-started-with-the-peerdraft-mcp): Connect AI agents to your Spaces
- [Getting Started](https://www.peerdraft.app/documentation/how-to-guides/getting-started-with-obsidian): Install and configure the Obsidian plugin
- [Privacy Policy](https://www.peerdraft.app/privacy): GDPR and CCPA compliance
- [Terms of Service](https://www.peerdraft.app/terms): Legal agreement