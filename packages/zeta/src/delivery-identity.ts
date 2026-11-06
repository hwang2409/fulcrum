type TrackedDelivery = {
  sessionId?: string;
  method: string;
  text?: unknown;
  deliveryId?: string;
  intent?: string;
};

type DeliveryEcho = {
  sessionId?: string;
  text: string;
  deliveryId?: string;
  hasAttachments: boolean;
  canMatchDeliveryId: boolean;
};

export function createDeliveryIdentity(cap: number, ttlMs = 5 * 60 * 1000) {
  const pending = new Map<number, TrackedDelivery>();
  const retained = new Map<string, { sessionId?: string; text?: unknown; expiresAt: number }>();
  let closed = false;

  const track = (id: number, delivery: TrackedDelivery) => pending.set(id, delivery);
  const settle = (id: number) => {
    const delivery = pending.get(id);
    pending.delete(id);
    if (closed || delivery?.method !== "send_images" || delivery.deliveryId === undefined) return;
    retained.set(delivery.deliveryId, {
      sessionId: delivery.sessionId,
      text: delivery.text,
      expiresAt: Date.now() + ttlMs,
    });
    while (retained.size > cap) retained.delete(retained.keys().next().value!);
  };
  const match = (echo: DeliveryEcho) => {
    const owner = echo.canMatchDeliveryId && echo.deliveryId !== undefined
      ? [...pending.values()].find((delivery) => delivery.deliveryId === echo.deliveryId)
      : [...pending.values()].find((delivery) => delivery.intent !== undefined && delivery.text === echo.text && (echo.hasAttachments ? delivery.method === "send_images" : delivery.method !== "send_images"));
    if (owner) {
      owner.sessionId ??= echo.sessionId;
      const intent = owner.intent;
      owner.intent = undefined;
      return intent === undefined ? undefined : { intent };
    }
    if (!echo.hasAttachments) return;
    const now = Date.now();
    for (const [deliveryId, delivery] of retained) {
      if (delivery.expiresAt <= now) retained.delete(deliveryId);
      else if (delivery.sessionId === echo.sessionId && delivery.text === echo.text) return { deliveryId };
    }
  };
  const evictSession = (sessionId: string) => {
    for (const [deliveryId, delivery] of retained) if (delivery.sessionId === sessionId) retained.delete(deliveryId);
    for (const [id, delivery] of pending) if (delivery.sessionId === sessionId) pending.delete(id);
  };
  const close = () => {
    closed = true;
    pending.clear();
    retained.clear();
  };

  return { track, settle, match, evictSession, close };
}
