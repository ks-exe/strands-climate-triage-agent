/**
 * Strands Agents SDK layer for the Climate Data & Incident Triage Agent.
 *
 * A single primary triage agent is created per request and given three explicit
 * tools. The Strands model-driven agent loop decides when to call each tool, runs
 * them, and writes a final triage decision. The tools share per-request state via a
 * closure so the model only needs to orchestrate (it passes minimal inputs); the
 * deterministic domain logic lives in telemetry.ts.
 *
 * Tools:
 *   1. inspect_sensor_data        -> data health (missing values, drift, stuck telemetry)
 *   2. evaluate_climate_risk      -> severe weather vs hardware fault
 *   3. generate_resilience_advisory -> plain-language action guidance
 *
 * After the loop we read the agent's conversation history (thought trail) and the
 * deterministic results the tools stored, and return both to the frontend.
 */

import { Agent, BedrockModel, tool } from "@strands-agents/sdk";
import { z } from "zod";
import {
  analyzeTelemetry,
  buildAdvisory,
  evaluateRisk,
  summarizeAdvisory,
  summarizeInspection,
  summarizeRisk,
  type Advisory,
  type RiskEvaluation,
  type TelemetryProfile
} from "./telemetry.js";

const AGENT_MODEL_ID = process.env.AGENT_MODEL_ID ?? "amazon.nova-lite-v1:0";
const BEDROCK_REGION = process.env.BEDROCK_REGION ?? process.env.AWS_REGION ?? "us-east-1";
const MAX_AGENT_MS = 24_000;
const MAX_TURNS = 6;

/** One step in the agent's reasoning trail (reasoning text, a tool call, or its result). */
export interface ReasoningStep {
  readonly step: number;
  readonly type: "reasoning" | "tool_call";
  readonly text?: string;
  readonly toolName?: string;
  readonly toolInput?: unknown;
  readonly toolOutput?: unknown;
  readonly durationMs?: number;
}

/** A compact record of a tool invocation for the dashboard. */
export interface ToolCallRecord {
  readonly name: string;
  readonly input: unknown;
  readonly output: unknown;
  readonly durationMs?: number;
}

