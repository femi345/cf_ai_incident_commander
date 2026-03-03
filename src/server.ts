import { createWorkersAI } from "workers-ai-provider";
import { routeAgentRequest, callable, type Schedule } from "agents";
import { getSchedulePrompt, scheduleSchema } from "agents/schedule";
import { AIChatAgent, type OnChatMessageOptions } from "@cloudflare/ai-chat";
import {
  streamText,
  convertToModelMessages,
  pruneMessages,
  tool,
  stepCountIs
} from "ai";
import { z } from "zod";

// ── Types ────────────────────────────────────────────────────────────────

type Severity = "P1" | "P2" | "P3" | "P4";
type IncidentStatus = "open" | "investigating" | "mitigating" | "resolved";

interface Incident {
  id: string;
  title: string;
  severity: Severity;
  status: IncidentStatus;
  description: string;
  affected_services: string;
  created_at: string;
  resolved_at: string | null;
}

interface IncidentUpdate {
  id: string;
  incident_id: string;
  content: string;
  author: string;
  created_at: string;
}

interface Runbook {
  id: string;
  title: string;
  content: string;
  tags: string;
  created_at: string;
}

interface AgentState {
  activeIncidentCount: number;
  selectedIncidentId: string | null;
  lastHealthCheck: string | null;
  healthCheckResults: Array<{ service: string; status: string; checkedAt: string }>;
}

// ── Agent ────────────────────────────────────────────────────────────────

export class IncidentAgent extends AIChatAgent<Env, AgentState> {
  initialState: AgentState = {
    activeIncidentCount: 0,
    selectedIncidentId: null,
    lastHealthCheck: null,
    healthCheckResults: []
  };

  onStart() {
    this.sql`
      CREATE TABLE IF NOT EXISTS incidents (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        severity TEXT NOT NULL CHECK(severity IN ('P1','P2','P3','P4')),
        status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','investigating','mitigating','resolved')),
        description TEXT NOT NULL,
        affected_services TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        resolved_at TEXT
      )
    `;
    this.sql`
      CREATE TABLE IF NOT EXISTS incident_updates (
        id TEXT PRIMARY KEY,
        incident_id TEXT NOT NULL,
        content TEXT NOT NULL,
        author TEXT NOT NULL DEFAULT 'system',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (incident_id) REFERENCES incidents(id)
      )
    `;
    this.sql`
      CREATE TABLE IF NOT EXISTS runbooks (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        tags TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `;

    this.syncActiveCount();
    this.seedRunbooksIfEmpty();
  }

  private syncActiveCount() {
    const rows = this.sql<{ count: number }>`
      SELECT COUNT(*) as count FROM incidents WHERE status != 'resolved'
    `;
    const count = rows[0]?.count ?? 0;
    this.setState({ ...this.state, activeIncidentCount: count });
  }

