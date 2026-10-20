# WhatsApp assistant (Claude Code + WhatsApp)

Lets Claude Code read and send WhatsApp messages, so a law office can run one Claude conversation per client with the client's WhatsApp chat, documents and notes in one place.

## For the person using it

1. Install the Claude desktop app (or Claude Code) and sign in.
2. Put this folder somewhere permanent, for example `Documents\WhatsApp Assistente`.
3. Open the folder in Claude Code and write: **"Configure tudo para mim"** (or "Set everything up").
4. Claude installs what it needs and shows a QR code. Scan it with WhatsApp on your phone (*Dispositivos conectados → Conectar um dispositivo*).
5. Start one conversation per client. Say who the client is, and Claude takes it from there.

Claude always shows you a message before sending it to a client and only sends after you say OK.

## How it works

- `src/service.ts` keeps one WhatsApp Web connection running in the background (headless Edge/Chrome via whatsapp-web.js) and saves every message to `data/messages.db` (SQLite with full-text search).
- `src/mcp.ts` is the MCP server each Claude session starts (see `.mcp.json`). All sessions share the same background service, so they never fight over the WhatsApp login.
- `CLAUDE.md` tells Claude the goal, the first-time setup, and the one-conversation-per-client routine.
- `data/` (WhatsApp login, messages) and `clients/` (client notes and documents) are private and never committed.

Development: `npm install`, `npm test` (uses a fake WhatsApp), `npm run typecheck`. Requires Node.js 22.18+; TypeScript runs directly without a build step.

WhatsApp Web automation is unofficial. Use it at a human pace; bulk messaging can get a number banned.
