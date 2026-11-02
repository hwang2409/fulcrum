export interface Transport {
  readonly ready?: Promise<void>;
  send(text: string): void;
  onMessage(callback: (text: string) => void): void | (() => void);
  onClose?(callback: (code?: number) => void): void | (() => void);
  close(): void;
}

export function webSocketTransport(url: string): Promise<Transport> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const messages = new Set<(text: string) => void>();
    const closes = new Set<(code?: number) => void>();
    let opened = false;
    socket.addEventListener("open", () => {
      opened = true;
      resolve({
        send: (text) => socket.send(text),
        onMessage: (callback) => { messages.add(callback); return () => messages.delete(callback); },
        onClose: (callback) => { closes.add(callback); return () => closes.delete(callback); },
        close: () => socket.close(),
      });
    });
    socket.addEventListener("error", () => { if (!opened) reject(new Error("websocket error")); });
    socket.addEventListener("close", (event) => {
      if (!opened) reject(new Error("websocket closed before open"));
      else closes.forEach((callback) => callback((event as CloseEvent).code));
    });
    socket.addEventListener("message", (event) => messages.forEach((callback) => callback(String(event.data))));
  });
}