  private seedRunbooksIfEmpty() {
    const existing = this.sql<{ count: number }>`SELECT COUNT(*) as count FROM runbooks`;
    if ((existing[0]?.count ?? 0) > 0) return;

    const runbooks = [
      {
        id: crypto.randomUUID(),
        title: "High API Latency Response",
        content: "1. Check API gateway metrics for error rate spikes\n2. Verify upstream service health\n3. Check database connection pool utilization\n4. Review recent deployments for regressions\n5. If load-related: scale horizontally\n6. If single-service: restart affected pods\n7. Monitor for 15 min after mitigation",
        tags: "api,latency,performance"
      },
      {
        id: crypto.randomUUID(),
        title: "Database Connection Failure",
        content: "1. Verify database instance status in cloud console\n2. Check connection pool exhaustion\n3. Review slow query log for long-running transactions\n4. Check disk space and IOPS\n5. If primary down: initiate failover to replica\n6. Notify on-call DBA\n7. Post-resolution: review connection pool settings",
        tags: "database,connection,outage"
      },
      {
        id: crypto.randomUUID(),
        title: "Service Deployment Rollback",
        content: "1. Identify the failing deployment version\n2. Run: kubectl rollout undo deployment/<service-name>\n3. Verify rollback completed: kubectl rollout status\n4. Check service health endpoints\n5. Review deployment logs for root cause\n6. Create post-deployment incident report\n7. Fix and re-deploy through staging first",
        tags: "deployment,rollback,kubernetes"
      },
      {
        id: crypto.randomUUID(),
        title: "SSL/TLS Certificate Expiry",
        content: "1. Identify which certificate is expiring/expired\n2. Check cert-manager logs for renewal failures\n3. If auto-renewal failed: manually trigger renewal\n4. If manual cert: generate new CSR and submit to CA\n5. Deploy new certificate\n6. Verify with: openssl s_client -connect host:443\n7. Set up monitoring alert for 30-day expiry warning",
        tags: "ssl,tls,certificate,security"
      },
      {
        id: crypto.randomUUID(),
        title: "Memory Leak Investigation",
        content: "1. Identify affected service from monitoring alerts\n2. Capture heap dump: kill -USR1 <pid>\n3. Check container memory limits vs actual usage\n4. Review recent code changes for resource leaks\n5. Temporary fix: restart service with rolling update\n6. Analyze heap dump for retained objects\n7. Deploy fix and monitor memory trajectory for 24h",
        tags: "memory,leak,performance,debugging"
      }
    ];

    for (const rb of runbooks) {
      this.sql`
        INSERT INTO runbooks (id, title, content, tags)
        VALUES (${rb.id}, ${rb.title}, ${rb.content}, ${rb.tags})
      `;
    }
  }

  private addTimelineEntry(incidentId: string, content: string, author: string) {
    const id = crypto.randomUUID();
    this.sql`
      INSERT INTO incident_updates (id, incident_id, content, author)
      VALUES (${id}, ${incidentId}, ${content}, ${author})
    `;
  }

  // ── Callable RPC methods (for sidebar/timeline) ──────────────────────

  @callable()
  getActiveIncidents(): Incident[] {
    return this.sql<Incident>`
      SELECT * FROM incidents WHERE status != 'resolved'
      ORDER BY
        CASE severity WHEN 'P1' THEN 1 WHEN 'P2' THEN 2 WHEN 'P3' THEN 3 ELSE 4 END,
        created_at DESC
    `;
  }

  @callable()
  getAllIncidents(): Incident[] {
    return this.sql<Incident>`
      SELECT * FROM incidents ORDER BY created_at DESC LIMIT 50
    `;
  }

  @callable()
  getIncidentDetail(incidentId: string): {
    incident: Incident | null;
    updates: IncidentUpdate[];
  } {
    const incidents = this.sql<Incident>`
      SELECT * FROM incidents WHERE id = ${incidentId}
    `;
    const updates = this.sql<IncidentUpdate>`
      SELECT * FROM incident_updates WHERE incident_id = ${incidentId}
      ORDER BY created_at ASC
    `;
    this.setState({ ...this.state, selectedIncidentId: incidentId });
    return { incident: incidents[0] ?? null, updates };
  }

  @callable()
  getRunbooks(): Runbook[] {
    return this.sql<Runbook>`SELECT * FROM runbooks ORDER BY created_at DESC`;
  }

  // ── Queue handler for async triage ───────────────────────────────────

