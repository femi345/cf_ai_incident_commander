# cf_ai_incident_commander

An AI-powered incident response agent built on the [Cloudflare Agents SDK](https://developers.cloudflare.com/agents/). It helps DevOps teams declare, triage, track, and resolve production incidents through a real-time chat interface — powered by Llama 3.3 70B running on Workers AI.

## Why This Exists

Most incident management tools are passive dashboards. This project flips the model: the AI is an active participant in your incident response. It triages automatically, suggests runbooks, tracks timelines, and generates postmortems — all through natural conversation.

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        React Frontend                           │
│  ┌──────────────┐  ┌───────────────────┐  ┌──────────────────┐ │
│  │   Incident    │  │   Chat Interface  │  │  Live Timeline   │ │
│  │   Sidebar     │  │   (useAgentChat)  │  │  (RPC + Sync)    │ │
│  └──────┬───────┘  └────────┬──────────┘  └────────┬─────────┘ │
│         │ RPC               │ WebSocket            │ State Sync │
└─────────┼───────────────────┼──────────────────────┼───────────┘
          │                   │                      │
┌─────────┴───────────────────┴──────────────────────┴───────────┐
│               IncidentAgent (Durable Object)                    │
│                                                                 │
│  ┌──────────────┐  ┌──────────────┐  ┌───────────────────────┐ │
│  │  Llama 3.3   │  │   SQLite DB  │  │  Task Queue +         │ │
│  │  70B (Workers │  │  - incidents │  │  Scheduler            │ │
│  │  AI)          │  │  - updates   │  │  - async triage       │ │
│  │              │  │  - runbooks  │  │  - health checks      │ │
│  └──────────────┘  └──────────────┘  └───────────────────────┘ │
└─────────────────────────────────────────────────────────────────┘
```

## Features

### Core Incident Management
- **Declare Incidents** — describe a problem in natural language; the AI proposes an incident with severity (P1–P4) and requires human approval before creation
- **Auto-Triage** — after declaration, an async queue job runs AI analysis: probable cause, severity recommendation, affected systems, and immediate action steps
- **Status Updates** — post updates to active incidents, change status (open → investigating → mitigating → resolved)
- **Resolve with MTTR** — close incidents with a resolution summary; MTTR is calculated automatically

### Knowledge Base
- **Runbook Library** — pre-seeded with 5 production runbooks (API latency, database failures, deployment rollbacks, SSL expiry, memory leaks)
- **Search Runbooks** — fuzzy search across titles, content, and tags
- **Add Runbooks** — create new runbooks through chat (requires approval)

### Monitoring & Scheduling
- **Health Checks** — schedule periodic health checks for named services; results broadcast to all connected clients
- **Reminders** — schedule follow-up tasks using natural language ("remind me in 30 minutes to check the API")
- **Cron Support** — set up recurring checks with cron expressions

### Analytics & Reporting
- **Incident Analytics** — MTTR averages, counts by severity, resolution rates
- **Postmortem Generation** — client-side tool that assembles a structured postmortem from the incident timeline
- **Timeline View** — every action is logged with timestamps and author (user/AI/system)

### Real-Time Collaboration
- **WebSocket Sync** — all connected clients see incidents update in real-time
- **State Synchronization** — active incident count syncs to sidebar via agent state
- **Toast Notifications** — health alerts and scheduled tasks notify all connected browsers

## Tech Stack

| Component | Technology |
|-----------|-----------|
| LLM | Llama 3.3 70B (`@cf/meta/llama-3.3-70b-instruct-fp8-fast`) on Workers AI |
| Agent Runtime | Cloudflare Durable Objects via Agents SDK |
| State | Synced agent state + embedded SQLite (3 tables) |
| Coordination | Task queues (async triage) + scheduled tasks (health checks) |
| Frontend | React 19 + Tailwind CSS 4 + Cloudflare Kumo UI |
| Transport | WebSocket (chat + state sync) + RPC (callable methods) |
| Build | Vite 7 + Cloudflare Vite Plugin |

## Cloudflare Platform Features Used

- **Workers AI** — LLM inference with Llama 3.3 70B
- **Durable Objects** — stateful agent with SQLite, WebSockets, hibernation
- **Agent State Sync** — real-time state synchronization to clients
- **Callable RPC** — typed method calls over WebSocket (`@callable()`)
- **Task Queue** — async background processing with FIFO ordering
- **Task Scheduler** — delayed and cron-based task execution
- **Human-in-the-Loop** — approval flows for incident declaration and runbook creation
- **Client-Side Tools** — browser-executed tools (timezone detection, postmortem rendering)
- **Server-Side Tools** — 11 LLM-callable tools for incident management
- **Broadcasting** — real-time notifications to all connected clients
- **Assets** — SPA hosting with worker-first routing for agent endpoints

## Running Locally

### Prerequisites
- Node.js 18+
- npm

### Setup

```bash
# Clone the repository
git clone <repo-url> cf_ai_incident_commander
cd cf_ai_incident_commander

# Install dependencies
npm install

# Start the dev server
npm run dev
```

The app will be available at `http://localhost:5173`. No Cloudflare account or API keys are needed for local development — Workers AI runs via the remote binding in dev mode.

### Try These Prompts

1. **Declare an incident:**
   > "Our API is returning 500 errors for about 30% of requests. Started 10 minutes ago."

2. **Search runbooks:**
   > "Search runbooks for database connection issues"

3. **Schedule a health check:**
   > "Schedule a health check for API Gateway, Auth Service, and Database in 1 minute"

4. **Get analytics:**
   > "Show me incident analytics"

5. **Generate a postmortem:**
   > "Generate a postmortem for the most recent resolved incident"

## Deploying to Cloudflare

```bash
# Login to Cloudflare (first time only)
npx wrangler login

# Deploy
npm run deploy
```

Your agent will be live on Cloudflare's global network. Messages persist in SQLite, streams resume on disconnect, and the agent hibernates when idle.

## Project Structure

```
src/
  server.ts    — IncidentAgent: Durable Object with SQL schema, 11 tools,
                 queue handlers, scheduled tasks, callable RPC methods
  app.tsx      — React app: three-column layout with incident sidebar,
                 chat interface, and live timeline panel
  client.tsx   — React entry point
  styles.css   — Tailwind imports and custom styles
wrangler.jsonc — Durable Object binding, Workers AI, asset config
env.d.ts       — TypeScript declarations
PROMPTS.md     — Documentation of all AI prompts used
```

## License

MIT
