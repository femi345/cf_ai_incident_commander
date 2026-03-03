import { Suspense, useCallback, useState, useEffect, useRef } from "react";
import { useAgent } from "agents/react";
import { useAgentChat } from "@cloudflare/ai-chat/react";
import { isToolUIPart, getToolName } from "ai";
import type { UIMessage } from "ai";
import {
  Button,
  Badge,
  InputArea,
  Empty,
  Surface,
  Text
} from "@cloudflare/kumo";
import {
  Toasty,
  useKumoToastManager
} from "@cloudflare/kumo/components/toast";
import { Streamdown } from "streamdown";
import {
  PaperPlaneRightIcon,
  StopIcon,
  TrashIcon,
  GearIcon,
  CircleIcon,
  MoonIcon,
  SunIcon,
  CheckCircleIcon,
  XCircleIcon,
  BrainIcon,
  CaretDownIcon,
  WarningIcon,
  SirenIcon,
  ClockIcon,
  BookOpenIcon,
  ChartBarIcon,
  HeartbeatIcon,
  ListBulletsIcon,
  CaretLeftIcon,
  CaretRightIcon,
  ShieldCheckIcon,
  ArrowClockwiseIcon,
  FileTextIcon
} from "@phosphor-icons/react";

// ── Types ────────────────────────────────────────────────────────────────

interface Incident {
  id: string;
  title: string;
  severity: "P1" | "P2" | "P3" | "P4";
  status: "open" | "investigating" | "mitigating" | "resolved";
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

interface AgentState {
  activeIncidentCount: number;
  selectedIncidentId: string | null;
  lastHealthCheck: string | null;
  healthCheckResults: Array<{
    service: string;
    status: string;
    checkedAt: string;
  }>;
}

// ── Helpers ──────────────────────────────────────────────────────────────

const SEVERITY_COLORS: Record<string, string> = {
  P1: "bg-red-500/15 text-red-400 ring-red-500/30",
  P2: "bg-orange-500/15 text-orange-400 ring-orange-500/30",
  P3: "bg-yellow-500/15 text-yellow-400 ring-yellow-500/30",
  P4: "bg-blue-500/15 text-blue-400 ring-blue-500/30"
};

const STATUS_COLORS: Record<string, string> = {
  open: "bg-red-500/15 text-red-400",
  investigating: "bg-orange-500/15 text-orange-400",
  mitigating: "bg-yellow-500/15 text-yellow-400",
  resolved: "bg-emerald-500/15 text-emerald-400"
};

const SEVERITY_DOTS: Record<string, string> = {
  P1: "text-red-500",
  P2: "text-orange-500",
  P3: "text-yellow-500",
  P4: "text-blue-500"
};

function sanitizeModelText(text: string): string {
  // Strip leaked JSON tool calls that some models output as text.
  // Matches patterns like {"name":"toolName","parameters":{...}}
  // or {"type":"function","name":...} that should never appear in chat.
  let cleaned = text.replace(
    /\{[\s]*"(?:name|type)"[\s]*:[\s]*"(?:function|[a-zA-Z]+)"[\s]*,[\s]*"(?:parameters|name|function)"[\s]*:[\s]*\{[^}]*\}[\s]*\}/g,
    ""
  );
  // Also catch standalone JSON blocks that look like tool invocations
  cleaned = cleaned.replace(
    /\{[\s]*"(?:type|name)"[\s]*:[\s]*"function"[^}]*\}/g,
    ""
  );
  return cleaned.trim();
}

function timeAgo(dateStr: string): string {
  const now = new Date();
  const date = new Date(dateStr);
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  if (diffMins < 1) return "just now";
  if (diffMins < 60) return `${diffMins}m ago`;
  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  return `${Math.floor(diffHours / 24)}d ago`;
}

// ── Theme toggle ─────────────────────────────────────────────────────────

function ThemeToggle() {
  const [dark, setDark] = useState(
    () => document.documentElement.getAttribute("data-mode") === "dark"
  );
  const toggle = useCallback(() => {
    const next = !dark;
    setDark(next);
    const mode = next ? "dark" : "light";
    document.documentElement.setAttribute("data-mode", mode);
    document.documentElement.style.colorScheme = mode;
    localStorage.setItem("theme", mode);
  }, [dark]);

  return (
    <Button
      variant="secondary"
      shape="square"
      icon={dark ? <SunIcon size={16} /> : <MoonIcon size={16} />}
      onClick={toggle}
      aria-label="Toggle theme"
    />
  );
}

