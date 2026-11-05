import { useMemo, useRef, useState } from "react";
import {
  Activity,
  AlertTriangle,
  BarChart3,
  Bot,
  BrainCircuit,
  CloudRain,
  Cpu,
  FileSpreadsheet,
  Gauge,
  ListChecks,
  RefreshCw,
  Radio,
  ShieldCheck,
  Table2,
  UploadCloud,
  Wrench
} from "lucide-react";

type Severity = "low" | "moderate" | "high" | "critical";
type Verdict = "severe_weather" | "hardware_fault" | "mixed" | "nominal";
type ColumnKind = "numeric" | "identifier" | "timestamp" | "text";
type DriftSeverity = "none" | "moderate" | "high" | "critical";

interface TelemetryColumn {
  readonly name: string;
  readonly kind: ColumnKind;
  readonly missing: number;
  readonly missingRate: number;
  readonly min?: number;
  readonly max?: number;
  readonly mean?: number;
  readonly recentMean?: number;
  readonly stuck?: boolean;
  readonly stuckMaxRun?: number;
  readonly driftSeverity?: DriftSeverity;
  readonly anomalyCount?: number;
  readonly impossibleCount?: number;
  readonly examples: string[];
}

interface TelemetryProfile {
  readonly fileName: string;
  readonly rowCount: number;
  readonly columnCount: number;
  readonly sensorCount: number | null;
  readonly missingValues: number;
  readonly missingRate: number;
  readonly stuckColumnCount: number;
  readonly driftColumnCount: number;
  readonly anomalyCount: number;
  readonly impossibleCount: number;
  readonly score: number;
  readonly columns: TelemetryColumn[];
  readonly issues: string[];
}

interface ReasoningStep {
  readonly step: number;
  readonly type: "reasoning" | "tool_call";
  readonly text?: string;
  readonly toolName?: string;
  readonly toolInput?: unknown;
  readonly toolOutput?: unknown;
  readonly durationMs?: number;
}

interface Advisory {
  readonly headline: string;
  readonly immediateActions: string[];
  readonly communityActions: string[];
  readonly farmerActions: string[];
  readonly monitoring: string[];
}

interface TriageResponse {
  readonly fileName: string;
  readonly profile: TelemetryProfile;
  readonly agent: {
    readonly reasoningSteps: ReasoningStep[];
    readonly verdict: Verdict;
    readonly verdictLabel: string;
    readonly severity: Severity;
    readonly hazards: string[];
    readonly faults: string[];
    readonly advisory: Advisory;
    readonly finalDecision: string;
    readonly stopReason: string;
    readonly modelId: string;
  };
  readonly summary: string;
  readonly summarySource: "strands" | "fallback";
}

const MAX_FILE_BYTES = 4_500_000;

