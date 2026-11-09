import type { ErrorCode, ErrorResponse, Event, EventStreamRequest, ResultData } from "@langchain/protocol";
import { AgentCommandError, type AgentCommand, type AgentChannel, type AgentCommandResult, type EventStreamFilter, type HostedAgentEvent } from "./types.ts";

export class ProtocolRequestError extends Error {
  readonly status: number;
  readonly code: ErrorCode;

  constructor(message: string, status = 400, code: ErrorCode = "invalid_argument") {
    super(message);
    this.name = "ProtocolRequestError";
    this.status = status;
    this.code = code;
  }
}

export interface ParsedCommand {
  id: number;
  command: AgentCommand;
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function string(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function namespace(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((part) => typeof part === "string") ? value : undefined;
}

function optionalRecord(source: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
  if (!Object.hasOwn(source, key)) return undefined;
  const value = object(source[key]);
  if (!value) throw new ProtocolRequestError(`${key} must be an object.`);
  return value;
}

function validGoto(value: unknown): boolean {
  if (typeof value === "string" && value.length > 0) return true;
  if (Array.isArray(value)) return value.every(validGoto);
  const send = object(value);
  return !!send && typeof send.node === "string" && send.node.length > 0;
}

export function parseProtocolCommand(value: unknown): ParsedCommand {
  const body = object(value);
  if (!body || !Number.isSafeInteger(body.id) || (body.id as number) < 0) {
    throw new ProtocolRequestError("Command id must be a non-negative safe integer.");
  }
  const method = body.method;
  const params = object(body.params);
  if (!params) throw new ProtocolRequestError("Command params must be an object.");
  const commandId = String(body.id);

  if (method === "run.start") {
    const assistantId = string(params.assistant_id);
    if (!assistantId) throw new ProtocolRequestError("run.start requires assistant_id.");
    if (!Object.hasOwn(params, "input")) throw new ProtocolRequestError("run.start requires input.");
    const config = optionalRecord(params, "config");
    const metadata = optionalRecord(params, "metadata");
    const langsmithTracer = optionalRecord(params, "langsmith_tracer");
    return {
      id: body.id as number,
      command: {
        type: "run.start",
        commandId,
        assistantId,
        input: params.input,
        ...(config ? { config } : {}),
        ...(metadata ? { metadata } : {}),
        ...(langsmithTracer ? { langsmithTracer } : {}),
      },
    };
  }

  if (method === "input.respond") {
    let entry: Record<string, unknown>;
    if (Array.isArray(params.responses)) {
      if (params.responses.length !== 1) throw new ProtocolRequestError("This server supports one input.respond entry at a time.", 501, "not_supported");
      const first = object(params.responses[0]);
      if (!first) throw new ProtocolRequestError("input.respond response entries must be objects.");
      entry = first;
    } else {
      entry = params;
    }
    const interruptId = string(entry.interrupt_id);
    const responseNamespace = namespace(entry.namespace);
    if (!interruptId || !responseNamespace) {
      throw new ProtocolRequestError("input.respond requires interrupt_id and a string-array namespace.");
    }
    if (!Object.hasOwn(entry, "response")) throw new ProtocolRequestError("input.respond requires response.");
    const update = optionalRecord(params, "update");
    const config = optionalRecord(params, "config");
    const metadata = optionalRecord(params, "metadata");
    const goto = params.goto;
    if (goto !== undefined && !validGoto(goto)) throw new ProtocolRequestError("input.respond goto has an invalid shape.");
    return {
      id: body.id as number,
      command: {
        type: "input.respond",
        commandId,
        namespace: responseNamespace,
        interruptId,
        response: entry.response,
        ...(update ? { update } : {}),
        ...(goto !== undefined ? { goto } : {}),
        ...(config ? { config } : {}),
        ...(metadata ? { metadata } : {}),
      },
    };
  }

  if (method === "state.get") {
    const stateNamespace = namespace(params.namespace);
    if (!stateNamespace) throw new ProtocolRequestError("state.get requires a string-array namespace.");
    if (params.keys !== undefined && (!Array.isArray(params.keys) || !params.keys.every((key) => typeof key === "string"))) {
      throw new ProtocolRequestError("state.get keys must be an array of strings.");
    }
    return {
      id: body.id as number,
      command: {
        type: "state.get",
        commandId,
        namespace: stateNamespace,
        ...(Array.isArray(params.keys) ? { keys: params.keys as string[] } : {}),
      },
    };
  }

  throw new ProtocolRequestError(`Unsupported protocol command: ${String(method ?? "(missing)")}.`, 501, "unknown_command");
}

export function commandResponse(id: number, result: AgentCommandResult): { type: "success"; id: number; result: ResultData } {
  return { type: "success", id, result: result.result as ResultData };
}

export function protocolErrorResponse(id: number | null, error: unknown): ErrorResponse {
  const requestError = error instanceof ProtocolRequestError ? error : undefined;
  const agentError = error instanceof AgentCommandError ? error : undefined;
  const message = error instanceof Error ? error.message : String(error);
  const code: ErrorCode = requestError?.code ?? agentError?.code ?? "unknown_error";
  const safeError = requestError ?? agentError;
  return { type: "error", id, error: code, message, meta: { retry_safe: safeError !== undefined, ...(safeError ? { http_status: safeError.status } : {}) } };
}

export function parseEventFilter(value: unknown): EventStreamFilter {
  const body = object(value ?? {});
  if (!body) throw new ProtocolRequestError("Event stream body must be an object.");
  const channels = body.channels ?? ["lifecycle", "input", "custom"];
  if (!Array.isArray(channels) || !channels.every((channel) => typeof channel === "string")) {
    throw new ProtocolRequestError("channels must be an array of strings.");
  }
  if (body.namespaces !== undefined && (!Array.isArray(body.namespaces) || !body.namespaces.every(namespace))) {
    throw new ProtocolRequestError("namespaces must be an array of string arrays.");
  }
  if (body.depth !== undefined && (!Number.isSafeInteger(body.depth) || (body.depth as number) < 0)) {
    throw new ProtocolRequestError("depth must be a non-negative integer.");
  }
  if (body.since !== undefined && (!Number.isSafeInteger(body.since) || (body.since as number) < 0)) {
    throw new ProtocolRequestError("since must be a non-negative integer.");
  }
  return {
    channels: channels as AgentChannel[],
    ...(Array.isArray(body.namespaces) ? { namespaces: body.namespaces as string[][] } : {}),
    ...(typeof body.depth === "number" ? { depth: body.depth } : {}),
    ...(typeof body.since === "number" ? { since: body.since } : {}),
  };
}

export function matchesEventFilter(event: HostedAgentEvent, filter: EventStreamFilter): boolean {
  const channelMatch = filter.channels.includes(event.channel)
    || (event.channel.startsWith("custom:") && filter.channels.includes("custom"));
  if (!channelMatch) return false;
  if (!filter.namespaces?.length) return true;
  return filter.namespaces.some((prefix) => {
    if (prefix.length > event.namespace.length) return false;
    if (prefix.some((part, index) => event.namespace[index] !== part)) return false;
    if (filter.depth === undefined) return true;
    return event.namespace.length - prefix.length <= filter.depth;
  });
}

export function toProtocolEvent(event: HostedAgentEvent, seq: number): Event {
  const eventId = String(seq);
  const params = {
    namespace: event.namespace,
    timestamp: event.timestamp,
    data: event.data,
  };
  return {
    type: "event",
    event_id: eventId,
    seq,
    method: event.method,
    params,
  } as unknown as Event;
}