// ── Severity badge ───────────────────────────────────────────────────────

function SeverityBadge({ severity }: { severity: string }) {
  return (
    <span
      className={`inline-flex items-center px-2 py-0.5 rounded-md text-xs font-bold ring-1 ${SEVERITY_COLORS[severity] || ""}`}
    >
      {severity}
    </span>
  );
}

function StatusChip({ status }: { status: string }) {
  return (
    <span
      className={`inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium ${STATUS_COLORS[status] || ""}`}
    >
      {status}
    </span>
  );
}

// ── Tool rendering ───────────────────────────────────────────────────────

function ToolPartView({
  part,
  addToolApprovalResponse
}: {
  part: UIMessage["parts"][number];
  addToolApprovalResponse: (r: { id: string; approved: boolean }) => void;
}) {
  if (!isToolUIPart(part)) return null;
  const toolName = getToolName(part);

  if (part.state === "output-available") {
    return (
      <div className="flex justify-start">
        <Surface className="max-w-[85%] px-4 py-2.5 rounded-xl ring ring-kumo-line">
          <div className="flex items-center gap-2 mb-1">
            <GearIcon size={14} className="text-kumo-inactive" />
            <Text size="xs" variant="secondary" bold>
              {toolName}
            </Text>
            <Badge variant="secondary">Done</Badge>
          </div>
          <div className="font-mono">
            <Text size="xs" variant="secondary">
              {JSON.stringify(part.output, null, 2)}
            </Text>
          </div>
        </Surface>
      </div>
    );
  }

  if ("approval" in part && part.state === "approval-requested") {
    const approvalId = (part.approval as { id?: string })?.id;
    const isIncident = toolName === "declareIncident";
    return (
      <div className="flex justify-start">
        <Surface
          className={`max-w-[85%] px-4 py-3 rounded-xl ring-2 ${isIncident ? "ring-red-500/50" : "ring-kumo-warning"}`}
        >
          <div className="flex items-center gap-2 mb-2">
            {isIncident ? (
              <SirenIcon size={16} className="text-red-400" />
            ) : (
              <GearIcon size={14} className="text-kumo-warning" />
            )}
            <Text size="sm" bold>
              {isIncident ? "Declare Incident?" : `Approve: ${toolName}`}
            </Text>
          </div>
          <div className="font-mono mb-3 bg-kumo-control rounded-lg p-2.5">
            <Text size="xs" variant="secondary">
              {JSON.stringify(part.input, null, 2)}
            </Text>
          </div>
          <div className="flex gap-2">
            <Button
              variant="primary"
              size="sm"
              icon={<CheckCircleIcon size={14} />}
              onClick={() => {
                if (approvalId)
                  addToolApprovalResponse({ id: approvalId, approved: true });
              }}
            >
              {isIncident ? "Declare" : "Approve"}
            </Button>
            <Button
              variant="secondary"
              size="sm"
              icon={<XCircleIcon size={14} />}
              onClick={() => {
                if (approvalId)
                  addToolApprovalResponse({ id: approvalId, approved: false });
              }}
            >
              Reject
            </Button>
          </div>
        </Surface>
      </div>
    );
  }

  if (
    part.state === "output-denied" ||
    ("approval" in part &&
      (part.approval as { approved?: boolean })?.approved === false)
  ) {
    return (
      <div className="flex justify-start">
        <Surface className="max-w-[85%] px-4 py-2.5 rounded-xl ring ring-kumo-line">
          <div className="flex items-center gap-2">
            <XCircleIcon size={14} className="text-kumo-danger" />
            <Text size="xs" variant="secondary" bold>
              {toolName}
            </Text>
            <Badge variant="secondary">Rejected</Badge>
          </div>
        </Surface>
      </div>
    );
  }

  if (part.state === "input-available" || part.state === "input-streaming") {
    return (
      <div className="flex justify-start">
        <Surface className="max-w-[85%] px-4 py-2.5 rounded-xl ring ring-kumo-line">
          <div className="flex items-center gap-2">
            <GearIcon
              size={14}
              className="text-kumo-inactive animate-spin"
            />
            <Text size="xs" variant="secondary">
              Running {toolName}...
            </Text>
          </div>
        </Surface>
      </div>
    );
  }

  return null;
}

// ── Incident sidebar ─────────────────────────────────────────────────────

