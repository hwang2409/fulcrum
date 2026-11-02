export interface Transport {
  readonly ready?: Promise<void>;
  send(text: string): void;
  onMessage(callback: (text: string) => void): void;
  onClose(callback: () => void): void;
  close(): void;
}

export function webSocketTransport(url: string): Promise<Transport> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    let message: ((text: string) => void) | undefined;
    let closed: (() => void) | undefined;
    let opened = false;

    socket.addEventListener("open", () => {
      opened = true;
      resolve({
        send: (text) => socket.send(text),
        onMessage: (callback) => {
          message = callback;
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
    socket.addEventListener("close", () => {
      if (!opened) reject(new Error("websocket closed before open"));
      else closed?.();
    });
    socket.addEventListener("message", (event) => message?.(String(event.data)));
  });
}
