export interface Transport {
  readonly ready?: Promise<void>;
  send(text: string): void;
  onMessage(callback: (text: string) => void): void;
  onClose(callback: (code?: number) => void): void;
  close(): void;
}

export function webSocketTransport(url: string): Promise<Transport> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    let message: ((text: string) => void) | undefined;
    const buffered: string[] = [];
    let closed: ((code?: number) => void) | undefined;
    let opened = false;

    socket.addEventListener("open", () => {
      opened = true;
      resolve({
        send: (text) => socket.send(text),
        onMessage: (callback) => {
          message = callback;
          for (const text of buffered.splice(0)) callback(text);
        },
        onClose: (callback) => {
          closed = callback;
        },
        close: () => socket.close(),
      });
    });
    socket.addEventListener("error", () => {
      if (!opened) reject(new Error("websocket error"));
    });
    socket.addEventListener("close", (event) => {
      if (!opened) reject(new Error("websocket closed before open"));
      else closed?.((event as CloseEvent).code);
    });
    socket.addEventListener("message", (event) => {
      const text = String(event.data);
      if (message) message(text);
      else buffered.push(text);
    });
  });
}
