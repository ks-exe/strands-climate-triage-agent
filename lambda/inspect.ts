import {
  BedrockRuntimeClient,
  ConverseCommand
} from "@aws-sdk/client-bedrock-runtime";
import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyStructuredResultV2
} from "aws-lambda";

const MAX_BODY_BYTES = 4_500_000;
const bedrock = new BedrockRuntimeClient({
  region: process.env.BEDROCK_REGION ?? process.env.AWS_REGION,
  maxAttempts: 5,
  retryMode: "adaptive"
});

interface InspectRequest {
  readonly fileName?: string;
  readonly csvText?: string;
}

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

const jsonHeaders = {
  "content-type": "application/json",
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "content-type",
  "access-control-allow-methods": "OPTIONS,POST"
};

export const handler = async (
  event: APIGatewayProxyEventV2
): Promise<APIGatewayProxyStructuredResultV2> => {
  if (event.requestContext.http.method === "OPTIONS") {
    return { statusCode: 204, headers: jsonHeaders };
  }

  try {
    const request = parseRequest(event);
    const csvText = request.csvText?.trim();

    if (!csvText) {
      return json(400, { message: "Upload a CSV file with at least a header row." });
    }

    const bytes = Buffer.byteLength(csvText, "utf8");
    if (bytes > MAX_BODY_BYTES) {
      return json(413, {
        message: "CSV is too large for instant inspection. Keep files under 4.5 MB."
      });
    }

    const profile = inspectCsv(csvText);
    const aiSummary = await summarizeWithBedrock(profile, request.fileName ?? "dataset.csv");
    const response: InspectResponse = {
      fileName: request.fileName ?? "dataset.csv",
      profile,
      summary: aiSummary.text,
      summarySource: aiSummary.source
    };

    return json(200, response);
  } catch (error) {
    console.error("inspection_failed", error);
    return json(500, {
      message: "The CSV could not be inspected. Check the file format and try again."
    });
  }
};

function parseRequest(event: APIGatewayProxyEventV2): InspectRequest {
  const rawBody = event.isBase64Encoded
    ? Buffer.from(event.body ?? "", "base64").toString("utf8")
    : event.body ?? "";

  if (!rawBody) {
    return {};
  }

  const parsed = JSON.parse(rawBody) as InspectRequest;
  return {
    fileName: typeof parsed.fileName === "string" ? parsed.fileName : undefined,
    csvText: typeof parsed.csvText === "string" ? parsed.csvText : undefined
  };
}

function inspectCsv(csvText: string): DataQualityProfile {
  const parsedRows = parseCsv(csvText);

  if (parsedRows.length < 2) {
    throw new Error("CSV must include headers and at least one data row.");
  }

  const headers = uniqueHeaders(parsedRows[0].map((header, index) => header.trim() || `Column ${index + 1}`));
  const dataRows = parsedRows.slice(1).map((row) => normalizeRow(row, headers.length));
  const rowCount = dataRows.length;
  const columnCount = headers.length;
  const totalCells = rowCount * columnCount;
  const duplicateRows = countDuplicateRows(dataRows);

  const columns = headers.map((name, index) => {
    const values = dataRows.map((row) => row[index] ?? "");
    const missing = values.filter(isMissing).length;
    const typeProfile = detectType(values);
    const examples = values
      .map((value) => value.trim())
      .filter((value) => value.length > 0)
      .slice(0, 3);

    return {
      name,
      missing,
      missingRate: rowCount === 0 ? 0 : round((missing / rowCount) * 100, 1),
      detectedType: typeProfile.type,
      typeConfidence: typeProfile.confidence,
      inconsistentValues: typeProfile.inconsistentValues,
      examples
    };
  });

  const missingValues = columns.reduce((total, column) => total + column.missing, 0);
  const missingRate = totalCells === 0 ? 0 : missingValues / totalCells;
  const duplicateRate = rowCount === 0 ? 0 : duplicateRows / rowCount;
  const inconsistentValues = columns.reduce((total, column) => total + column.inconsistentValues, 0);
  const nonMissingValues = Math.max(1, totalCells - missingValues);
  const inconsistentRate = inconsistentValues / nonMissingValues;
  const emptyColumnRate =
    columnCount === 0 ? 0 : columns.filter((column) => column.missing === rowCount).length / columnCount;

  const score = Math.max(
    0,
    Math.round(100 - missingRate * 45 - duplicateRate * 25 - inconsistentRate * 20 - emptyColumnRate * 10)
  );

  return {
    rowCount,
    columnCount,
    duplicateRows,
    duplicateRate: round(duplicateRate * 100, 1),
    missingValues,
    missingRate: round(missingRate * 100, 1),
    score,
    columns,
    issues: buildIssues(score, duplicateRows, columns)
  };
}