  async processTriageQueue(
    payload: { incidentId: string; description: string; title: string },
  ) {
    try {
      const workersai = createWorkersAI({ binding: this.env.AI });
      const result = streamText({
        model: workersai("@cf/meta/llama-3.3-70b-instruct-fp8-fast"),
        prompt: `You are an expert incident response engineer. Analyze this incident and provide a triage assessment.

Incident: "${payload.title}"
Description: "${payload.description}"

Respond in this exact format:
**Suggested Severity:** P1/P2/P3/P4
**Probable Cause:** (1-2 sentences)
**Affected Systems:** (comma-separated list)
**Immediate Actions:** (numbered list of 3-5 steps)
**Relevant Keywords:** (for runbook matching)`,
      });
      let text = "";
      for await (const chunk of result.textStream) {
        text += chunk;
      }

      this.addTimelineEntry(payload.incidentId, `**AI Triage Report**\n\n${text}`, "ai");

      this.broadcast(
        JSON.stringify({
          type: "triage-complete",
          incidentId: payload.incidentId,
          timestamp: new Date().toISOString()
        })
      );
    } catch (error) {
      this.addTimelineEntry(
        payload.incidentId,
        `AI triage failed: ${error instanceof Error ? error.message : "Unknown error"}`,
        "system"
      );
    }
  }

  // ── Scheduled task handlers ──────────────────────────────────────────

  async executeHealthCheck(
    payload: { services: string[] },
    _task: Schedule<{ services: string[] }>
  ) {
    const results = payload.services.map((service) => {
      const latency = Math.floor(Math.random() * 500) + 10;
      const isHealthy = Math.random() > 0.15;
      return {
        service,
        status: isHealthy ? (latency > 300 ? "degraded" : "healthy") : "down",
        latencyMs: latency,
        checkedAt: new Date().toISOString()
      };
    });

    const unhealthy = results.filter((r) => r.status !== "healthy");

    this.setState({
      ...this.state,
      lastHealthCheck: new Date().toISOString(),
      healthCheckResults: results.map((r) => ({
        service: r.service,
        status: r.status,
        checkedAt: r.checkedAt
      }))
    });

    this.broadcast(
      JSON.stringify({
        type: "health-check",
        results,
        timestamp: new Date().toISOString()
      })
    );

    if (unhealthy.length > 0) {
      this.broadcast(
        JSON.stringify({
          type: "health-alert",
          services: unhealthy,
          timestamp: new Date().toISOString()
        })
      );
    }
  }

  async executeScheduledReminder(
    description: string,
    _task: Schedule<string>
  ) {
    this.broadcast(
      JSON.stringify({
        type: "scheduled-task",
        description,
        timestamp: new Date().toISOString()
      })
    );
  }

  // ── Chat handler ─────────────────────────────────────────────────────