/** Full response returned to the frontend. */
export interface TriageResponse {
  readonly fileName: string;
  readonly profile: TelemetryProfile;
  readonly agent: {
    readonly reasoningSteps: ReasoningStep[];
    readonly toolCalls: ToolCallRecord[];
    readonly verdict: RiskEvaluation["verdict"];
    readonly verdictLabel: string;
    readonly severity: RiskEvaluation["severity"];
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

interface TriageState {
  readonly fileName: string;
  readonly csvText: string;
  profile: TelemetryProfile | null;
  risk: RiskEvaluation | null;
  advisory: Advisory | null;
  timings: Record<string, number>;
}

/**
 * Run the full triage workflow for one submitted telemetry file.
 * Always returns a complete response: if the Strands agent cannot run (for example
 * Bedrock model access is not configured), it falls back to the deterministic
 * pipeline and labels the result so the dashboard stays useful.
 */
export async function runTriage(fileName: string, csvText: string): Promise<TriageResponse> {
  const trimmed = csvText.trim();
  if (!trimmed) {
    throw new Error("Upload a telemetry CSV file with at least a header row.");
  }

  const state: TriageState = {
    fileName: fileName || "telemetry.csv",
    csvText: trimmed,
    profile: null,
    risk: null,
    advisory: null,
    timings: {}
  };

  let reasoningSteps: ReasoningStep[] = [];
  let toolCalls: ToolCallRecord[] = [];
  let finalDecision = "";
  let stopReason = "fallback";
  let summarySource: "strands" | "fallback" = "fallback";

  try {
    const model = new BedrockModel({
      region: BEDROCK_REGION,
      modelId: AGENT_MODEL_ID,
      maxTokens: 1200,
      temperature: 0.2
    });

    const inspectTool = tool({
      name: "inspect_sensor_data",
      description:
        "Inspect environmental sensor telemetry for data health: missing values, sensor drift, and stuck telemetry values. Call this FIRST for every dataset. The full metrics are stored internally; this returns a compact findings summary.",
      inputSchema: z.object({
        fileName: z.string().optional().describe("The name of the telemetry file being inspected.")
      }),
      callback: (input) => {
        const started = Date.now();
        const name = typeof input?.fileName === "string" && input.fileName ? input.fileName : state.fileName;
        state.profile = analyzeTelemetry(state.csvText, name);
        state.timings["inspect_sensor_data"] = Date.now() - started;
        return summarizeInspection(state.profile);
      }
    });

    const evaluateTool = tool({
      name: "evaluate_climate_risk",
      description:
        "Evaluate whether anomalous telemetry indicates an actual severe weather, flood, or heat event versus a faulty sensor. Call AFTER inspect_sensor_data. Returns a verdict, severity, hazards and confidence using the stored inspection findings.",
      inputSchema: z.object({
        focus: z.string().optional().describe("Optional focus such as 'flood', 'heat', 'air', or 'drought'.")
      }),
      callback: () => {
        const started = Date.now();
        if (!state.profile) state.profile = analyzeTelemetry(state.csvText, state.fileName);
        state.risk = evaluateRisk(state.profile);
        state.timings["evaluate_climate_risk"] = Date.now() - started;
        return summarizeRisk(state.risk);
      }
    });

    const advisoryTool = tool({
      name: "generate_resilience_advisory",
      description:
        "Generate plain-language action guidance for affected local communities and farmers based on the climate risk evaluation. Call AFTER evaluate_climate_risk. Returns structured immediate, community, farmer and monitoring actions.",
      inputSchema: z.object({
        audience: z.enum(["communities", "farmers", "both"]).optional().describe("Primary audience for the guidance; the advisory covers both when omitted.")
      }),
      callback: () => {
        const started = Date.now();
        if (!state.profile) state.profile = analyzeTelemetry(state.csvText, state.fileName);
        if (!state.risk) state.risk = evaluateRisk(state.profile);
        state.advisory = buildAdvisory(state.risk);
        state.timings["generate_resilience_advisory"] = Date.now() - started;
        return summarizeAdvisory(state.advisory);
      }
    });

    const agent = new Agent({
      model,
      printer: false,
      systemPrompt: [
        "You are the Climate Data & Incident Triage Agent, supporting climate-resilience decision making for vulnerable communities and farmers.",
        "For every telemetry dataset you receive, run the triage workflow in this exact order:",
        "1) Call inspect_sensor_data to assess data health (missing values, sensor drift, stuck telemetry).",
        "2) Call evaluate_climate_risk using those findings to classify the situation as a severe weather event versus a hardware fault.",
        "3) Call generate_resilience_advisory to produce plain-language action guidance for communities and farmers.",
        "4) Then write a concise final Triage Decision (three to six sentences) stating the verdict, severity, the most important hazards or sensor faults, and the top actions affected communities and farmers should take now.",
        "Do not skip steps and call each tool exactly once, in this order, then write the final Triage Decision. Do not call a tool more than once. Do not invent readings that the tools did not return. The tools share state, so pass minimal or empty inputs. Do not wrap your output in <thinking> or <finalDecision> tags; respond in plain prose."
      ].join(" "),
      tools: [inspectTool, evaluateTool, advisoryTool]
    });

    const prompt = `Triage the environmental sensor telemetry file "${state.fileName}". Run the full triage workflow (inspect_sensor_data, evaluate_climate_risk, generate_resilience_advisory) and then write the final Triage Decision.`;

    const result = await agent.invoke(prompt, {
      limits: { turns: MAX_TURNS },
      cancelSignal: AbortSignal.timeout(MAX_AGENT_MS)
    });

    reasoningSteps = extractReasoningSteps(agent.messages, state.timings);
    toolCalls = buildToolCallRecords(reasoningSteps, state.timings);
    finalDecision = extractFinalText(result) || synthesizeFallbackDecision(state);
    stopReason = result.stopReason ?? "endTurn";
    summarySource = "strands";
  } catch (error) {
    console.error("triage_agent_failed", error);
    stopReason = "fallback";
    summarySource = "fallback";
  }

  // Defensive: guarantee the deterministic results exist even if a tool was skipped.
  if (!state.profile) state.profile = analyzeTelemetry(state.csvText, state.fileName);
  if (!state.risk) state.risk = evaluateRisk(state.profile);
  if (!state.advisory) state.advisory = buildAdvisory(state.risk);
  if (!finalDecision) finalDecision = synthesizeFallbackDecision(state);

  return {
    fileName: state.fileName,
    profile: state.profile,
    agent: {
      reasoningSteps,
      toolCalls,
      verdict: state.risk.verdict,
      verdictLabel: state.risk.verdictLabel,
      severity: state.risk.severity,
      hazards: state.risk.hazards.map((hazard) => `${hazard.label} (${hazard.severity})`),
      faults: state.risk.faults,
      advisory: state.advisory,
      finalDecision,
      stopReason,
      modelId: AGENT_MODEL_ID
    },
    summary: finalDecision,
    summarySource
  };
}

/** Walk the Strands conversation history and build an ordered reasoning trail. */
function extractReasoningSteps(messages: readonly unknown[], timings: Record<string, number>): ReasoningStep[] {
  const steps: ReasoningStep[] = [];
  const toolUseIndex = new Map<string, number>();
  let count = 0;

  for (const message of messages) {
    const role = read(message, "role");
    const content = Array.isArray(read(message, "content")) ? read(message, "content") : [];
    if (!Array.isArray(content)) continue;

    for (const block of content) {
      const type = read(block, "type");
      if (type === "textBlock" && role === "assistant") {
        const text = cleanModelText(String(read(block, "text") ?? ""));
        if (text) {
          count += 1;
          steps.push({ step: count, type: "reasoning", text });
        }
      } else if (type === "reasoningBlock" && role === "assistant") {
        const text = cleanModelText(String(read(block, "text") ?? ""));
        if (text) {
          count += 1;
          steps.push({ step: count, type: "reasoning", text: truncate(text, 400) });
        }
      } else if (type === "toolUseBlock") {
        const name = String(read(block, "name") ?? "");
        count += 1;
        steps.push({
          step: count,
          type: "tool_call",
          toolName: name,
          toolInput: read(block, "input") ?? {},
          durationMs: timings[name]
        });
        const toolUseId = String(read(block, "toolUseId") ?? "");
        if (toolUseId) toolUseIndex.set(toolUseId, steps.length - 1);
      } else if (type === "toolResultBlock") {
        const toolUseId = String(read(block, "toolUseId") ?? "");
        const output = extractToolResultText(read(block, "content"));
        const index = toolUseIndex.get(toolUseId);
        if (index !== undefined && steps[index]) {
          steps[index] = { ...steps[index], toolOutput: output };
        }
      }
    }
  }

  return steps;
}

function extractToolResultText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const item of content) {
    const type = read(item, "type");
    if (type === "textBlock" && typeof read(item, "text") === "string") {
      parts.push(String(read(item, "text")));
    } else if (type === "jsonBlock" && read(item, "json") !== undefined) {
      parts.push(JSON.stringify(read(item, "json")));
    }
  }
  return parts.join("\n").trim();
}

