/**
 * Local development API server.
 *
 * Runs the same Strands triage pipeline as the deployed Lambda so `npm run dev`
 * works end-to-end without deploying. Uses the AWS credentials in your
 * environment to call Amazon Bedrock.
 *
 *   npm run dev:api     # this server, http://127.0.0.1:8787
 *   npm run dev         # Vite frontend, proxies /api to this server
 */

import { createServer, type IncomingMessage } from "node:http";
import { runTriage } from "../lambda/agent.js";

const PORT = Number(process.env.PORT ?? 8787);
const HOST = process.env.HOST ?? "127.0.0.1";

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

const server = createServer(async (request, response) => {
  response.setHeader("access-control-allow-origin", "*");
  response.setHeader("access-control-allow-headers", "content-type");
  response.setHeader("access-control-allow-methods", "OPTIONS,POST");

  if (request.method === "OPTIONS") {
    response.writeHead(204);
    response.end();
    return;
  }

  if (request.method === "POST" && request.url === "/api/inspect") {
    try {
      const body = await readBody(request);
      const parsed = body ? (JSON.parse(body) as { fileName?: string; csvText?: string }) : {};
      const fileName = typeof parsed.fileName === "string" ? parsed.fileName : "telemetry.csv";
      const csvText = typeof parsed.csvText === "string" ? parsed.csvText : "";
      const result = await runTriage(fileName, csvText);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(result));
    } catch (error) {
      console.error("local_triage_failed", error);
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ message: error instanceof Error ? error.message : "Triage failed." }));
    }
    return;
  }

  response.writeHead(404, { "content-type": "application/json" });
  response.end(JSON.stringify({ message: "Not found. POST a CSV to /api/inspect." }));
});

server.listen(PORT, HOST, () => {
  console.log(`Climate triage API listening on http://${HOST}:${PORT}/api/inspect`);
});