  async onChatMessage(_onFinish: unknown, options?: OnChatMessageOptions) {
    const workersai = createWorkersAI({ binding: this.env.AI });

    const activeIncidents = this.sql<Incident>`
      SELECT id, title, severity, status FROM incidents WHERE status != 'resolved'
      ORDER BY created_at DESC LIMIT 5
    `;
    const activeContext = activeIncidents.length > 0
      ? `\n\nCurrently active incidents:\n${activeIncidents.map((i) => `- [${i.severity}] ${i.title} (${i.status}) — ID: ${i.id}`).join("\n")}`
      : "\n\nNo active incidents right now.";

    const result = streamText({
      model: workersai("@cf/meta/llama-4-scout-17b-16e-instruct"),
      system: `You are an AI Incident Response Commander. You help DevOps teams manage, triage, and resolve production incidents efficiently.

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

${getSchedulePrompt({ date: new Date() })}
${activeContext}`,
      messages: pruneMessages({
        messages: await convertToModelMessages(this.messages),
        toolCalls: "before-last-2-messages"
      }),
      tools: {
        declareIncident: tool({
          description:
            "Declare a new production incident. Use when a user reports a service issue, outage, or degradation. Always declare incidents for real problems.",
          inputSchema: z.object({
            title: z.string().describe("Short incident title"),
            severity: z
              .enum(["P1", "P2", "P3", "P4"])
              .describe("P1=critical outage, P2=major degradation, P3=minor issue, P4=low-impact"),
            description: z.string().describe("Detailed description of the incident"),
            affected_services: z
              .string()
              .describe("Comma-separated list of affected services")
          }),
          needsApproval: async () => true,
          execute: async ({ title, severity, description, affected_services }) => {
            const id = crypto.randomUUID();
            this.sql`
              INSERT INTO incidents (id, title, severity, description, affected_services)
              VALUES (${id}, ${title}, ${severity}, ${description}, ${affected_services})
            `;
            this.addTimelineEntry(id, `Incident declared: **${title}** [${severity}]\n\n${description}\n\nAffected services: ${affected_services}`, "user");

            await this.queue("processTriageQueue", {
              incidentId: id,
              description,
              title
            });

            this.syncActiveCount();
            return {
              incidentId: id,
              message: `Incident "${title}" declared as ${severity}. AI triage is running in the background.`
            };
          }
        }),

        updateIncident: tool({
          description:
            "Post a status update to an active incident. Use when there is new information, a status change, or progress to report.",
          inputSchema: z.object({
            incidentId: z.string().describe("ID of the incident to update"),
            status: z
              .enum(["open", "investigating", "mitigating", "resolved"])
              .describe("New status for the incident")
              .optional(),
            update: z.string().describe("The status update content")
          }),
          execute: async ({ incidentId, status, update }) => {
            const incidents = this.sql<Incident>`
              SELECT * FROM incidents WHERE id = ${incidentId}
            `;
            if (incidents.length === 0) return { error: "Incident not found" };

            if (status) {
              this.sql`UPDATE incidents SET status = ${status} WHERE id = ${incidentId}`;
              this.addTimelineEntry(incidentId, `Status changed to **${status}**`, "system");
            }
            this.addTimelineEntry(incidentId, update, "user");
            this.syncActiveCount();

            this.broadcast(
              JSON.stringify({ type: "incident-updated", incidentId, timestamp: new Date().toISOString() })
            );
            return { message: `Incident updated${status ? ` — status: ${status}` : ""}.` };
          }
        }),

        resolveIncident: tool({
          description:
            "Resolve an active incident. Calculates MTTR and records the resolution summary.",
          inputSchema: z.object({
            incidentId: z.string().describe("ID of the incident to resolve"),
            resolution: z.string().describe("Summary of how the incident was resolved")
          }),
          execute: async ({ incidentId, resolution }) => {
            const incidents = this.sql<Incident>`
              SELECT * FROM incidents WHERE id = ${incidentId}
            `;
            if (incidents.length === 0) return { error: "Incident not found" };
            const incident = incidents[0];

            const now = new Date();
            const created = new Date(incident.created_at);
            const mttrMinutes = Math.round((now.getTime() - created.getTime()) / 60000);

            this.sql`
              UPDATE incidents SET status = 'resolved', resolved_at = datetime('now')
              WHERE id = ${incidentId}
            `;
            this.addTimelineEntry(
              incidentId,
              `**Incident Resolved** (MTTR: ${mttrMinutes} minutes)\n\n${resolution}`,
              "system"
            );
            this.syncActiveCount();

            this.broadcast(
              JSON.stringify({ type: "incident-resolved", incidentId, timestamp: new Date().toISOString() })
            );
            return {
              message: `Incident "${incident.title}" resolved. MTTR: ${mttrMinutes} minutes.`,
              mttrMinutes
            };
          }
        }),

        listIncidents: tool({
          description: "List incidents. Can filter by status and/or severity.",
          inputSchema: z.object({
            status: z
              .enum(["open", "investigating", "mitigating", "resolved", "all"])
              .describe("Filter by status, or 'all'")
              .optional(),
            severity: z
              .enum(["P1", "P2", "P3", "P4", "all"])
              .describe("Filter by severity, or 'all'")
              .optional()
          }),
          execute: async ({ status, severity }) => {
            let incidents: Incident[];
            if (status && status !== "all" && severity && severity !== "all") {
              incidents = this.sql<Incident>`
                SELECT * FROM incidents WHERE status = ${status} AND severity = ${severity}
                ORDER BY created_at DESC LIMIT 20
              `;
            } else if (status && status !== "all") {
              incidents = this.sql<Incident>`
                SELECT * FROM incidents WHERE status = ${status}
                ORDER BY created_at DESC LIMIT 20
              `;
            } else if (severity && severity !== "all") {
              incidents = this.sql<Incident>`
                SELECT * FROM incidents WHERE severity = ${severity}
                ORDER BY created_at DESC LIMIT 20
              `;
            } else {
              incidents = this.sql<Incident>`
                SELECT * FROM incidents ORDER BY created_at DESC LIMIT 20
              `;
            }
            return incidents.length > 0
              ? incidents.map((i) => ({
                  id: i.id,
                  title: i.title,
                  severity: i.severity,
                  status: i.status,
                  created: i.created_at,
                  resolved: i.resolved_at
                }))
              : "No incidents found matching the criteria.";
          }
        }),

        searchRunbooks: tool({
          description:
            "Search runbooks by keyword or tag. Use when a user asks for help with a specific type of incident or when triaging.",
          inputSchema: z.object({
            query: z.string().describe("Search term — matches against title, content, and tags")
          }),
          execute: async ({ query }) => {
            const q = `%${query.toLowerCase()}%`;
            const results = this.sql<Runbook>`
              SELECT * FROM runbooks
              WHERE LOWER(title) LIKE ${q}
                 OR LOWER(content) LIKE ${q}
                 OR LOWER(tags) LIKE ${q}
              LIMIT 5
            `;
            return results.length > 0
              ? results.map((r) => ({
                  id: r.id,
                  title: r.title,
                  tags: r.tags,
                  preview: r.content.substring(0, 200) + (r.content.length > 200 ? "..." : "")
                }))
              : "No runbooks found. Try different search terms.";
          }
        }),

        getRunbookDetail: tool({
          description: "Get the full content of a specific runbook by ID.",
          inputSchema: z.object({
            runbookId: z.string().describe("The runbook ID")
          }),
          execute: async ({ runbookId }) => {
            const results = this.sql<Runbook>`
              SELECT * FROM runbooks WHERE id = ${runbookId}
            `;
            return results.length > 0
              ? results[0]
              : "Runbook not found.";
          }
        }),

        addRunbook: tool({
          description: "Add a new runbook to the knowledge base. Requires approval.",
          inputSchema: z.object({
            title: z.string().describe("Runbook title"),
            content: z.string().describe("Step-by-step runbook content in markdown"),
            tags: z.string().describe("Comma-separated tags for searchability")
          }),
          needsApproval: async () => true,
          execute: async ({ title, content, tags }) => {
            const id = crypto.randomUUID();
            this.sql`
              INSERT INTO runbooks (id, title, content, tags)
              VALUES (${id}, ${title}, ${content}, ${tags})
            `;
            return { runbookId: id, message: `Runbook "${title}" added.` };
          }
        }),

        getIncidentTimeline: tool({
          description: "Get the full timeline of updates for a specific incident.",
          inputSchema: z.object({
            incidentId: z.string().describe("The incident ID")
          }),
          execute: async ({ incidentId }) => {
            const incidents = this.sql<Incident>`
              SELECT * FROM incidents WHERE id = ${incidentId}
            `;
            if (incidents.length === 0) return { error: "Incident not found" };

            const updates = this.sql<IncidentUpdate>`
              SELECT * FROM incident_updates WHERE incident_id = ${incidentId}
              ORDER BY created_at ASC
            `;
            return {
              incident: incidents[0],
              timeline: updates.map((u) => ({
                content: u.content,
                author: u.author,
                time: u.created_at
              }))
            };
          }
        }),

        scheduleHealthCheck: tool({
          description:
            "Schedule periodic health checks for specified services. Uses cron scheduling.",
          inputSchema: z.object({
            services: z
              .array(z.string())
              .describe("List of service names to monitor"),
            intervalMinutes: z
              .number()
              .describe("How often to run health checks, in minutes")
          }),
          execute: async ({ services, intervalMinutes }) => {
            try {
              const delaySeconds = intervalMinutes * 60;
              this.schedule(delaySeconds, "executeHealthCheck", { services });
              return {
                message: `Health check scheduled for [${services.join(", ")}] in ${intervalMinutes} minutes.`
              };
            } catch (error) {
              return { error: `Failed to schedule: ${error}` };
            }
          }
        }),

        generatePostmortem: tool({
          description:
            "Generate a postmortem report for a resolved incident. This is a client-side tool — the browser will render the document.",
          inputSchema: z.object({
            incidentId: z.string().describe("The incident ID to generate a postmortem for")
          })
        }),

        getAnalytics: tool({
          description:
            "Get incident analytics: MTTR, counts by severity, resolution rates.",
          inputSchema: z.object({}),
          execute: async () => {
            const total = this.sql<{ count: number }>`
              SELECT COUNT(*) as count FROM incidents
            `;
            const resolved = this.sql<{ count: number }>`
              SELECT COUNT(*) as count FROM incidents WHERE status = 'resolved'
            `;
            const active = this.sql<{ count: number }>`
              SELECT COUNT(*) as count FROM incidents WHERE status != 'resolved'
            `;
            const bySeverity = this.sql<{ severity: string; count: number }>`
              SELECT severity, COUNT(*) as count FROM incidents GROUP BY severity
              ORDER BY CASE severity WHEN 'P1' THEN 1 WHEN 'P2' THEN 2 WHEN 'P3' THEN 3 ELSE 4 END
            `;
            const avgMttr = this.sql<{ avg_mttr: number | null }>`
              SELECT AVG(
                (julianday(resolved_at) - julianday(created_at)) * 24 * 60
              ) as avg_mttr
              FROM incidents WHERE resolved_at IS NOT NULL
            `;

            return {
              totalIncidents: total[0]?.count ?? 0,
              resolvedIncidents: resolved[0]?.count ?? 0,
              activeIncidents: active[0]?.count ?? 0,
              avgMttrMinutes: avgMttr[0]?.avg_mttr
                ? Math.round(avgMttr[0].avg_mttr)
                : null,
              bySeverity: bySeverity.reduce(
                (acc, row) => ({ ...acc, [row.severity]: row.count }),
                {} as Record<string, number>
              )
            };
          }
        }),

        scheduleTask: tool({
          description:
            "Schedule a reminder or follow-up task. Use when the user asks to be reminded of something.",
          inputSchema: scheduleSchema,
          execute: async ({ when, description }) => {
            if (when.type === "no-schedule") return "Not a valid schedule input";
            const input =
              when.type === "scheduled"
                ? when.date
                : when.type === "delayed"
                  ? when.delayInSeconds
                  : when.type === "cron"
                    ? when.cron
                    : null;
            if (!input) return "Invalid schedule type";
            try {
              this.schedule(input, "executeScheduledReminder", description);
              return `Task scheduled: "${description}" (${when.type}: ${input})`;
            } catch (error) {
              return `Error scheduling task: ${error}`;
            }
          }
        }),

        getUserTimezone: tool({
          description: "Get the user's timezone from their browser for accurate scheduling.",
          inputSchema: z.object({})
        })
      },
      stopWhen: stepCountIs(5),
      abortSignal: options?.abortSignal
    });

    return result.toUIMessageStreamResponse();
  }
}

// ── Worker entrypoint ────────────────────────────────────────────────────

export default {
  async fetch(request: Request, env: Env) {
    return (
      (await routeAgentRequest(request, env)) ||
      new Response("Not found", { status: 404 })
    );
  }
} satisfies ExportedHandler<Env>;