function parseCsv(input: string): string[][] {
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

function normalizeRow(row: string[], width: number): string[] {
  return Array.from({ length: width }, (_, index) => row[index]?.trim() ?? "");
}

function uniqueHeaders(headers: string[]): string[] {
  const seen = new Map<string, number>();
  return headers.map((header) => {
    const count = seen.get(header) ?? 0;
    seen.set(header, count + 1);
    return count === 0 ? header : `${header} (${count + 1})`;
  });
}

function countDuplicateRows(rows: string[][]): number {
  const seen = new Set<string>();
  let duplicates = 0;

  for (const row of rows) {
    const signature = JSON.stringify(row.map((value) => value.trim().toLowerCase()));
    if (seen.has(signature)) {
      duplicates += 1;
    } else {
      seen.add(signature);
    }
  }

  return duplicates;
}

function detectType(values: string[]): {
  readonly type: string;
  readonly confidence: number;
  readonly inconsistentValues: number;
} {
  const nonMissing = values.map((value) => value.trim()).filter((value) => !isMissing(value));

  if (nonMissing.length === 0) {
    return { type: "Empty", confidence: 100, inconsistentValues: 0 };
  }

  const candidates = [
    { type: "Boolean", matches: nonMissing.filter(isBoolean).length },
    { type: "Integer", matches: nonMissing.filter(isInteger).length },
    { type: "Decimal", matches: nonMissing.filter(isNumber).length },
    { type: "Date", matches: nonMissing.filter(isDateLike).length },
    { type: "Email", matches: nonMissing.filter(isEmail).length },
    { type: "URL", matches: nonMissing.filter(isUrl).length }
  ].sort((left, right) => right.matches - left.matches);

  const best = candidates[0];
  const confidence = round((best.matches / nonMissing.length) * 100, 0);

  if (best.matches === nonMissing.length) {
    return { type: best.type, confidence, inconsistentValues: 0 };
  }

  if (confidence >= 85) {
    return {
      type: best.type,
      confidence,
      inconsistentValues: nonMissing.length - best.matches
    };
  }

  if (confidence >= 50) {
    return {
      type: `Mixed (${best.type})`,
      confidence,
      inconsistentValues: nonMissing.length - best.matches
    };
  }

  return { type: "Text", confidence: 100, inconsistentValues: 0 };
}

function isMissing(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return normalized === "" || normalized === "null" || normalized === "n/a" || normalized === "na";
}

function isBoolean(value: string): boolean {
  return /^(true|false|yes|no)$/i.test(value);
}

function isInteger(value: string): boolean {
  return /^[-+]?\d+$/.test(value.trim());
}

function isNumber(value: string): boolean {
  const normalized = value.trim().replace(/,/g, "");
  return normalized !== "" && Number.isFinite(Number(normalized));
}

function isDateLike(value: string): boolean {
  const normalized = value.trim();
  if (!/[/-]/.test(normalized)) {
    return false;
  }
  const parsed = Date.parse(normalized);
  return Number.isFinite(parsed);
}

function isEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}

function isUrl(value: string): boolean {
  try {
    const parsed = new URL(value.trim());
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function buildIssues(score: number, duplicateRows: number, columns: ColumnProfile[]): string[] {
  const issues: string[] = [];
  const highMissing = columns.filter((column) => column.missingRate >= 20);
  const mixedTypes = columns.filter((column) => column.inconsistentValues > 0);
  const emptyColumns = columns.filter((column) => column.detectedType === "Empty");

  if (highMissing.length > 0) {
    issues.push(`${highMissing.length} columns have at least 20% missing values.`);
  }

  if (duplicateRows > 0) {
    issues.push(`${duplicateRows} duplicate rows were found.`);
  }

  if (mixedTypes.length > 0) {
    issues.push(`${mixedTypes.length} columns contain values that do not match the dominant type.`);
  }

  if (emptyColumns.length > 0) {
    issues.push(`${emptyColumns.length} columns are empty.`);
  }

  if (score >= 90 && issues.length === 0) {
    issues.push("No major data quality issues detected.");
  }

  return issues;
}

async function summarizeWithBedrock(
  profile: DataQualityProfile,
  fileName: string
): Promise<{ readonly text: string; readonly source: "bedrock" | "fallback" }> {
  const modelId = process.env.BEDROCK_MODEL_ID;

  if (!modelId) {
    return { text: fallbackSummary(profile), source: "fallback" };
  }

  try {
    const compactProfile = {
      fileName,
      rows: profile.rowCount,
      columnCount: profile.columnCount,
      score: profile.score,
      duplicateRows: profile.duplicateRows,
      missingRate: profile.missingRate,
      issues: profile.issues,
      columnProfiles: profile.columns.map((column) => ({
        name: column.name,
        missingRate: column.missingRate,
        type: column.detectedType,
        confidence: column.typeConfidence,
        inconsistentValues: column.inconsistentValues
      }))
    };

    const response = await bedrock.send(
      new ConverseCommand({
        modelId,
        system: [
          {
            text:
              "You are a data quality analyst. Summarize the dataset quality in a concise dashboard note. " +
              "Use three short sections: Overall, Issues, Recommendations. Do not invent columns or raw data."
          }
        ],
        messages: [
          {
            role: "user",
            content: [{ text: JSON.stringify(compactProfile) }]
          }
        ],
        inferenceConfig: {
          maxTokens: 420,
          temperature: 0.2
        }
      })
    );

    const text =
      response.output?.message?.content
        ?.map((block) => block.text)
        .filter((blockText): blockText is string => typeof blockText === "string")
        .join("\n")
        .trim() ?? "";

    return { text: text || fallbackSummary(profile), source: text ? "bedrock" : "fallback" };
  } catch (error) {
    console.error("bedrock_summary_failed", error);
    return { text: fallbackSummary(profile), source: "fallback" };
  }
}

function fallbackSummary(profile: DataQualityProfile): string {
  const headline =
    profile.score >= 85
      ? "Overall: The dataset is in strong shape for analysis."
      : profile.score >= 65
        ? "Overall: The dataset is usable, but cleanup is recommended before analysis."
        : "Overall: The dataset needs cleanup before reliable analysis.";

  const issues =
    profile.issues.length > 0 ? `Issues: ${profile.issues.join(" ")}` : "Issues: No major issues were detected.";
  const recommendations =
    "Recommendations: Review columns with high missing rates, remove duplicate rows, and standardize mixed-type values before reporting.";

  return `${headline}\n\n${issues}\n\n${recommendations}`;
}

function json(statusCode: number, body: unknown): APIGatewayProxyStructuredResultV2 {
  return {
    statusCode,
    headers: jsonHeaders,
    body: JSON.stringify(body)
  };
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

export { inspectCsv, parseCsv };
