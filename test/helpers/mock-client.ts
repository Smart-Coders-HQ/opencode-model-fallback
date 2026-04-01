import type { PluginInput } from "@opencode-ai/plugin";
import type { AssistantMessage, Part, UserMessage } from "@opencode-ai/sdk";

type Client = PluginInput["client"];

export interface MockMessageEntry {
  info: UserMessage | AssistantMessage;
  parts: Part[];
}

export interface MockClientCalls {
  abort: string[];
  get: string[];
  revert: Array<{ sessionId: string; messageID: string }>;
  prompt: Array<{
    sessionId: string;
    providerID: string;
    modelID: string;
    agent?: string;
    parts: unknown[];
  }>;
  toasts: Array<{ title?: string; message: string; variant: string }>;
  logs: Array<{ level: string; message: string }>;
}

export interface MockClientOptions {
  messages?: MockMessageEntry[];
  session?: unknown;
  abortError?: Error;
  revertError?: Error;
  promptError?: Error;
  messagesError?: Error;
  sessionGetError?: Error;
}

export function makeMockClient(opts: MockClientOptions = {}): {
  client: Client;
  calls: MockClientCalls;
} {
  const calls: MockClientCalls = {
    abort: [],
    get: [],
    revert: [],
    prompt: [],
    toasts: [],
    logs: [],
  };

  const messages = opts.messages ?? [
    makeUserMessage("s1", "m1", "openai", "gpt-5.3-codex"),
  ];
  const session = opts.session ?? {};

  const client = {
    session: {
      get: async (options: { path: { id: string } }) => {
        if (opts.sessionGetError) throw opts.sessionGetError;
        calls.get.push(options.path.id);
        return { data: session };
      },
      abort: async (options: { path: { id: string } }) => {
        if (opts.abortError) throw opts.abortError;
        calls.abort.push(options.path.id);
        return { data: {} };
      },
      revert: async (options: {
        path: { id: string };
        body?: { messageID: string };
      }) => {
        if (opts.revertError) throw opts.revertError;
        calls.revert.push({
          sessionId: options.path.id,
          messageID: options.body?.messageID ?? "",
        });
        return { data: {} };
      },
      prompt: async (options: {
        path: { id: string };
        body?: {
          model?: { providerID: string; modelID: string };
          agent?: string;
          parts?: unknown[];
        };
      }) => {
        if (opts.promptError) throw opts.promptError;
        calls.prompt.push({
          sessionId: options.path.id,
          providerID: options.body?.model?.providerID ?? "",
          modelID: options.body?.model?.modelID ?? "",
          agent: options.body?.agent,
          parts: options.body?.parts ?? [],
        });
        return { data: {} };
      },
      messages: async (_options: { path: { id: string } }) => {
        if (opts.messagesError) throw opts.messagesError;
        return { data: messages };
      },
    },
    tui: {
      showToast: async (options: {
        body?: { title?: string; message: string; variant: string };
      }) => {
        if (options.body) calls.toasts.push(options.body);
        return { data: {} };
      },
    },
    app: {
      log: async (options: { body?: { level: string; message: string } }) => {
        if (options.body) calls.logs.push(options.body);
        return { data: {} };
      },
    },
  } as unknown as Client;

  return { client, calls };
}

export function makeUserMessage(
  sessionId: string,
  messageId: string,
  providerID: string,
  modelID: string,
  agent = "coder",
  textContent = "hello",
): MockMessageEntry {
  const info: UserMessage = {
    id: messageId,
    sessionID: sessionId,
    role: "user",
    time: { created: Date.now() },
    agent,
    model: { providerID, modelID },
  };
  const parts: Part[] = [
    {
      id: "p1",
      sessionID: sessionId,
      messageID: messageId,
      type: "text",
      text: textContent,
    },
  ];
  return { info, parts };
}
