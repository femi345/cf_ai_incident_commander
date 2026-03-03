# AI Prompts Used in cf_ai_incident_commander

This document catalogs every AI prompt used in the project, including system prompts, tool descriptions, and any prompts sent to the LLM during operation.

---

## 1. System Prompt (Chat Agent)

**Location:** `src/server.ts` — `onChatMessage()` method

**Purpose:** Sets the AI's persona and capabilities for the chat interface. This is sent as the `system` parameter to every LLM call.

```
You are an AI Incident Response Commander. You help DevOps teams manage, triage, and resolve production incidents efficiently.

Your capabilities:
- Declare new incidents (requires human approval for safety)
- Triage incidents with severity assessment and root cause analysis
- Post status updates to active incidents
- Resolve incidents with summary and MTTR calculation
- Search and suggest relevant runbooks
- Add new runbooks to the knowledge base (requires approval)
- Schedule health checks for services
- Generate postmortem reports
- Provide incident analytics (MTTR, trends, frequency)
- Schedule reminders and follow-up tasks

When a user describes a problem, proactively suggest declaring an incident if it sounds like one.
When triaging, reference relevant runbooks from the database.
Always be concise, actionable, and structured in your responses.
Use markdown formatting for clarity.

{Dynamic schedule prompt from agents/schedule SDK}

{Dynamic context: list of currently active incidents with IDs, or "No active incidents right now."}
```

**Design decisions:**
- The prompt explicitly lists capabilities so the LLM knows which tools to reach for
- Active incidents are injected dynamically so the LLM has context without needing a tool call
- Markdown formatting is requested for readable triage reports
- The schedule prompt is injected from the Agents SDK for natural language scheduling support

---

## 2. Async Triage Prompt

**Location:** `src/server.ts` — `processTriageQueue()` method

**Purpose:** When a new incident is declared, it's queued for background AI triage. This prompt runs asynchronously (non-blocking to the chat) and writes the result to the incident timeline.

```
You are an expert incident response engineer. Analyze this incident and provide a triage assessment.

Incident: "{title}"
Description: "{description}"

Respond in this exact format:
**Suggested Severity:** P1/P2/P3/P4
**Probable Cause:** (1-2 sentences)
**Affected Systems:** (comma-separated list)
**Immediate Actions:** (numbered list of 3-5 steps)
**Relevant Keywords:** (for runbook matching)
```

**Design decisions:**
- Strict output format ensures the triage report is consistently structured and readable in the timeline
- Keywords field helps with downstream runbook matching
- Runs via task queue so it doesn't block the user's chat flow
- Result is written directly to SQLite and broadcast to all connected clients

---

## 3. Tool Descriptions

Each tool has a `description` field that the LLM uses to decide when to invoke it. These are effectively prompts that guide tool selection.

**Location:** `src/server.ts` — `tools` object in `onChatMessage()`

### declareIncident
```
Declare a new production incident. Use when a user reports a service issue, outage, or degradation. Always declare incidents for real problems.
```

### updateIncident
```
Post a status update to an active incident. Use when there is new information, a status change, or progress to report.
```

### resolveIncident
```
Resolve an active incident. Calculates MTTR and records the resolution summary.
```

### listIncidents
```
List incidents. Can filter by status and/or severity.
```

### searchRunbooks
```
Search runbooks by keyword or tag. Use when a user asks for help with a specific type of incident or when triaging.
```

### getRunbookDetail
```
Get the full content of a specific runbook by ID.
```

### addRunbook
```
Add a new runbook to the knowledge base. Requires approval.
```

### getIncidentTimeline
```
Get the full timeline of updates for a specific incident.
```

### scheduleHealthCheck
```
Schedule periodic health checks for specified services. Uses cron scheduling.
```

### generatePostmortem
```
Generate a postmortem report for a resolved incident. This is a client-side tool — the browser will render the document.
```

### getAnalytics
```
Get incident analytics: MTTR, counts by severity, resolution rates.
```

### scheduleTask
```
Schedule a reminder or follow-up task. Use when the user asks to be reminded of something.
```

### getUserTimezone
```
Get the user's timezone from their browser for accurate scheduling.
```

---

## 4. Development Prompts (AI-Assisted Coding)

The following prompts were used with AI coding assistants during development:

### Initial Architecture
```
cloudflare says Optional Assignment Instructions: We plan to fast track review of candidates who complete an assignment to build a type of AI-powered application (https://agents.cloudflare.com/) on Cloudflare. An AI-powered application should include the following components:
* LLM (recommend using Llama 3.3 on Workers AI), or an external LLM of your choice
* Workflow / coordination (recommend using Workflows, Workers or Durable Objects)
* User input via chat or voice (recommend using Pages or Realtime)
* Memory or state

[The AI assistant designed the incident commander concept and architecture based on this brief, choosing the incident management domain because it naturally exercises all required components and resonates with Cloudflare's engineering culture.]
```

### Implementation
```
Implement the plan as specified [referencing the detailed architecture plan for the AI Incident Response Commander, which included: SQL schema design, 11 tools, queue-based async triage, callable RPC methods, three-column React UI with incident sidebar + chat + timeline, and human-in-the-loop approval flows].
```

---

## 5. Seeded Runbook Content

**Location:** `src/server.ts` — `seedRunbooksIfEmpty()` method

While not LLM prompts per se, these runbooks serve as the agent's knowledge base and inform its triage suggestions:

1. **High API Latency Response** — tags: api, latency, performance
2. **Database Connection Failure** — tags: database, connection, outage
3. **Service Deployment Rollback** — tags: deployment, rollback, kubernetes
4. **SSL/TLS Certificate Expiry** — tags: ssl, tls, certificate, security
5. **Memory Leak Investigation** — tags: memory, leak, performance, debugging

These were written to cover common production incident categories and provide the AI with relevant context when triaging similar issues.