function IncidentSidebar({
  incidents,
  selectedId,
  onSelect,
  onRefresh,
  collapsed,
  onToggle
}: {
  incidents: Incident[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onRefresh: () => void;
  collapsed: boolean;
  onToggle: () => void;
}) {
  const active = incidents.filter((i) => i.status !== "resolved");
  const resolved = incidents.filter((i) => i.status === "resolved");

  if (collapsed) {
    return (
      <div className="w-12 border-r border-kumo-line bg-kumo-base flex flex-col items-center py-4 gap-3 shrink-0">
        <button
          onClick={onToggle}
          className="p-2 rounded-lg hover:bg-kumo-control transition-colors"
          aria-label="Expand sidebar"
        >
          <CaretRightIcon size={16} className="text-kumo-subtle" />
        </button>
        {active.length > 0 && (
          <div className="flex flex-col items-center gap-1">
            <SirenIcon size={16} className="text-red-400" />
            <span className="text-[10px] font-bold text-red-400">
              {active.length}
            </span>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="w-72 border-r border-kumo-line bg-kumo-base flex flex-col shrink-0">
      <div className="px-4 py-3 border-b border-kumo-line flex items-center justify-between">
        <div className="flex items-center gap-2">
          <SirenIcon size={16} className="text-red-400" />
          <Text size="sm" bold>
            Incidents
          </Text>
          {active.length > 0 && (
            <Badge variant="destructive">{active.length}</Badge>
          )}
        </div>
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            shape="square"
            icon={<ArrowClockwiseIcon size={14} />}
            onClick={onRefresh}
            aria-label="Refresh"
          />
          <Button
            variant="ghost"
            size="sm"
            shape="square"
            icon={<CaretLeftIcon size={14} />}
            onClick={onToggle}
            aria-label="Collapse"
          />
        </div>
      </div>

      <div className="flex-1 overflow-y-auto">
        {active.length > 0 && (
          <div className="p-3">
            <span className="px-1 mb-2 block uppercase tracking-wider">
              <Text size="xs" variant="secondary" bold>
                Active
              </Text>
            </span>
            <div className="space-y-1.5">
              {active.map((incident) => (
                <button
                  key={incident.id}
                  onClick={() => onSelect(incident.id)}
                  className={`w-full text-left p-2.5 rounded-lg transition-colors ${
                    selectedId === incident.id
                      ? "bg-kumo-control ring-1 ring-kumo-accent"
                      : "hover:bg-kumo-control/50"
                  }`}
                >
                  <div className="flex items-center gap-2 mb-1">
                    <CircleIcon
                      size={8}
                      weight="fill"
                      className={SEVERITY_DOTS[incident.severity]}
                    />
                    <span className="text-sm font-medium text-kumo-default truncate flex-1">
                      {incident.title}
                    </span>
                    <SeverityBadge severity={incident.severity} />
                  </div>
                  <div className="flex items-center gap-2 pl-4">
                    <StatusChip status={incident.status} />
                    <span className="text-[11px] text-kumo-subtle">
                      {timeAgo(incident.created_at)}
                    </span>
                  </div>
                </button>
              ))}
            </div>
          </div>
        )}

        {resolved.length > 0 && (
          <div className="p-3 border-t border-kumo-line">
            <span className="px-1 mb-2 block uppercase tracking-wider">
              <Text size="xs" variant="secondary" bold>
                Resolved
              </Text>
            </span>
            <div className="space-y-1.5">
              {resolved.slice(0, 5).map((incident) => (
                <button
                  key={incident.id}
                  onClick={() => onSelect(incident.id)}
                  className={`w-full text-left p-2.5 rounded-lg transition-colors opacity-60 ${
                    selectedId === incident.id
                      ? "bg-kumo-control ring-1 ring-kumo-accent opacity-100"
                      : "hover:bg-kumo-control/50"
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <ShieldCheckIcon size={14} className="text-emerald-400" />
                    <span className="text-sm text-kumo-default truncate flex-1">
                      {incident.title}
                    </span>
                    <SeverityBadge severity={incident.severity} />
                  </div>
                </button>
              ))}
            </div>
          </div>
        )}

        {incidents.length === 0 && (
          <div className="p-6 text-center">
            <ShieldCheckIcon
              size={32}
              className="text-emerald-400 mx-auto mb-2"
            />
            <Text size="sm" variant="secondary">
              All clear
            </Text>
            <Text size="xs" variant="secondary">
              No incidents reported
            </Text>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Timeline panel ───────────────────────────────────────────────────────

function TimelinePanel({
  incident,
  updates,
  onClose
}: {
  incident: Incident | null;
  updates: IncidentUpdate[];
  onClose: () => void;
}) {
  if (!incident) return null;

  return (
    <div className="w-80 border-l border-kumo-line bg-kumo-base flex flex-col shrink-0">
      <div className="px-4 py-3 border-b border-kumo-line">
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-2">
            <ClockIcon size={16} className="text-kumo-accent" />
            <Text size="sm" bold>
              Timeline
            </Text>
          </div>
          <Button
            variant="ghost"
            size="sm"
            shape="square"
            icon={<CaretRightIcon size={14} />}
            onClick={onClose}
            aria-label="Close timeline"
          />
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <SeverityBadge severity={incident.severity} />
          <StatusChip status={incident.status} />
        </div>
        <span className="mt-1.5 block">
          <Text size="sm" bold>
            {incident.title}
          </Text>
        </span>
        {incident.affected_services && (
          <span className="mt-1 block">
            <Text size="xs" variant="secondary">
              Services: {incident.affected_services}
            </Text>
          </span>
        )}
      </div>

      <div className="flex-1 overflow-y-auto p-4">
        {updates.length === 0 ? (
          <span className="text-center py-4 block">
            <Text size="xs" variant="secondary">
              No updates yet
            </Text>
          </span>
        ) : (
          <div className="relative">
            <div className="absolute left-[7px] top-2 bottom-2 w-px bg-kumo-line" />
            <div className="space-y-4">
              {updates.map((update) => (
                <div key={update.id} className="relative pl-6">
                  <div
                    className={`absolute left-0 top-1.5 w-[15px] h-[15px] rounded-full border-2 ${
                      update.author === "ai"
                        ? "bg-purple-500/20 border-purple-500"
                        : update.author === "system"
                          ? "bg-kumo-control border-kumo-line"
                          : "bg-kumo-accent/20 border-kumo-accent"
                    }`}
                  />
                  <div className="flex items-center gap-2 mb-0.5">
                    <span
                      className={`text-[10px] font-bold uppercase tracking-wider ${
                        update.author === "ai"
                          ? "text-purple-400"
                          : update.author === "system"
                            ? "text-kumo-subtle"
                            : "text-kumo-accent"
                      }`}
                    >
                      {update.author}
                    </span>
                    <span className="text-[10px] text-kumo-subtle">
                      {timeAgo(update.created_at)}
                    </span>
                  </div>
                  <div className="text-sm text-kumo-default leading-relaxed whitespace-pre-wrap break-words">
                    {update.content}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Main chat ────────────────────────────────────────────────────────────

function Dashboard() {
  const [connected, setConnected] = useState(false);
  const [input, setInput] = useState("");
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [incidents, setIncidents] = useState<Incident[]>([]);
  const [selectedIncident, setSelectedIncident] = useState<Incident | null>(
    null
  );
  const [timelineUpdates, setTimelineUpdates] = useState<IncidentUpdate[]>([]);
  const [agentState, setAgentState] = useState<AgentState | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const toasts = useKumoToastManager();

  const agent = useAgent({
    agent: "IncidentAgent",
    onOpen: useCallback(() => setConnected(true), []),
    onClose: useCallback(() => setConnected(false), []),
    onError: useCallback(
      (error: Event) => console.error("WebSocket error:", error),
      []
    ),
    onStateUpdate: useCallback((state: AgentState) => {
      setAgentState(state);
    }, []),
    onMessage: useCallback(
      (message: MessageEvent) => {
        try {
          const data = JSON.parse(String(message.data));
          if (data.type === "scheduled-task") {
            toasts.add({
              title: "Reminder",
              description: data.description,
              timeout: 0
            });
          }
          if (data.type === "health-check") {
            toasts.add({
              title: "Health Check Complete",
              description: `${data.results.length} services checked`,
              timeout: 5000
            });
          }
          if (data.type === "health-alert") {
            toasts.add({
              title: "Health Alert",
              description: `${data.services.length} service(s) unhealthy: ${data.services.map((s: { service: string }) => s.service).join(", ")}`,
              timeout: 0
            });
          }
          if (
            data.type === "triage-complete" ||
            data.type === "incident-updated" ||
            data.type === "incident-resolved"
          ) {
            refreshIncidents();
            if (
              selectedIncident &&
              data.incidentId === selectedIncident.id
            ) {
              loadTimeline(data.incidentId);
            }
          }
        } catch {
          // Not JSON or not our event
        }
      },
      // eslint-disable-next-line react-hooks/exhaustive-deps
      [toasts, selectedIncident]
    )
  });

  const refreshIncidents = useCallback(async () => {
    try {
      const result = await agent.call("getAllIncidents", []);
      setIncidents(result as Incident[]);
    } catch {
      // Agent not ready yet
    }
  }, [agent]);

  const loadTimeline = useCallback(
    async (incidentId: string) => {
      try {
        const result = (await agent.call("getIncidentDetail", [
          incidentId
        ])) as { incident: Incident | null; updates: IncidentUpdate[] };
        if (result.incident) {
          setSelectedIncident(result.incident);
          setTimelineUpdates(result.updates);
        }
      } catch {
        // Agent not ready
      }
    },
    [agent]
  );

  useEffect(() => {
    if (connected) {
      refreshIncidents();
    }
  }, [connected, refreshIncidents]);

  useEffect(() => {
    if (connected && agentState && agentState.activeIncidentCount >= 0) {
      refreshIncidents();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentState?.activeIncidentCount]);

  const {
    messages,
    sendMessage,
    clearHistory,
    addToolApprovalResponse,
    stop,
    status
  } = useAgentChat({
    agent,
    onToolCall: async (event) => {
      if (
        "addToolOutput" in event &&
        event.toolCall.toolName === "getUserTimezone"
      ) {
        event.addToolOutput({
          toolCallId: event.toolCall.toolCallId,
          output: {
            timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
            localTime: new Date().toLocaleTimeString()
          }
        });
      }
      if (
        "addToolOutput" in event &&
        event.toolCall.toolName === "generatePostmortem"
      ) {
        const incidentId = (event.toolCall.input as { incidentId: string })
          .incidentId;
        try {
          const detail = (await agent.call("getIncidentDetail", [
            incidentId
          ])) as { incident: Incident | null; updates: IncidentUpdate[] };
          if (detail.incident) {
            const inc = detail.incident;
            const mttr = inc.resolved_at
              ? Math.round(
                  (new Date(inc.resolved_at).getTime() -
                    new Date(inc.created_at).getTime()) /
                    60000
                )
              : "N/A";
            const postmortem = `# Postmortem: ${inc.title}\n\n**Severity:** ${inc.severity} | **Status:** ${inc.status} | **MTTR:** ${mttr} minutes\n**Affected Services:** ${inc.affected_services}\n**Created:** ${inc.created_at}${inc.resolved_at ? ` | **Resolved:** ${inc.resolved_at}` : ""}\n\n## Description\n${inc.description}\n\n## Timeline\n${detail.updates.map((u) => `- **[${u.author}]** ${u.created_at}: ${u.content}`).join("\n")}\n\n## Action Items\n- [ ] Review root cause and document findings\n- [ ] Update runbooks with lessons learned\n- [ ] Implement preventive measures\n- [ ] Schedule follow-up review`;
            event.addToolOutput({
              toolCallId: event.toolCall.toolCallId,
              output: { postmortem }
            });
          }
        } catch {
          event.addToolOutput({
            toolCallId: event.toolCall.toolCallId,
            output: { error: "Failed to generate postmortem" }
          });
        }
      }
    }
  });

  const isStreaming = status === "streaming" || status === "submitted";

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  useEffect(() => {
    if (!isStreaming && textareaRef.current) {
      textareaRef.current.focus();
    }
  }, [isStreaming]);

  const send = useCallback(() => {
    const text = input.trim();
    if (!text || isStreaming) return;
    setInput("");
    sendMessage({ role: "user", parts: [{ type: "text", text }] });
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
    }
  }, [input, isStreaming, sendMessage]);

  const quickPrompts = [
    {
      icon: <SirenIcon size={14} />,
      label: "Report incident",
      prompt: "Our API is returning 500 errors for about 30% of requests. Started 10 minutes ago."
    },
    {
      icon: <BookOpenIcon size={14} />,
      label: "Search runbooks",
      prompt: "Search runbooks for database connection issues"
    },
    {
      icon: <HeartbeatIcon size={14} />,
      label: "Health check",
      prompt: "Schedule a health check for API Gateway, Auth Service, and Database in 1 minute"
    },
    {
      icon: <ChartBarIcon size={14} />,
      label: "Analytics",
      prompt: "Show me incident analytics"
    },
    {
      icon: <ListBulletsIcon size={14} />,
      label: "List incidents",
      prompt: "List all active incidents"
    },
    {
      icon: <FileTextIcon size={14} />,
      label: "Postmortem",
      prompt: "Generate a postmortem for the most recent resolved incident"
    }
  ];

  return (
    <div className="flex h-screen bg-kumo-elevated">
      {/* Sidebar */}
      <IncidentSidebar
        incidents={incidents}
        selectedId={selectedIncident?.id ?? null}
        onSelect={loadTimeline}
        onRefresh={refreshIncidents}
        collapsed={sidebarCollapsed}
        onToggle={() => setSidebarCollapsed(!sidebarCollapsed)}
      />

      {/* Center: chat */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Header */}
        <header className="px-5 py-3 bg-kumo-base border-b border-kumo-line">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="flex items-center gap-2">
                <WarningIcon size={22} weight="duotone" className="text-red-400" />
                <h1 className="text-lg font-semibold text-kumo-default">
                  Incident Commander
                </h1>
              </div>
              <Badge variant="secondary">
                <BrainIcon size={12} weight="bold" className="mr-1" />
                Llama 4 Scout
              </Badge>
            </div>
            <div className="flex items-center gap-3">
              <div className="flex items-center gap-1.5">
                <CircleIcon
                  size={8}
                  weight="fill"
                  className={
                    connected ? "text-kumo-success" : "text-kumo-danger"
                  }
                />
                <Text size="xs" variant="secondary">
                  {connected ? "Connected" : "Disconnected"}
                </Text>
              </div>
              {agentState?.lastHealthCheck && (
                <div className="flex items-center gap-1.5">
                  <HeartbeatIcon size={14} className="text-emerald-400" />
                  <Text size="xs" variant="secondary">
                    Last check: {timeAgo(agentState.lastHealthCheck)}
                  </Text>
                </div>
              )}
              <ThemeToggle />
              <Button
                variant="secondary"
                icon={<TrashIcon size={16} />}
                onClick={clearHistory}
              >
                Clear
              </Button>
            </div>
          </div>
        </header>

        {/* Messages */}
        <div className="flex-1 overflow-y-auto">
          <div className="max-w-3xl mx-auto px-5 py-6 space-y-5">
            {messages.length === 0 && (
              <Empty
                icon={<WarningIcon size={36} weight="duotone" />}
                title="Incident Response Commander"
                contents={
                  <div className="space-y-4">
                    <span className="block text-center">
                      <Text size="sm" variant="secondary">
                        AI-powered incident management. Declare incidents, run
                        triage, track timelines, and generate postmortems.
                      </Text>
                    </span>
                    <div className="flex flex-wrap justify-center gap-2">
                      {quickPrompts.map((qp) => (
                        <Button
                          key={qp.label}
                          variant="outline"
                          size="sm"
                          icon={qp.icon}
                          disabled={isStreaming}
                          onClick={() => {
                            sendMessage({
                              role: "user",
                              parts: [{ type: "text", text: qp.prompt }]
                            });
                          }}
                        >
                          {qp.label}
                        </Button>
                      ))}
                    </div>
                  </div>
                }
              />
            )}

            {messages.map((message: UIMessage, index: number) => {
              const isUser = message.role === "user";
              const isLastAssistant =
                message.role === "assistant" && index === messages.length - 1;

              return (
                <div key={message.id} className="space-y-2">
                  {message.parts.filter(isToolUIPart).map((part) => (
                    <ToolPartView
                      key={part.toolCallId}
                      part={part}
                      addToolApprovalResponse={addToolApprovalResponse}
                    />
                  ))}

                  {message.parts
                    .filter(
                      (part) =>
                        part.type === "reasoning" &&
                        (part as { text?: string }).text?.trim()
                    )
                    .map((part, i) => {
                      const reasoning = part as {
                        type: "reasoning";
                        text: string;
                        state?: "streaming" | "done";
                      };
                      const isDone =
                        reasoning.state === "done" || !isStreaming;
                      return (
                        <div key={i} className="flex justify-start">
                          <details
                            className="max-w-[85%] w-full"
                            open={!isDone}
                          >
                            <summary className="flex items-center gap-2 cursor-pointer px-3 py-2 rounded-lg bg-purple-500/10 border border-purple-500/20 text-sm select-none">
                              <BrainIcon
                                size={14}
                                className="text-purple-400"
                              />
                              <span className="font-medium text-kumo-default">
                                Reasoning
                              </span>
                              {isDone ? (
                                <span className="text-xs text-kumo-success">
                                  Complete
                                </span>
                              ) : (
                                <span className="text-xs text-kumo-brand">
                                  Thinking...
                                </span>
                              )}
                              <CaretDownIcon
                                size={14}
                                className="ml-auto text-kumo-inactive"
                              />
                            </summary>
                            <pre className="mt-2 px-3 py-2 rounded-lg bg-kumo-control text-xs text-kumo-default whitespace-pre-wrap overflow-auto max-h-64">
                              {reasoning.text}
                            </pre>
                          </details>
                        </div>
                      );
                    })}

                  {message.parts
                    .filter((part) => part.type === "text")
                    .map((part, i) => {
                      const rawText = (part as { type: "text"; text: string })
                        .text;
                      if (!rawText) return null;
                      const text = isUser ? rawText : sanitizeModelText(rawText);
                      if (!text) return null;

                      if (isUser) {
                        return (
                          <div key={i} className="flex justify-end">
                            <div className="max-w-[85%] px-4 py-2.5 rounded-2xl rounded-br-md bg-kumo-contrast text-kumo-inverse leading-relaxed">
                              {text}
                            </div>
                          </div>
                        );
                      }

                      return (
                        <div key={i} className="flex justify-start">
                          <div className="max-w-[85%] rounded-2xl rounded-bl-md bg-kumo-base text-kumo-default leading-relaxed">
                            <Streamdown
                              className="sd-theme rounded-2xl rounded-bl-md p-3"
                              controls={false}
                              isAnimating={isLastAssistant && isStreaming}
                            >
                              {text}
                            </Streamdown>
                          </div>
                        </div>
                      );
                    })}
                </div>
              );
            })}
            <div ref={messagesEndRef} />
          </div>
        </div>

        {/* Input */}
        <div className="border-t border-kumo-line bg-kumo-base">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              send();
            }}
            className="max-w-3xl mx-auto px-5 py-4"
          >
            <div className="flex items-end gap-3 rounded-xl border border-kumo-line bg-kumo-base p-3 shadow-sm focus-within:ring-2 focus-within:ring-kumo-ring focus-within:border-transparent transition-shadow">
              <InputArea
                ref={textareaRef}
                value={input}
                onValueChange={setInput}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    send();
                  }
                }}
                onInput={(e) => {
                  const el = e.currentTarget;
                  el.style.height = "auto";
                  el.style.height = `${el.scrollHeight}px`;
                }}
                placeholder="Describe an incident, ask for triage, or search runbooks..."
                disabled={!connected || isStreaming}
                rows={1}
                className="flex-1 ring-0! focus:ring-0! shadow-none! bg-transparent! outline-none! resize-none max-h-40"
              />
              {isStreaming ? (
                <Button
                  type="button"
                  variant="secondary"
                  shape="square"
                  aria-label="Stop generation"
                  icon={<StopIcon size={18} />}
                  onClick={stop}
                  className="mb-0.5"
                />
              ) : (
                <Button
                  type="submit"
                  variant="primary"
                  shape="square"
                  aria-label="Send message"
                  disabled={!input.trim() || !connected}
                  icon={<PaperPlaneRightIcon size={18} />}
                  className="mb-0.5"
                />
              )}
            </div>
          </form>
        </div>
      </div>

      {/* Timeline panel */}
      {selectedIncident && (
        <TimelinePanel
          incident={selectedIncident}
          updates={timelineUpdates}
          onClose={() => {
            setSelectedIncident(null);
            setTimelineUpdates([]);
          }}
        />
      )}
    </div>
  );
}

export default function App() {
  return (
    <Toasty>
      <Suspense
        fallback={
          <div className="flex items-center justify-center h-screen text-kumo-inactive">
            <div className="flex flex-col items-center gap-3">
              <WarningIcon
                size={32}
                weight="duotone"
                className="animate-pulse"
              />
              <span>Loading Incident Commander...</span>
            </div>
          </div>
        }
      >
        <Dashboard />
      </Suspense>
    </Toasty>
  );
}
