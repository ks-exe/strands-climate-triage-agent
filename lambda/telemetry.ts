/**
 * Climate sensor telemetry domain logic.
 *
 * Pure, deterministic functions that power the agent's tools. No LLM and no
 * network access lives here so the data-health analysis is fast, repeatable and
 * unit-testable. The Strands agent calls these from its tool callbacks.
 *
 * The pipeline is:
 *   analyzeTelemetry(csv)  -> TelemetryProfile   (data health: missing, drift, stuck)
 *   evaluateRisk(profile)  -> RiskEvaluation      (severe weather vs hardware fault)
 *   buildAdvisory(risk)    -> Advisory            (plain-language action guidance)
 */

/** A single telemetry column profile. */
export interface TelemetryColumn {
  readonly name: string;
  readonly kind: "numeric" | "identifier" | "timestamp" | "text";
  readonly missing: number;
  readonly missingRate: number;
  readonly min?: number;
  readonly max?: number;
  readonly mean?: number;
  readonly recentMean?: number;
  readonly stuck?: boolean;
  readonly stuckMaxRun?: number;
  readonly driftSeverity?: "none" | "moderate" | "high" | "critical";
  readonly anomalyCount?: number;
  readonly impossibleCount?: number;
  readonly bounds?: { min: number; max: number } | null;
  readonly examples: string[];
}

/** Full data-health profile returned by inspect_sensor_data. */
export interface TelemetryProfile {
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

/** A detected climate hazard (or candidate) with confidence in the reading. */
export interface Hazard {
  readonly key: string;
  readonly label: string;
  readonly severity: "low" | "moderate" | "high" | "critical";
  readonly confirmed: boolean;
  readonly evidence: string;
}

/** Risk classification returned by evaluate_climate_risk. */
export interface RiskEvaluation {
  readonly verdict: "severe_weather" | "hardware_fault" | "mixed" | "nominal";
  readonly verdictLabel: string;
  readonly severity: "low" | "moderate" | "high" | "critical";
  readonly hazards: Hazard[];
  readonly faults: string[];
  readonly confidence: number;
  readonly reasoning: string[];
}

/** Plain-language action guidance returned by generate_resilience_advisory. */
export interface Advisory {
  readonly headline: string;
  readonly immediateActions: string[];
  readonly communityActions: string[];
  readonly farmerActions: string[];
  readonly monitoring: string[];
}

const SEVERITY_RANK: Record<string, number> = { none: 0, low: 1, moderate: 2, high: 3, critical: 4 };

/** Physical bounds for known telemetry columns. Values outside are impossible readings. */
const KNOWN_BOUNDS: ReadonlyArray<{ match: readonly string[]; min: number; max: number; unit: string }> = [
  { match: ["temperature", "temp", "air_temp"], min: -50, max: 70, unit: "°C" },
  { match: ["humidity", "relative_humidity", "rh"], min: 0, max: 100, unit: "%" },
  { match: ["rainfall", "rain", "precipitation", "precip"], min: 0, max: 600, unit: "mm" },
  { match: ["wind", "wind_speed"], min: 0, max: 400, unit: "km/h" },
  { match: ["soil_moisture", "soil", "moisture"], min: 0, max: 100, unit: "%" },
  { match: ["pm25", "pm2_5"], min: 0, max: 1000, unit: "µg/m³" },
  { match: ["pm10"], min: 0, max: 2000, unit: "µg/m³" },
  { match: ["air_quality", "aqi"], min: 0, max: 500, unit: "AQI" },
  { match: ["pressure", "pressure_hpa"], min: 800, max: 1100, unit: "hPa" },
  { match: ["uv", "uv_index"], min: 0, max: 20, unit: "index" }
];

const STUCK_RUN_THRESHOLD = 6;
const DRIFT_SHIFT_THRESHOLD = 0.5;
const HIGH_MISSING_THRESHOLD = 25;

/**
 * Parse CSV text into a row matrix, handling quoted fields and CRLF.
 * Reused from the original inspector because it is robust.
 */
export function parseCsv(input: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];

