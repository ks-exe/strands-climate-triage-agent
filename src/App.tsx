import { useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  BarChart3,
  BrainCircuit,
  FileSpreadsheet,
  RefreshCw,
  ShieldCheck,
  Table2,
  UploadCloud
} from "lucide-react";

interface ColumnProfile {
  readonly name: string;
  readonly missing: number;
  readonly missingRate: number;
  readonly detectedType: string;
  readonly typeConfidence: number;
  readonly inconsistentValues: number;
  readonly examples: string[];
}

interface DataQualityProfile {
  readonly rowCount: number;
  readonly columnCount: number;
  readonly duplicateRows: number;
  readonly duplicateRate: number;
  readonly missingValues: number;
  readonly missingRate: number;
  readonly score: number;
  readonly columns: ColumnProfile[];
  readonly issues: string[];
}

interface InspectResponse {
  readonly fileName: string;
  readonly profile: DataQualityProfile;
  readonly summary: string;
  readonly summarySource: "bedrock" | "fallback";
}

const MAX_FILE_BYTES = 4_500_000;

export function App() {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [result, setResult] = useState<InspectResponse | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const sortedMissingColumns = useMemo(() => {
    return [...(result?.profile.columns ?? [])].sort((left, right) => right.missingRate - left.missingRate);
  }, [result]);

  async function inspectFile(file: File) {
    setError(null);

    if (!file.name.toLowerCase().endsWith(".csv")) {
      setError("Choose a CSV file.");
      return;
    }

    if (file.size > MAX_FILE_BYTES) {
      setError("Keep CSV files under 4.5 MB for instant inspection.");
      return;
    }

    setIsLoading(true);
    try {
      const csvText = await file.text();
      const response = await fetch("/api/inspect", {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          fileName: file.name,
          csvText
        })
      });

      const payload = (await response.json()) as InspectResponse | { readonly message?: string };

      if (!response.ok) {
        throw new Error("message" in payload && payload.message ? payload.message : "Inspection failed.");
      }

      setResult(payload as InspectResponse);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Inspection failed.");
    } finally {
      setIsLoading(false);
    }
  }

  function handleDrop(files: FileList | null) {
    const [file] = Array.from(files ?? []);
    if (file) {
      void inspectFile(file);
    }
  }

  return (
    <main className="app-shell">
      <aside className="upload-panel">
        <div className="brand-row">
          <div className="brand-mark">
            <Table2 size={22} aria-hidden="true" />
          </div>
          <div>
            <p className="eyebrow">Data Quality Inspector</p>
            <h1>CSV quality dashboard</h1>
          </div>
        </div>

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
          <span>Upload CSV</span>
          <small>Rows, columns, missing values, duplicates, types, score, AI summary</small>
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
            <span>Inspecting dataset</span>
          </div>
        ) : null}

        <div className="service-list">
          <ServicePill label="Lambda API" />
          <ServicePill label="Bedrock summary" />
          <ServicePill label="API Gateway delivery" />
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

        <div className="metric-grid">
          <MetricCard label="Rows" value={formatNumber(result?.profile.rowCount)} icon={<FileSpreadsheet />} />
          <MetricCard label="Columns" value={formatNumber(result?.profile.columnCount)} icon={<Table2 />} />
          <MetricCard label="Missing values" value={formatNumber(result?.profile.missingValues)} icon={<AlertTriangle />} />
          <MetricCard label="Duplicate rows" value={formatNumber(result?.profile.duplicateRows)} icon={<BarChart3 />} />
        </div>

        <div className="analysis-grid">
          <section className="panel score-panel">
            <div className="panel-heading">
              <ShieldCheck size={18} aria-hidden="true" />
              <h3>Quality score</h3>
            </div>
            <ScoreGauge score={result?.profile.score ?? 0} active={Boolean(result)} />
            <div className="score-caption">
              <strong>{scoreLabel(result?.profile.score)}</strong>
              <span>{result ? `${result.profile.missingRate}% missing, ${result.profile.duplicateRate}% duplicates` : "Awaiting upload"}</span>
            </div>
          </section>

          <section className="panel summary-panel">
            <div className="panel-heading">
              <BrainCircuit size={18} aria-hidden="true" />
              <h3>AI summary</h3>
            </div>
            <div className="summary-copy">
              {result?.summary ?? "Upload a CSV to generate a data quality summary."}
            </div>
            {result?.summarySource === "fallback" ? <span className="summary-source">Fallback summary</span> : null}
          </section>
        </div>

        <section className="panel chart-panel">
          <div className="panel-heading">
            <BarChart3 size={18} aria-hidden="true" />
            <h3>Missing values by column</h3>
          </div>
          <MissingBars columns={sortedMissingColumns.slice(0, 10)} />
        </section>

        <section className="panel table-panel">
          <div className="panel-heading">
            <Table2 size={18} aria-hidden="true" />
            <h3>Column profile</h3>
          </div>
          <ColumnTable columns={result?.profile.columns ?? []} />
        </section>
      </section>
    </main>
  );
}

function ServicePill({ label }: { readonly label: string }) {
  return <span className="service-pill">{label}</span>;
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

function ScoreGauge({ score, active }: { readonly score: number; readonly active: boolean }) {
  const clamped = Math.max(0, Math.min(100, score));
  const color = clamped >= 85 ? "#0f9f76" : clamped >= 65 ? "#c78514" : "#d94848";
  return (
    <div
      className="score-gauge"
      style={{
        background: active
          ? `conic-gradient(${color} ${clamped * 3.6}deg, #e4e7ec 0deg)`
          : "conic-gradient(#cfd6df 0deg, #e4e7ec 0deg)"
      }}
      aria-label={`Quality score ${clamped} out of 100`}
    >
      <div>
        <strong>{active ? clamped : "--"}</strong>
        <span>/100</span>
      </div>
    </div>
  );
}

function MissingBars({ columns }: { readonly columns: ColumnProfile[] }) {
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

function ColumnTable({ columns }: { readonly columns: ColumnProfile[] }) {
  if (columns.length === 0) {
    return <div className="empty-state">Upload a CSV to see detected column types.</div>;
  }

  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Column</th>
            <th>Type</th>
            <th>Confidence</th>
            <th>Missing</th>
            <th>Inconsistent</th>
            <th>Examples</th>
          </tr>
        </thead>
        <tbody>
          {columns.map((column) => (
            <tr key={column.name}>
              <td>{column.name}</td>
              <td>
                <span className="type-badge">{column.detectedType}</span>
              </td>
              <td>{column.typeConfidence}%</td>
              <td>{column.missing}</td>
              <td>{column.inconsistentValues}</td>
              <td>{column.examples.join(", ") || "-"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function formatNumber(value: number | undefined): string {
  return typeof value === "number" ? new Intl.NumberFormat().format(value) : "--";
}

function scoreLabel(score: number | undefined): string {
  if (typeof score !== "number") {
    return "No score";
  }
  if (score >= 85) {
    return "Strong";
  }
  if (score >= 65) {
    return "Needs review";
  }
  return "Needs cleanup";
}
