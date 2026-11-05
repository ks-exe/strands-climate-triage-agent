import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyStructuredResultV2
} from "aws-lambda";
import { runTriage } from "./agent.js";

const MAX_BODY_BYTES = 4_500_000;

const jsonHeaders = {
  "content-type": "application/json",
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "content-type",
  "access-control-allow-methods": "OPTIONS,POST"
};

interface InspectRequest {
  readonly fileName?: string;
  readonly csvText?: string;
}

/**
 * API Gateway handler. Accepts a telemetry CSV and returns the Strands agent's
 * reasoning trail, risk verdict and resilience advisory alongside the data metrics.
 */
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
      return json(400, { message: "Upload a telemetry CSV file with at least a header row." });
    }
    if (Buffer.byteLength(csvText, "utf8") > MAX_BODY_BYTES) {
      return json(413, { message: "CSV is too large for instant triage. Keep files under 4.5 MB." });
    }

    const result = await runTriage(request.fileName ?? "telemetry.csv", csvText);
    return json(200, result);
  } catch (error) {
    console.error("triage_handler_failed", error);
    return json(500, { message: "The telemetry could not be triaged. Check the file format and try again." });
  }
};

function parseRequest(event: APIGatewayProxyEventV2): InspectRequest {
  const rawBody = event.isBase64Encoded
    ? Buffer.from(event.body ?? "", "base64").toString("utf8")
    : event.body ?? "";

  if (!rawBody) return {};

  const parsed = JSON.parse(rawBody) as InspectRequest;
  return {
    fileName: typeof parsed.fileName === "string" ? parsed.fileName : undefined,
    csvText: typeof parsed.csvText === "string" ? parsed.csvText : undefined
  };
}

function json(statusCode: number, body: unknown): APIGatewayProxyStructuredResultV2 {
  return { statusCode, headers: jsonHeaders, body: JSON.stringify(body) };
}
