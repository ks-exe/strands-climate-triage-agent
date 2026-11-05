# Climate Data &amp; Incident Triage Agent

> An AI agent for social good that turns raw environmental-sensor telemetry into safe, plain-language action guidance for climate-vulnerable communities and farmers — built with the **Strands Agents SDK** for the *"Strands SDK: Workshop to Ship"* hackathon.

Most early-warning systems fail not because the weather is a surprise, but because the **data is unreliable**: a stuck or drifting sensor can either trigger a false alarm that erodes trust, or mask a real flood or heatwave until it is too late. This agent closes that gap. Upload a telemetry CSV and a model-driven Strands agent inspects the data, decides whether an anomaly is a **real severe-weather event** or a **faulty sensor**, and writes a plain-language action plan for the people who have to act on it.

**Focus area:** Climate Resilience — *Environmental Data Health &amp; Sensor Incident Triage.*

---

## Why this matters (measurable impact)

Climate-vulnerable, low-resource communities and smallholder farmers depend on sensor-driven alerts that are often the only early-warning channel they have. Bad sensor data is the silent killer in that chain:

- A **stuck soil-moisture sensor** can hide a drought, or falsely confirm one.
- A **drifting humidity sensor** can exaggerate a heat index and trigger costly evacuations.
- An **impossible temperature reading** (e.g. 999 °C) can auto-fire a panic alert that, once proven false, makes the whole system ignored next time.

This agent addresses each failure mode directly:

| Failure mode today | What the agent does | Measurable outcome |
| --- | --- | --- |
| Anomalous reading auto-fires an alert | `evaluate_climate_risk` separates **severe weather** from **hardware fault** before anything is sent | Fewer false alarms → higher alert trust and adherence |
| Stuck / drifting sensor silently corrupts decisions | `inspect_sensor_data` flags missing values, sensor drift and stuck telemetry | Faults are caught in the same triage pass as the hazard, not days later |
| Technical alerts that communities can't act on | `generate_resilience_advisory` writes community + farmer actions in plain language | At-risk people get *what to do now*, not just *what went wrong* |
| Sensor fault hidden behind a "valid-looking" hazard | The agent refuses to raise a public alert on unconfirmed readings and queues technician follow-up | Maintenance is routed to the right sensor, public panic is avoided |

For a regional early-warning operator running hundreds of stations, this is the difference between a 24-hour-late, low-confidence alert and a same-hour, human-readable triage decision with a confidence score and a clear next action.

---

## How the Strands Agents SDK is implemented

The agent is a genuine **model-driven Strands agent loop**, not a prompt with a bolted-on function call. There is one primary triage agent. For every uploaded file it runs a fixed three-tool workflow and then writes a final triage decision:

```
inspect_sensor_data  →  evaluate_climate_risk  →  generate_resilience_advisory  →  final Triage Decision
```

### The three explicit tools

Each tool is a typed `tool()` from `@strands-agents/sdk` with a Zod input schema and a pure callback. The deterministic domain logic lives in `lambda/telemetry.ts`; the Strands layer in `lambda/agent.ts` only orchestrates.

| Tool | Responsibility | Key checks |
| --- | --- | --- |
| `inspect_sensor_data` | Data health | missing values, **sensor drift** (sustained baseline shift), **stuck telemetry** (long constant runs), impossible out-of-bounds readings |
| `evaluate_climate_risk` | Classification | Confirms or rejects each hazard (heat, flood, storm, air, drought, cold) and decides `severe_weather` vs `hardware_fault` vs `mixed` vs `nominal`, with a confidence score |
| `generate_resilience_advisory` | Action guidance | Plain-language immediate / community / farmer / monitoring actions tailored to the verdict |

### The agent loop (the Strands part)

```ts
const agent = new Agent({
  model: new BedrockModel({ region, modelId, maxTokens: 1200, temperature: 0.2 }),
  systemPrompt: CLIMATE_TRIAGE_PROMPT,   // "run the 3 tools in order, then write the Triage Decision"
  tools: [inspectTool, evaluateTool, advisoryTool],
  printer: false
});

const result = await agent.invoke(
  `Triage the telemetry file "${fileName}". Run the full triage workflow, then write the final Triage Decision.`,
  { limits: { turns: 6 }, cancelSignal: AbortSignal.timeout(24_000) }
);
```

The model decides **when** to call each tool, Strands runs the loop (model → tool → model → tool → …) until the model produces a final message with no tool calls (`stopReason: "endTurn"`). The tools share per-request state via a closure, so the model only orchestrates — it passes minimal inputs and never has to echo large CSV payloads through tool arguments.

### Why this is better than a single prompt

