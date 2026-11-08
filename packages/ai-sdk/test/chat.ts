import { AbstractChat, simulateReadableStream, type ChatState, type ChatStatus, type UIMessage, type UIMessageChunk } from "ai";

/** The chat state `useChat` keeps, in memory. */
class MemoryState implements ChatState<UIMessage> {
  status: ChatStatus = "ready";
  error: Error | undefined;
  messages: UIMessage[] = [];
  pushMessage = (message: UIMessage) => { this.messages = [...this.messages, message]; };
  popMessage = () => { this.messages = this.messages.slice(0, -1); };
  replaceMessage = (index: number, message: UIMessage) => { this.messages = this.messages.map((old, at) => at === index ? message : old); };
  snapshot = <T>(thing: T): T => structuredClone(thing);
}

/**
 * A real ai 6.0.0 chat whose requests the test answers: `respond` gets the messages the chat sends and returns the UI
 * message stream a server route would. `addToolApprovalResponse` and `messages` are the SDK's own.
 */
export class TestChat extends AbstractChat<UIMessage> {
  constructor(respond: (messages: UIMessage[]) => Promise<UIMessageChunk[]>) {
    let id = 0;
    super({
      state: new MemoryState(),
      generateId: () => `id-${++id}`,
      transport: {
        sendMessages: async ({ messages }) => simulateReadableStream({ chunks: await respond(messages), chunkDelayInMs: null }),
        reconnectToStream: async () => null,
      },
    });
  }
}