export function App() {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [result, setResult] = useState<TriageResponse | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const sortedColumns = useMemo(
    () => [...(result?.profile.columns ?? [])].sort((left, right) => right.missingRate - left.missingRate),
    [result]
  );

  async function inspectFile(file: File) {
    setError(null);

    if (!file.name.toLowerCase().endsWith(".csv")) {
      setError("Choose a CSV telemetry file.");
      return;
    }
    if (file.size > MAX_FILE_BYTES) {
      setError("Keep CSV files under 4.5 MB for instant triage.");
      return;
    }

    setIsLoading(true);
    try {
      const csvText = await file.text();
      const response = await fetch("/api/inspect", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ fileName: file.name, csvText })
      });

      const payload = (await response.json()) as TriageResponse | { readonly message?: string };
      if (!response.ok) {
        throw new Error("message" in payload && payload.message ? payload.message : "Triage failed.");
      }
      setResult(payload as TriageResponse);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Triage failed.");
    } finally {
      setIsLoading(false);
    }
  }

  function handleDrop(files: FileList | null) {
    const [file] = Array.from(files ?? []);
    if (file) void inspectFile(file);
  }

  return (
    <main className="app-shell">
      <aside className="upload-panel">
        <div className="brand-row">
          <div className="brand-mark">
            <CloudRain size={22} aria-hidden="true" />
          </div>
          <div>
            <p className="eyebrow">Strands Agents SDK</p>
            <h1>Climate Data &amp; Incident Triage Agent</h1>
          </div>
        </div>

        <p className="lede">
          Upload environmental sensor telemetry. A Strands agent inspects data health, evaluates climate risk, and
          produces action guidance for affected communities and farmers.
        </p>

        <button
          className={`dropzone ${isDragging ? "is-dragging" : ""}`}
          type="button"
          onClick={() => fileInputRef.current?.click()}
          onDragEnter={(event) => {
            event.preventDefault();
            setIsDragging(true);
          }}
          onDragOver={(event) => event.preventDefault()}
          onDragLeave={() => setIsDragging(false)}
          onDrop={(event) => {
            event.preventDefault();
            setIsDragging(false);
            handleDrop(event.dataTransfer.files);
          }}
        >
          <UploadCloud size={34} aria-hidden="true" />
          <span>Upload telemetry CSV</span>
          <small>Temperature, humidity, rainfall, wind, soil moisture, air quality &mdash; any schema works</small>
        </button>

        <input
          ref={fileInputRef}
          type="file"
          accept=".csv,text/csv"
          hidden
          onChange={(event) => handleDrop(event.target.files)}
        />

        {error ? (
          <div className="notice error">
            <AlertTriangle size={18} aria-hidden="true" />
            <span>{error}</span>
          </div>
        ) : null}

        {isLoading ? (
          <div className="notice loading">
            <RefreshCw size={18} aria-hidden="true" />
            <span>Running the triage agent</span>
          </div>
        ) : null}

        <div className="service-list">
          <ServicePill label="Strands agent loop" icon={<Bot size={13} />} />
          <ServicePill label="Bedrock model" icon={<Cpu size={13} />} />
          <ServicePill label="API Gateway + Lambda" icon={<Radio size={13} />} />
        </div>
      </aside>

      <section className="dashboard">
        <div className="dashboard-header">
          <div>
            <p className="eyebrow">Current file</p>
            <h2>{result?.fileName ?? "No file selected"}</h2>
          </div>
          {result ? (
            <button className="ghost-button" type="button" onClick={() => setResult(null)}>
              <RefreshCw size={16} aria-hidden="true" />
              Reset
            </button>
          ) : null}
        </div>

        {!result ? (
          <div className="empty-hero">
            <CloudRain size={42} aria-hidden="true" />
            <h3>Submit sensor telemetry to begin triage</h3>
            <p>
              The agent runs three tools in sequence &mdash; inspect data health, evaluate climate risk, then generate
              a resilience advisory &mdash; and returns its reasoning trail alongside the metrics below.
            </p>
          </div>
        ) : (
          <>
            <div className="metric-grid">
              <MetricCard label="Rows" value={formatNumber(result.profile.rowCount)} icon={<FileSpreadsheet />} />
              <MetricCard
                label="Sensors"
                value={result.profile.sensorCount === null ? "--" : formatNumber(result.profile.sensorCount)}
                icon={<Radio />}
              />
              <MetricCard
                label="Missing values"
                value={formatNumber(result.profile.missingValues)}
                icon={<AlertTriangle />}
              />
              <MetricCard
                label="Stuck sensors"
                value={formatNumber(result.profile.stuckColumnCount)}
                icon={<Wrench />}
              />
            </div>

            <section className="panel score-panel">
              <div className="panel-heading">
                <ShieldCheck size={18} aria-hidden="true" />
                <h3>Data health score</h3>
              </div>
              <div className="score-row">
                <ScoreGauge score={result.profile.score} />
                <div className="score-meta">
                  <strong>{scoreLabel(result.profile.score)}</strong>
                  <span>{result.profile.missingRate}% missing · {result.profile.stuckColumnCount} stuck · {result.profile.driftColumnCount} drifting · {result.profile.impossibleCount} impossible</span>
                  <ul className="issue-list">
                    {result.profile.issues.map((issue) => (
                      <li key={issue}>{issue}</li>
                    ))}
                  </ul>
                </div>
              </div>
            </section>

            <AgentPanel result={result} />

            <section className="panel chart-panel">
              <div className="panel-heading">
                <BarChart3 size={18} aria-hidden="true" />
                <h3>Missing values by column</h3>
              </div>
              <MissingBars columns={sortedColumns.slice(0, 10)} />
            </section>

            <section className="panel table-panel">
              <div className="panel-heading">
                <Table2 size={18} aria-hidden="true" />
                <h3>Telemetry column profile</h3>
              </div>
              <ColumnTable columns={result.profile.columns} />
            </section>
          </>
        )}
      </section>
    </main>
  );
}