- **Reliability.** The three checks are deterministic, so the numbers (missing rate, stuck runs, hazard thresholds) are exact and reproducible. The model contributes judgment and natural language, not arithmetic.
- **Explainability.** The agent returns its full **reasoning trail** — every thinking step and tool call with inputs and outputs — alongside the final decision, so a human operator can audit *why* the agent said what it said.
- **Graceful degradation.** If the model can't run (no model access, timeout), the deterministic pipeline still produces a complete, correct triage and the response is labelled `summarySource: "fallback"` — the dashboard never goes blank.

### Severe-weather vs hardware-fault — the hard call

A heatwave *legitimately* ramps temperature upward; that same monotonic ramp looks identical to sensor drift to a naïve detector. `evaluate_climate_risk` resolves this by suppressing drift faults for any column that is the **source of a confirmed hazard** (the change is the weather, not the sensor) and by guarding near-zero-mean columns (e.g. rainfall ≈ 0) against false drift. That is the core "is this real or is the sensor broken" judgment the agent exists to make.

---

## Architecture

```mermaid
flowchart LR
  user[User / operator] --> browser[React dashboard]
  browser -->|GET / and assets| api[Amazon API Gateway HTTP API]
  api -->|Static proxy| s3[S3 website bucket]
  browser -->|POST /api/inspect telemetry CSV| api
  api -->|Lambda proxy| fn[AWS Lambda: triage handler]
  fn -->|Strands agent loop| strands["Strands Agent\n(3 tools)"]
  strands -->|Converse API| bedrock[Amazon Bedrock model]
  strands --> tools["Deterministic tools\ntelemetry.ts"]
  tools --> metrics[(data-health profile)]
  tools --> risk[(risk evaluation)]
  tools --> advisory[(action plan)]
  strands --> trail[(reasoning trail)]
  fn -->|JSON: profile + reasoning + advisory| browser
  cdk[AWS CDK] --> cfn[CloudFormation]
  cfn --> api
  cfn --> fn
  cfn --> s3
```

**Request flow**

1. The operator uploads a telemetry CSV in the React dashboard.
2. The frontend POSTs the CSV text to `/api/inspect` (API Gateway → Lambda).
3. The Lambda handler calls `runTriage()` from `lambda/agent.ts`.
4. A Strands `Agent` is built with the three tools and a Bedrock model.
5. `agent.invoke()` runs the model-driven loop: the model calls `inspect_sensor_data` → `evaluate_climate_risk` → `generate_resilience_advisory`, then writes the final triage decision.
6. The handler returns the data-health profile, the agent's reasoning trail, the risk verdict, and the structured advisory as JSON.
7. The dashboard renders metrics, the "Agent Reasoning &amp; Action Plan" panel (tool calls + final decision + action plan), and the telemetry column profile.

---

## Screenshots

<p align="center">
  <img src="docs/screenshots/dashboard-overview.png" alt="Climate triage dashboard overview with metrics, score gauge, and the agent reasoning panel" width="100%" />
</p>

<p align="center">
  <img src="docs/screenshots/agent-reasoning.png" alt="Agent reasoning trail showing the three sequential tool calls and the final triage decision" width="100%" />
</p>

---

## Run locally and test with sample data

You need **Node.js 22+** and an AWS account with access to a Bedrock model in `us-east-1` (default is Amazon Nova Lite). The app also runs fully end-to-end locally — no deploy required.

### 1. Install

```bash
npm install
```

### 2. Provide AWS credentials for Bedrock

Any standard credential source works — `aws configure`, environment variables, or an SSO profile:

```bash
aws configure
# or
set AWS_ACCESS_KEY_ID=...
set AWS_SECRET_ACCESS_KEY=...
```

### 3. Run the agent API locally

```bash
npm run dev:api
# -> Climate triage API listening on http://127.0.0.1:8787/api/inspect
```

### 4. Run the frontend (second terminal)

```bash
npm run dev
# -> Vite dev server on http://127.0.0.1:5173 (proxies /api to the local agent API)
```

### 5. Test with the sample telemetry

Open http://127.0.0.1:5173 and upload `sample-data/sensor_telemetry.csv`.

The sample is a 24-hour hourly stream from one riverside weather station containing:

- A **confirmed heatwave**: temperature ramps 38 → 47.2 °C (a real, in-bounds hazard).
- A **stuck soil-moisture sensor** pinned at 18.0 % for all 24 readings (a hardware fault).
- A couple of **missing values** in humidity and wind.

Expected result: a **mixed** verdict — *real hazard with a faulty sensor*, **high** severity, ~92 % confidence — with the agent advising to act on the confirmed heatwave (cooling centres, pause midday field work) while queuing a technician for the soil-moisture sensor rather than alarming the public.

