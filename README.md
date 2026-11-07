# Instagram DM agent + publishing API

A self-hosted alternative to ManyChat, Postiz and Metricool for **Instagram**. It answers comments, DMs and story replies, delivers resources, captures emails, follows up, and publishes or schedules posts. It is designed to be driven by AI agents.

I run it for my coffee brand to give free guides to café entrepreneurs and grow a newsletter, at **$0 in messaging cost**.

## What it does

- **DM automation:** keyword triggers on comments, story replies and first DMs. It sends button cards, can require a follow before delivery ("follow gate"), captures emails, tracks link opens, follows up about 22 h later, offers a human handoff (`HUMANO`) and opt-out (`STOP`). If Meta rejects a rich message, it falls back to plain text.
- **Publishing:** posts, carousels, reels and stories, immediately or scheduled, with a first comment and the bot keyword linked to the post in one step.
- **Agent-friendly:** an **MCP server** for Claude and a **REST API with OpenAPI** for any other agent or n8n.

## Architecture

Supabase: Postgres + Storage + Edge Functions (Deno) + pg_cron
- `ig-webhook`: Meta webhook verification, comment, DM and postback events, link redirect, cron jobs (follow-ups, publishing, token refresh)
- `rush-mcp`: stateless JSON-RPC MCP server
- `rush-api`: REST API + OpenAPI
- SQL migrations for leads, settings, publishing queue, storage and guides

## Setup

Copy `.env.example`, create a Meta app with Instagram API access, then run `./deploy.sh`. Full guide in Spanish: [README.es.md](README.es.md).

## License

MIT © 2026 Roy Camacho Jácome. See [LICENSE](LICENSE).