    if (inQuotes) {
      if (char === "\"") {
        if (input[index + 1] === "\"") {
          field += "\"";
          index += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
      continue;
    }

    if (char === "\"") {
      inQuotes = true;
      continue;
    }
    if (char === ",") {
      row.push(field);
      field = "";
      continue;
    }
    if (char === "\n" || char === "\r") {
      if (char === "\r" && input[index + 1] === "\n") {
        index += 1;
      }
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      continue;
    }
    field += char;
  }

  row.push(field);
  rows.push(row);
  return rows.filter((candidate) => candidate.some((value) => value.trim().length > 0));
}

function isMissing(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return normalized === "" || normalized === "null" || normalized === "n/a" || normalized === "na" || normalized === "nan";
}

function uniqueHeaders(headers: string[]): string[] {
  const seen = new Map<string, number>();
  return headers.map((header) => {
    const count = seen.get(header) ?? 0;
    seen.set(header, count + 1);
    return count === 0 ? header : `${header} (${count + 1})`;
  });
}

function normalizeRow(row: string[], width: number): string[] {
  return Array.from({ length: width }, (_, index) => row[index]?.trim() ?? "");
}

function parseNumber(value: string): number | null {
  const normalized = value.trim().replace(/,/g, "");
  if (normalized === "") {
    return null;
  }
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function columnKind(name: string): "identifier" | "timestamp" | "numeric" | "text" {
  const lower = name.toLowerCase();
  if (/(^|_)?sensor_?id$|^id$|node_?id|^sensor$/.test(lower)) return "identifier";
  if (/(^|_)?time$|^timestamp$|^ts$|^date$|datetime|created_at/.test(lower)) return "timestamp";
  return "text";
}

function boundsFor(name: string): { min: number; max: number; unit: string } | null {
  const lower = name.toLowerCase();
  for (const entry of KNOWN_BOUNDS) {
    if (entry.match.some((key) => lower.includes(key))) {
      return entry;
    }
  }
  return null;
}

function detectNumeric(values: string[]): { isNumeric: boolean; numbers: number[] } {
  const nonMissing = values.filter((value) => !isMissing(value));
  if (nonMissing.length === 0) {
    return { isNumeric: false, numbers: [] };
  }
  const parsed = nonMissing.map(parseNumber).filter((value): value is number => value !== null);
  return { isNumeric: parsed.length / nonMissing.length >= 0.75, numbers: parsed };
}

function maxStuckRun(numbers: number[]): number {
  if (numbers.length === 0) {
    return 0;
  }
  let max = 1;
  let current = 1;
  for (let index = 1; index < numbers.length; index += 1) {
    if (Math.abs(numbers[index] - numbers[index - 1]) < 1e-9) {
      current += 1;
      max = Math.max(max, current);
    } else {
      current = 1;
    }
  }
  return max;
}

function driftSeverity(recentShiftPct: number): "none" | "moderate" | "high" | "critical" {
  const abs = Math.abs(recentShiftPct);
  if (abs >= 1.2) return "critical";
  if (abs >= 0.8) return "high";
  if (abs >= DRIFT_SHIFT_THRESHOLD) return "moderate";
  return "none";
}

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const position = (sorted.length - 1) * q;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

/** Inspect raw telemetry CSV and produce a data-health profile. */
export function analyzeTelemetry(csvText: string, fileName: string): TelemetryProfile {
  const parsedRows = parseCsv(csvText);
  if (parsedRows.length < 2) {
    throw new Error("Telemetry CSV must include a header row and at least one reading.");
  }

  const headers = uniqueHeaders(parsedRows[0].map((header, index) => header.trim() || `column_${index + 1}`));
  const dataRows = parsedRows.slice(1).map((row) => normalizeRow(row, headers.length));
  const rowCount = dataRows.length;
  const columnCount = headers.length;

  let sensorCount: number | null = null;
  const sensorColumnIndex = headers.findIndex((header) => columnKind(header) === "identifier");
  if (sensorColumnIndex >= 0) {
    const ids = new Set<string>();
    for (const row of dataRows) {
      const value = row[sensorColumnIndex]?.trim();
      if (value) ids.add(value);
    }
    sensorCount = ids.size;
  }

  const columns: TelemetryColumn[] = headers.map((name, index) => {
    const values = dataRows.map((row) => row[index] ?? "");
    const missing = values.filter(isMissing).length;
    const declaredKind = columnKind(name);
    const examples = values.filter((value) => !isMissing(value)).slice(0, 3);

    if (declaredKind === "timestamp" || declaredKind === "identifier") {
      return {
        name,
        kind: declaredKind,
        missing,
        missingRate: rate(missing, rowCount),
        examples
      };
    }

    const { isNumeric, numbers } = detectNumeric(values);
    if (!isNumeric) {
      return {
        name,
        kind: "text",
        missing,
        missingRate: rate(missing, rowCount),
        examples
      };
    }

    const bounds = boundsFor(name);
    const min = numbers.length ? Math.min(...numbers) : undefined;
    const max = numbers.length ? Math.max(...numbers) : undefined;
    const mean = numbers.length ? numbers.reduce((total, value) => total + value, 0) / numbers.length : undefined;
    const windowSize = Math.max(1, Math.floor(numbers.length * 0.2));
    const firstWindow = numbers.slice(0, windowSize);
    const lastWindow = numbers.slice(Math.max(0, numbers.length - windowSize));
    const firstMean = firstWindow.length ? firstWindow.reduce((t, v) => t + v, 0) / firstWindow.length : 0;
    const recentMean = lastWindow.length ? lastWindow.reduce((t, v) => t + v, 0) / lastWindow.length : undefined;
    const recentShiftPct = typeof mean === "number" && Math.abs(mean) >= 1.0 ? ((recentMean ?? 0) - firstMean) / Math.abs(mean) : 0;
    const stuckRun = maxStuckRun(numbers);
    const stuck = numbers.length > STUCK_RUN_THRESHOLD && stuckRun >= STUCK_RUN_THRESHOLD;
    const drift = driftSeverity(recentShiftPct);

    let anomalyCount = 0;
    let impossibleCount = 0;
    if (bounds) {
      for (const value of numbers) {
        if (value < bounds.min || value > bounds.max) {
          anomalyCount += 1;
          impossibleCount += 1;
        }
      }
    } else if (numbers.length >= 4) {
      const sorted = [...numbers].sort((a, b) => a - b);
      const q1 = quantile(sorted, 0.25);
      const q3 = quantile(sorted, 0.75);
      const iqr = q3 - q1;
      const low = q1 - 3 * iqr;
      const high = q3 + 3 * iqr;
      for (const value of numbers) {
        if (value < low || value > high) anomalyCount += 1;
      }
    }

    return {
      name,
      kind: "numeric",
      missing,
      missingRate: rate(missing, rowCount),
      min,
      max,
      mean,
      recentMean,
      stuck,
      stuckMaxRun: stuckRun,
      driftSeverity: drift,
      anomalyCount,
      impossibleCount,
      bounds: bounds ? { min: bounds.min, max: bounds.max } : null,
      examples
    };
  });

  const numericColumns = columns.filter((column) => column.kind === "numeric");
  const missingValues = columns.reduce((total, column) => total + column.missing, 0);
  const totalCells = rowCount * columnCount;
  const stuckColumnCount = numericColumns.filter((column) => column.stuck).length;
  const driftColumnCount = numericColumns.filter((column) => column.driftSeverity && column.driftSeverity !== "none").length;
  const anomalyCount = numericColumns.reduce((total, column) => total + (column.anomalyCount ?? 0), 0);
  const impossibleCount = numericColumns.reduce((total, column) => total + (column.impossibleCount ?? 0), 0);

  const missingRate = rate(missingValues, totalCells);
  const numericCount = Math.max(1, numericColumns.length);
  const stuckRate = stuckColumnCount / numericCount;
  const driftRate = driftColumnCount / numericCount;
  const anomalyRate = Math.min(1, anomalyCount / Math.max(1, numericColumns.reduce((t, c) => t + (c.kind === "numeric" ? rowCount : 0), 0)));
  const score = Math.max(0, Math.round(100 - missingRate * 0.4 - stuckRate * 25 - driftRate * 20 - anomalyRate * 15));

  return {
    fileName,
    rowCount,
    columnCount,
    sensorCount,
    missingValues,
    missingRate,
    stuckColumnCount,
    driftColumnCount,
    anomalyCount,
    impossibleCount,
    score,
    columns,
    issues: buildIssues(columns, numericColumns, rowCount)
  };
}

function buildIssues(columns: TelemetryColumn[], numericColumns: TelemetryColumn[], rowCount: number): string[] {
  const issues: string[] = [];
  const highMissing = columns.filter((column) => column.missingRate >= HIGH_MISSING_THRESHOLD);
  const stuck = numericColumns.filter((column) => column.stuck);
  const drift = numericColumns.filter((column) => column.driftSeverity && column.driftSeverity !== "none");
  const impossible = numericColumns.filter((column) => (column.impossibleCount ?? 0) > 0);

  if (highMissing.length > 0) {
    issues.push(`${highMissing.length} column(s) have at least ${HIGH_MISSING_THRESHOLD}% missing values.`);
  }
  if (stuck.length > 0) {
    issues.push(`${stuck.length} sensor reading(s) appear stuck (no variation for ${STUCK_RUN_THRESHOLD}+ consecutive rows).`);
  }
  if (drift.length > 0) {
    issues.push(`${drift.length} sensor(s) show gradual drift between the first and last readings.`);
  }
  if (impossible.length > 0) {
    issues.push(`${impossible.length} sensor(s) returned physically impossible values outside known bounds.`);
  }
  if (issues.length === 0) {
    issues.push("No major data-health issues detected.");
  }
  return issues;
}

function rate(part: number, total: number): number {
  return total === 0 ? 0 : Math.round((part / total) * 1000) / 10;
}

function findColumn(columns: TelemetryColumn[], ...keys: string[]): TelemetryColumn | undefined {
  const lowerKeys = keys.map((key) => key.toLowerCase());
  return columns.find((column) => {
    const lower = column.name.toLowerCase();
    return lowerKeys.some((key) => lower.includes(key));
  });
}

function severityFor(value: number, thresholds: ReadonlyArray<[number, "low" | "moderate" | "high" | "critical"]>): "low" | "moderate" | "high" | "critical" {
  let result: "low" | "moderate" | "high" | "critical" = "low";
  for (const [threshold, label] of thresholds) {
    if (value >= threshold) result = label;
  }
  return result;
}

/** Classify whether anomalous telemetry is a real severe-weather event or faulty hardware. */
export function evaluateRisk(profile: TelemetryProfile): RiskEvaluation {
  const numeric = profile.columns.filter((column) => column.kind === "numeric");
  const hazards: Hazard[] = [];
  const faults: string[] = [];
  const reasoning: string[] = [];
  // Columns that are the source of a confirmed hazard. A sustained change on one
  // of these is the weather event itself, not sensor drift, so drift faults are
  // suppressed for them. This is the core "severe weather vs hardware fault" call.
  const confirmedHazardColumns = new Set<string>();

  const temp = findColumn(numeric, "temperature", "temp", "air_temp");
  if (temp?.max !== undefined) {
    const confirmed = !temp.stuck && (temp.impossibleCount ?? 0) === 0;
    const severity = severityFor(temp.max, [[40, "moderate"], [44, "high"], [48, "critical"]]);
    if (severity !== "low") {
      hazards.push({
        key: "heat",
        label: "Heatwave",
        severity,
        confirmed,
        evidence: `Max temperature ${fmt(temp.max)}°C${temp.recentMean !== undefined ? ` (recent mean ${fmt(temp.recentMean)}°C)` : ""}.`
      });
      if (confirmed) confirmedHazardColumns.add(temp.name);
    }
    if (temp.min !== undefined && temp.min <= -10) {
      const severity = severityFor(-temp.min, [[10, "moderate"], [20, "high"], [30, "critical"]]);
      hazards.push({
        key: "cold",
        label: "Cold snap",
        severity,
        confirmed,
        evidence: `Min temperature ${fmt(temp.min)}°C.`
      });
      if (confirmed) confirmedHazardColumns.add(temp.name);
    }
  }

  const rain = findColumn(numeric, "rainfall", "rain", "precipitation", "precip");
  if (rain?.max !== undefined) {
    const confirmed = !rain.stuck && (rain.impossibleCount ?? 0) === 0;
    const severity = severityFor(rain.max, [[40, "moderate"], [60, "high"], [100, "critical"]]);
    if (severity !== "low" || (rain.recentMean ?? 0) >= 8) {
      hazards.push({
        key: "flood",
        label: "Flood / heavy rain",
        severity: (rain.recentMean ?? 0) >= 8 ? rankMax([severity, "moderate"]) : severity,
        confirmed,
        evidence: `Max rainfall ${fmt(rain.max)} mm${rain.recentMean !== undefined ? ` (recent mean ${fmt(rain.recentMean)} mm)` : ""}.`
      });
      if (confirmed) confirmedHazardColumns.add(rain.name);
    }
  }

  const wind = findColumn(numeric, "wind", "wind_speed");
  if (wind?.max !== undefined) {
    const confirmed = !wind.stuck && (wind.impossibleCount ?? 0) === 0;
    const severity = severityFor(wind.max, [[90, "moderate"], [120, "high"], [150, "critical"]]);
    if (severity !== "low") {
      hazards.push({
        key: "storm",
        label: "Severe wind / storm",
        severity,
        confirmed,
        evidence: `Max wind speed ${fmt(wind.max)} km/h.`
      });
      if (confirmed) confirmedHazardColumns.add(wind.name);
    }
  }

  const pm25 = findColumn(numeric, "pm25", "pm2_5");
  if (pm25?.max !== undefined) {
    const confirmed = !pm25.stuck && (pm25.impossibleCount ?? 0) === 0;
    const severity = severityFor(pm25.max, [[150, "moderate"], [250, "high"], [500, "critical"]]);
    if (severity !== "low") {
      hazards.push({
        key: "air",
        label: "Hazardous air quality",
        severity,
        confirmed,
        evidence: `Max PM2.5 ${fmt(pm25.max)} µg/m³.`
      });
      if (confirmed) confirmedHazardColumns.add(pm25.name);
    }
  }

  const soil = findColumn(numeric, "soil_moisture", "soil", "moisture");
  if (soil?.min !== undefined) {
    const confirmed = !soil.stuck && (soil.impossibleCount ?? 0) === 0;
    const severity = severityFor(-soil.min, [[5, "moderate"], [10, "high"], [13, "critical"]]);
    if (soil.min <= 12 || (soil.mean ?? 99) <= 15) {
      hazards.push({
        key: "drought",
        label: "Drought / soil-moisture stress",
        severity,
        confirmed,
        evidence: `Min soil moisture ${fmt(soil.min)}%${soil.mean !== undefined ? ` (mean ${fmt(soil.mean)}%)` : ""}.`
      });
      if (confirmed) confirmedHazardColumns.add(soil.name);
    }
  }

  for (const column of numeric) {
    if (column.stuck && column.stuckMaxRun) {
      const share = column.stuckMaxRun / Math.max(1, profile.rowCount);
      faults.push(`${column.name} appears stuck at a constant value for ${column.stuckMaxRun} consecutive readings (${pct(share)} of the file).`);
    }
    if (column.driftSeverity && column.driftSeverity !== "none" && !confirmedHazardColumns.has(column.name)) {
      faults.push(`${column.name} shows ${column.driftSeverity} drift between the first and last readings, suggesting sensor degradation.`);
    }
    if ((column.impossibleCount ?? 0) > 0) {
      faults.push(`${column.name} returned ${column.impossibleCount} physically impossible reading(s) outside known bounds.`);
    }
    if (column.missingRate >= HIGH_MISSING_THRESHOLD) {
      faults.push(`${column.name} is missing ${column.missingRate}% of its readings, creating a data gap.`);
    }
  }

  const confirmedHazards = hazards.filter((hazard) => hazard.confirmed);
  const faultCount = faults.length;
  let verdict: RiskEvaluation["verdict"];
  if (confirmedHazards.length > 0 && faultCount === 0) {
    verdict = "severe_weather";
  } else if (confirmedHazards.length === 0 && faultCount > 0) {
    verdict = "hardware_fault";
  } else if (confirmedHazards.length > 0 && faultCount > 0) {
    verdict = "mixed";
  } else {
    verdict = "nominal";
  }

  const allSeverities = [
    ...confirmedHazards.map((hazard) => hazard.severity),
    ...faults.map((fault) => (fault.includes("stuck") || fault.includes("impossible") ? "high" : "moderate"))
  ];
  const severity = rankMax(allSeverities);

  const labels: Record<RiskEvaluation["verdict"], string> = {
    severe_weather: "Severe weather event confirmed",
    hardware_fault: "Likely sensor / hardware fault",
    mixed: "Mixed: real hazard with faulty sensors",
    nominal: "Conditions nominal"
  };

  reasoning.push(
    `Inspected ${profile.rowCount} rows across ${profile.columnCount} columns (${profile.sensorCount ?? "unknown"} sensor${profile.sensorCount === 1 ? "" : "s"}).`,
    `Data health score ${profile.score}/100 with ${profile.stuckColumnCount} stuck, ${profile.driftColumnCount} drifting and ${profile.impossibleCount} impossible reading(s).`,
    ...confirmedHazards.map((hazard) => `Confirmed hazard: ${hazard.label} (${hazard.severity}) — ${hazard.evidence}`),
    ...faults
  );

  const unconfirmedHazards = hazards.filter((hazard) => !hazard.confirmed).length;
  const confidence = Math.max(
    0,
    Math.round(100 - profile.missingRate * 0.5 - faultCount * 8 - unconfirmedHazards * 12)
  );

  return {
    verdict,
    verdictLabel: labels[verdict],
    severity,
    hazards,
    faults,
    confidence,
    reasoning
  };
}

/** Produce plain-language action guidance for communities and farmers. */
export function buildAdvisory(risk: RiskEvaluation): Advisory {
  const hazardKeys = new Set(risk.hazards.filter((h) => h.confirmed).map((h) => h.key));

  if (risk.verdict === "hardware_fault") {
    return {
      headline: "Likely sensor fault — verify before alerting the public.",
      immediateActions: [
        "Do not issue a public weather alert based on this dataset alone.",
        "Cross-check the flagged sensors against neighbouring stations and recent maintenance logs.",
        "Quarantine the affected sensor readings from automated alert pipelines."
      ],
      communityActions: [
        "Inform community liaisons that a sensor verification is underway; no protective action is needed yet.",
        "Keep routine seasonal preparedness channels open while data is reviewed."
      ],
      farmerActions: [
        "Hold off on emergency irrigation or harvest changes until readings are confirmed.",
        "Continue normal monitoring of crops and livestock through established channels."
      ],
      monitoring: [
        "Dispatch a field technician to recalibrate or replace the faulty sensor.",
        "Re-run triage after the sensor is serviced to confirm readings return to normal range."
      ]
    };
  }

  if (risk.verdict === "mixed") {
    return {
      headline: "Severe conditions detected, but some sensor readings are unreliable — act on confirmed hazards, verify the rest.",
      immediateActions: [
        "Issue protective guidance for the confirmed hazards only.",
        "Flag the faulty sensors for technician follow-up so they do not skew future alerts."
      ],
      communityActions: hazardSpecificCommunityActions(hazardKeys),
      farmerActions: hazardSpecificFarmerActions(hazardKeys),
      monitoring: [
        "Maintain hourly checks on confirmed hazard indicators.",
        "Re-run triage once faulty sensors are serviced."
      ]
    };
  }

  if (risk.verdict === "severe_weather") {
    return {
      headline: `${risk.severity === "critical" ? "Critical" : risk.severity === "high" ? "High-impact" : "Active"} severe-weather conditions confirmed — protective action needed now.`,
      immediateActions: [
        "Activate the local early-warning committee and broadcast the advisory to communities and farms.",
        "Open identified shelters, cooling centres or high-ground assembly points as relevant."
      ],
      communityActions: hazardSpecificCommunityActions(hazardKeys),
      farmerActions: hazardSpecificFarmerActions(hazardKeys),
      monitoring: [
        "Keep telemetry ingest running at the highest available cadence.",
        "Plan a follow-up triage once conditions stabilise to capture recovery metrics."
      ]
    };
  }

  return {
    headline: "Environmental conditions are within normal range.",
    immediateActions: ["No protective action required at this time."],
    communityActions: ["Continue routine seasonal preparedness and awareness activities."],
    farmerActions: ["Proceed with normal farm operations and scheduled monitoring."],
    monitoring: ["Keep the triage pipeline running so the next anomaly is caught early."]
  };
}

function hazardSpecificCommunityActions(keys: Set<string>): string[] {
  const actions: string[] = [];
  if (keys.has("heat")) {
    actions.push("Open cooling centres and distribute oral rehydration salts; check on elderly and outdoor residents.");
  }
  if (keys.has("flood")) {
    actions.push("Move people and valuables to higher ground; share the 'do not cross flowing water' guidance.");
  }
  if (keys.has("storm")) {
    actions.push("Secure loose objects, shelter indoors away from windows, and keep emergency kits ready.");
  }
  if (keys.has("air")) {
    actions.push("Advise vulnerable groups to stay indoors and use well-fitted masks if they must go outside.");
  }
  if (keys.has("cold")) {
    actions.push("Distribute warm clothing and blankets; open heated shelters for those without heating.");
  }
  if (actions.length === 0) actions.push("Share the advisory through trusted community channels.");
  return actions;
}

function hazardSpecificFarmerActions(keys: Set<string>): string[] {
  const actions: string[] = [];
  if (keys.has("heat")) {
    actions.push("Pause field work during peak midday heat; move livestock to shade and ensure uninterrupted water.");
  }
  if (keys.has("flood")) {
    actions.push("Move livestock and equipment to high ground; secure grain stores and delay planting if fields are saturated.");
  }
  if (keys.has("storm")) {
    actions.push("Secure greenhouses, nets and stored feed; shelter livestock before the window closes.");
  }
  if (keys.has("drought")) {
    actions.push("Prioritise irrigation for the most vulnerable plots and mulch to retain soil moisture.");
  }
  if (keys.has("air")) {
    actions.push("Limit outdoor burning and dust-generating work; protect workers with masks.");
  }
  if (actions.length === 0) actions.push("Keep monitoring crop and livestock conditions against the advisory.");
  return actions;
}

function rankMax(severities: string[]): "low" | "moderate" | "high" | "critical" {
  let max = "low";
  for (const severity of severities) {
    if (SEVERITY_RANK[severity] > SEVERITY_RANK[max]) max = severity;
  }
  return max as "low" | "moderate" | "high" | "critical";
}

function fmt(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

function pct(value: number): string {
  return `${Math.round(value * 100)}%`;
}

/** Compact, model-friendly summary of the inspection for the agent's working context. */
export function summarizeInspection(profile: TelemetryProfile): string {
  const stuck = profile.columns.filter((c) => c.stuck).map((c) => `${c.name} (stuck for ${c.stuckMaxRun} rows)`).join("; ") || "none";
  const drift = profile.columns.filter((c) => c.driftSeverity && c.driftSeverity !== "none").map((c) => `${c.name} (${c.driftSeverity})`).join("; ") || "none";
  const highlights = profile.columns
    .filter((c) => c.kind === "numeric")
    .map((c) => `${c.name}: ${c.min !== undefined ? fmt(c.min) : "?"}–${c.max !== undefined ? fmt(c.max) : "?"}`)
    .join(", ");
  return [
    `Inspected ${profile.rowCount} rows across ${profile.columnCount} columns (${profile.sensorCount ?? "unknown"} sensors).`,
    `Missing: ${profile.missingValues} (${profile.missingRate}%). Stuck sensors: ${stuck}. Drift: ${drift}. Impossible readings: ${profile.impossibleCount}.`,
    `Telemetry ranges: ${highlights}.`,
    `Data health score: ${profile.score}/100. Issues: ${profile.issues.join(" ")}`
  ].join(" ");
}

/** Compact, model-friendly summary of the risk evaluation. */
export function summarizeRisk(risk: RiskEvaluation): string {
  const hazards = risk.hazards.map((h) => `${h.label} (${h.severity}${h.confirmed ? ", confirmed" : ", sensor suspect"})`).join("; ") || "none";
  return [
    `Verdict: ${risk.verdictLabel}.`,
    `Severity: ${risk.severity}. Confidence: ${risk.confidence}%.`,
    `Hazards: ${hazards}.`,
    `Faults: ${risk.faults.join(" ") || "none"}.`
  ].join(" ");
}

/** Compact, model-friendly summary of the advisory. */
export function summarizeAdvisory(advisory: Advisory): string {
  return [
    advisory.headline,
    `Immediate: ${advisory.immediateActions.join(" ")}`,
    `Communities: ${advisory.communityActions.join(" ")}`,
    `Farmers: ${advisory.farmerActions.join(" ")}`,
    `Monitoring: ${advisory.monitoring.join(" ")}`
  ].join(" ");
}