function buildToolCallRecords(steps: ReasoningStep[], timings: Record<string, number>): ToolCallRecord[] {
  return steps
    .filter((step) => step.type === "tool_call")
    .map((step) => ({
      name: step.toolName ?? "",
      input: step.toolInput,
      output: step.toolOutput,
      durationMs: timings[step.toolName ?? ""]
    }));
}

function extractFinalText(result: { readonly lastMessage?: unknown; toString?: () => string }): string {
  const lastMessage = result.lastMessage;
  let raw = "";
  if (lastMessage && typeof lastMessage === "object") {
    const content = read(lastMessage, "content");
    if (Array.isArray(content)) {
      raw = content
        .filter((block: any) => read(block, "type") === "textBlock" && typeof read(block, "text") === "string")
        .map((block: any) => String(read(block, "text")))
        .join("\n")
        .trim();
    }
  }
  if (!raw && typeof result.toString === "function") {
    raw = result.toString().trim();
  }
  if (!raw) return "";
  // Some models wrap the answer in <finalDecision>...</finalDecision>; prefer that.
  const decision = raw.match(/<finalDecision>([\s\S]*?)<\/finalDecision>/i);
  if (decision) return decision[1].trim();
  // Otherwise drop any <thinking>...</thinking> blocks and stray wrapper tags.
  return cleanModelText(raw) || raw;
}

/** Remove model-specific wrapper tags (<thinking>, <finalDecision>) and keep readable prose. */
function cleanModelText(text: string): string {
  return text
    .replace(/<thinking>[\s\S]*?<\/thinking>/gi, "")
    .replace(/<\/?(?:thinking|finalDecision)>/gi, "")
    .trim();
}

function synthesizeFallbackDecision(state: TriageState): string {
  if (!state.risk || !state.advisory) return "Triage complete. Review the data-health metrics and advisory below.";
  const hazardLine = state.risk.hazards.length
    ? state.risk.hazards.map((h) => `${h.label} (${h.severity})`).join(", ")
    : "no confirmed hazards";
  const faultLine = state.risk.faults.length ? ` Sensor faults detected: ${state.risk.faults.join(" ")}` : "";
  return `${state.risk.verdictLabel} (${state.risk.severity} severity, ${state.risk.confidence}% confidence). Hazards: ${hazardLine}.${faultLine} ${state.advisory.headline}`;
}

function read(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>)[key] : undefined;
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}