You can also drive the API directly:

```bash
node -e "const fs=require('fs');const csv=fs.readFileSync('sample-data/sensor_telemetry.csv','utf8');fetch('http://127.0.0.1:8787/api/inspect',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({fileName:'sensor_telemetry.csv',csvText:csv})}).then(r=>r.json()).then(j=>console.log(JSON.stringify(j.agent,null,2)))"
```

### Frontend-only against a deployed API

```powershell
$env:VITE_API_URL="https://YOUR_API_ID.execute-api.us-east-2.amazonaws.com"
npm run dev
```

---

## Deploy to AWS (CDK)

The stack provisions an API Gateway HTTP API, a Node.js 22 Lambda running the Strands agent, an S3 website bucket for the React build, and a least-privilege IAM role. It targets `us-east-2` for infrastructure and `us-east-1` for Bedrock (the same region setup the original project validated).

```bash
# one-time bootstrap
npx cdk bootstrap aws://ACCOUNT_ID/us-east-2

# deploy
npm run deploy
```

The deployed URL is printed as the `ApplicationUrl` stack output. The Lambda bundles `@strands-agents/sdk` and `zod` through esbuild — no layers or containers needed.

### Configure the model

Override the model the agent uses (the model must be enabled in Bedrock):

```bash
npm run deploy -- --context agentModelId=amazon.nova-lite-v1:0          # default, fast, good tool use
npm run deploy -- --context agentModelId=anthropic.claude-3-5-haiku-20241022-v1:0  # most reliable tool calling
npm run deploy -- --context agentModelId=amazon.nova-micro-v1:0        # smallest/cheapest
npm run deploy -- --context bedrockRegion=us-east-1                    # override Bedrock region
```

For local development the same variables are read from the environment: `AGENT_MODEL_ID` and `BEDROCK_REGION`.

---

## Project structure

```
lambda/
  telemetry.ts   Deterministic domain logic: CSV parse, data-health, risk, advisory (no LLM)
  agent.ts       Strands Agent + the 3 tools + runTriage() (the agent loop)
  inspect.ts     API Gateway Lambda handler (thin)
local/
  api.ts         Local dev API server (same runTriage pipeline, no deploy needed)
lib/
  data-quality-inspector-stack.ts   CDK stack (API Gateway + Lambda + S3 + IAM)
bin/
  data-quality-inspector.ts         CDK app entry
src/
  App.tsx        Climate triage dashboard + "Agent Reasoning & Action Plan" panel
  styles.css     Dashboard styles
sample-data/
  sensor_telemetry.csv   Heatwave + stuck-sensor sample
scripts/
  generate-screenshots.mjs   Reproduce the README screenshots with Playwright
```

---

## AWS services used

| Service | Purpose |
| --- | --- |
| Amazon Bedrock | The model behind the Strands agent loop (default Amazon Nova Lite in `us-east-1`) |
| AWS Lambda (Node.js 22) | Runs the Strands agent and the three tools, bundled with esbuild |
| Amazon API Gateway HTTP API | Public HTTPS endpoint; routes `/api/inspect` to Lambda and serves the React build from S3 |
| Amazon S3 | Hosts the built React dashboard as a static website |
| AWS IAM | Grants the Lambda `bedrock:InvokeModel`, `bedrock:Converse`, `bedrock:ConverseStream` |
| Amazon CloudWatch Logs | Lambda operational logs |
| AWS CDK / CloudFormation | Infrastructure as code |

---

## Tech stack

- **Strands Agents SDK** (`@strands-agents/sdk`) — model-driven agent loop + typed tools
- **Amazon Bedrock** — model provider (Nova Lite / Claude Haiku / Nova Micro)
- **Zod** — type-safe tool input schemas
- **React + Vite + TypeScript** — dashboard
- **AWS CDK** — infrastructure
- **Node.js 22 / esbuild** — Lambda runtime and bundling

---

## Security and privacy

- No AWS credentials or secrets are stored in the repository.
- The agent only ever sees the telemetry you upload; nothing is persisted. Uploaded CSV content is processed in memory and discarded with the request.
- The deterministic tools never transmit raw data to the model — only the compact summaries the tools return enter the model's context, keeping prompts small and cost low.
- `node_modules`, `dist`, and `cdk.out` are git-ignored.

---

## Reproduce the screenshots

```bash
npm run dev:api        # terminal 1
npm run dev            # terminal 2
npm run screenshots    # terminal 3 — writes docs/screenshots/*.png
```

---

## License

MIT — see `LICENSE` if present, otherwise treat as project-internal. Built for the *Strands SDK: Workshop to Ship* hackathon.