function AgentPanel({ result }: { readonly result: TriageResponse }) {
  const { agent, summarySource } = result;
  const verdictClass = verdictClassName(agent.verdict);

  return (
    <section className="panel agent-panel">
      <div className="panel-heading">
        <BrainCircuit size={18} aria-hidden="true" />
        <h3>Agent Reasoning &amp; Action Plan</h3>
        {summarySource === "fallback" ? (
          <span className="badge badge-muted">Fallback (no live model)</span>
        ) : (
          <span className="badge badge-strands">Strands · {agent.modelId}</span>
        )}
      </div>

      <div className="verdict-row">
        <span className={`verdict-chip ${verdictClass}`}>{agent.verdictLabel}</span>
        <span className={`severity-chip severity-${agent.severity}`}>{agent.severity} severity</span>
        {agent.hazards.length > 0 ? (
          <div className="chip-list">
            {agent.hazards.map((hazard) => (
              <span className="chip" key={hazard}>{hazard}</span>
            ))}
          </div>
        ) : null}
      </div>

      <div className="reasoning-trail">
        <p className="trail-title"><Activity size={15} aria-hidden="true" /> Agent reasoning trail</p>
        {agent.reasoningSteps.length === 0 ? (
          <div className="empty-state">No reasoning steps captured. The agent likely ran under the deterministic fallback.</div>
        ) : (
          <ol className="trail">
            {agent.reasoningSteps.map((step) => (
              <li key={step.step} className={`trail-item ${step.type === "tool_call" ? "is-tool" : "is-reasoning"}`}>
                {step.type === "reasoning" ? (
                  <div className="trail-reasoning">
                    <span className="trail-tag">thinking</span>
                    <p>{step.text}</p>
                  </div>
                ) : (
                  <div className="trail-tool">
                    <span className="trail-tag tag-tool">
                      <Wrench size={12} aria-hidden="true" /> {step.toolName}
                      {typeof step.durationMs === "number" ? <em> · {step.durationMs} ms</em> : null}
                    </span>
                    {step.toolInput && Object.keys(step.toolInput as object).length > 0 ? (
                      <pre className="trail-code">{JSON.stringify(step.toolInput, null, 2)}</pre>
                    ) : null}
                    {step.toolOutput ? (
                      <pre className="trail-code trail-output">{String(step.toolOutput)}</pre>
                    ) : null}
                  </div>
                )}
              </li>
            ))}
          </ol>
        )}
      </div>

      <div className="final-decision">
        <div className="final-decision-heading">
          <Gauge size={16} aria-hidden="true" />
          <h4>Final triage decision</h4>
        </div>
        <p>{agent.finalDecision || result.summary}</p>
        {agent.faults.length > 0 ? (
          <details className="faults">
            <summary>Sensor faults flagged ({agent.faults.length})</summary>
            <ul>
              {agent.faults.map((fault) => (
                <li key={fault}>{fault}</li>
              ))}
            </ul>
          </details>
        ) : null}
      </div>

      <AdvisoryBlock advisory={agent.advisory} />
    </section>
  );
}

function AdvisoryBlock({ advisory }: { readonly advisory: Advisory }) {
  return (
    <div className="advisory">
      <div className="advisory-head">
        <ListChecks size={16} aria-hidden="true" />
        <h4>{advisory.headline}</h4>
      </div>
      <div className="advisory-grid">
        <AdvisoryList title="Immediate actions" items={advisory.immediateActions} tone="immediate" />
        <AdvisoryList title="Communities" items={advisory.communityActions} tone="community" />
        <AdvisoryList title="Farmers" items={advisory.farmerActions} tone="farmer" />
        <AdvisoryList title="Monitoring &amp; next steps" items={advisory.monitoring} tone="monitor" />
      </div>
    </div>
  );
}

function AdvisoryList({
  title,
  items,
  tone
}: {
  readonly title: string;
  readonly items: string[];
  readonly tone: "immediate" | "community" | "farmer" | "monitor";
}) {
  return (
    <div className={`advisory-col tone-${tone}`}>
      <h5>{title}</h5>
      <ul>
        {items.map((item, index) => (
          <li key={`${title}-${index}`}>{item}</li>
        ))}
      </ul>
    </div>
  );
}

function ServicePill({ label, icon }: { readonly label: string; readonly icon: React.ReactElement }) {
  return (
    <span className="service-pill">
      {icon}
      {label}
    </span>
  );
}

function MetricCard({
  label,
  value,
  icon
}: {
  readonly label: string;
  readonly value: string;
  readonly icon: React.ReactElement;
}) {
  return (
    <article className="metric-card">
      <div className="metric-icon">{icon}</div>
      <span>{label}</span>
      <strong>{value}</strong>
    </article>
  );
}

function ScoreGauge({ score }: { readonly score: number }) {
  const clamped = Math.max(0, Math.min(100, score));
  const color = clamped >= 85 ? "#0f9f76" : clamped >= 65 ? "#c78514" : "#d94848";
  return (
    <div
      className="score-gauge"
      style={{ background: `conic-gradient(${color} ${clamped * 3.6}deg, #e4e7ec 0deg)` }}
      aria-label={`Data health score ${clamped} out of 100`}
    >
      <div>
        <strong>{clamped}</strong>
        <span>/100</span>
      </div>
    </div>
  );
}

function MissingBars({ columns }: { readonly columns: TelemetryColumn[] }) {
  if (columns.length === 0) {
    return <div className="empty-state">No column data yet.</div>;
  }
  return (
    <div className="bars">
      {columns.map((column) => (
        <div className="bar-row" key={column.name}>
          <span title={column.name}>{column.name}</span>
          <div className="bar-track">
            <div className="bar-fill" style={{ width: `${Math.min(100, column.missingRate)}%` }} />
          </div>
          <strong>{column.missingRate}%</strong>
        </div>
      ))}
    </div>
  );
}

function ColumnTable({ columns }: { readonly columns: TelemetryColumn[] }) {
  if (columns.length === 0) {
    return <div className="empty-state">Upload a CSV to see the telemetry column profile.</div>;
  }
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Column</th>
            <th>Kind</th>
            <th>Min</th>
            <th>Max</th>
            <th>Missing</th>
            <th>Flags</th>
            <th>Examples</th>
          </tr>
        </thead>
        <tbody>
          {columns.map((column) => (
            <tr key={column.name}>
              <td>{column.name}</td>
              <td>
                <span className="type-badge">{column.kind}</span>
              </td>
              <td>{formatNum(column.min)}</td>
              <td>{formatNum(column.max)}</td>
              <td>{column.missing}</td>
              <td>
                <ColumnFlags column={column} />
              </td>
              <td>{column.examples.join(", ") || "-"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ColumnFlags({ column }: { readonly column: TelemetryColumn }) {
  const flags: string[] = [];
  if (column.stuck) flags.push(`stuck×${column.stuckMaxRun ?? 0}`);
  if (column.driftSeverity && column.driftSeverity !== "none") flags.push(`drift:${column.driftSeverity}`);
  if ((column.anomalyCount ?? 0) > 0) flags.push(`${column.anomalyCount} anom`);
  if ((column.impossibleCount ?? 0) > 0) flags.push(`${column.impossibleCount} impossible`);
  return flags.length === 0 ? <span className="muted">—</span> : <span className="flags">{flags.join(" · ")}</span>;
}

function verdictClassName(verdict: Verdict): string {
  return `verdict-${verdict}`;
}

function formatNumber(value: number | undefined | null): string {
  return typeof value === "number" ? new Intl.NumberFormat().format(value) : "--";
}

function formatNum(value: number | undefined): string {
  if (value === undefined) return "—";
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

function scoreLabel(score: number): string {
  if (score >= 85) return "Strong";
  if (score >= 65) return "Needs review";
  return "Needs cleanup";
}
