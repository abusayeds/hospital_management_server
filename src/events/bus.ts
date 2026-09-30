import { logger } from "../utils/logger";
import { DomainEvent, DomainEventMap, DomainEventName } from "./catalog";
import { DomainEventModel } from "./domainEvent.model";

/**
 * IN-PROCESS DOMAIN EVENT BUS
 *
 *   publish("visit.closed", { visitId, ... })          ← services, AFTER the DB change committed
 *   subscribe("visit.closed", "ai-summary-cache", fn) ← consumers, at startup
 *
 * Guarantees:
 *  - publish() NEVER throws and never slows the request: the event is stored, then
 *    handlers run on the next tick.
 *  - A failing handler is logged and marked "failed" on the stored event; other handlers
 *    and the original request are unaffected.
 *  - Every event is persisted (DomainEvent) with a status per consumer.
 */

type Handler<N extends DomainEventName> = (event: DomainEvent<N>) => Promise<void> | void;
type Subscription = { consumer: string; handler: Handler<never> };

const subscriptions = new Map<DomainEventName, Subscription[]>();
const inFlight = new Set<Promise<void>>();

export const subscribe = <N extends DomainEventName>(name: N, consumer: string, handler: Handler<N>) => {
  const list = subscriptions.get(name) ?? [];
  if (list.some((s) => s.consumer === consumer)) return; // idempotent (hot reload, tests)
  list.push({ consumer, handler: handler as Handler<never> });
  subscriptions.set(name, list);
};

const markConsumer = async (eventId: string, consumer: string, status: "done" | "failed", error?: string) => {
  try {
    await DomainEventModel.updateOne(
      { _id: eventId, "consumers.name": consumer },
      {
        $set: {
          "consumers.$.status": status,
          "consumers.$.processedAt": new Date(),
          "consumers.$.error": error?.slice(0, 500) ?? null,
        },
      },
    );
  } catch (err) {
    logger.error({ err, eventId, consumer }, "Could not update domain event consumer status");
  }
};

const dispatch = async (event: DomainEvent) => {
  for (const { consumer, handler } of subscriptions.get(event.name) ?? []) {
    try {
      await handler(event as never);
      await markConsumer(event.id, consumer, "done");
    } catch (err) {
      logger.error({ err, event: event.name, eventId: event.id, consumer }, "Domain event handler failed");
      await markConsumer(event.id, consumer, "failed", (err as Error)?.message);
    }
  }
};

const persistAndDispatch = async <N extends DomainEventName>(name: N, payload: DomainEventMap[N]) => {
  const occurredAt = new Date();
  let id = "";
  try {
    const consumers = (subscriptions.get(name) ?? []).map((s) => ({ name: s.consumer, status: "pending" as const }));
    const doc = await DomainEventModel.create({ name, payload, occurredAt, consumers });
    id = String(doc._id);
  } catch (err) {
    // Storing failed (e.g. DB hiccup): still run in-process handlers, and say so loudly
    logger.error({ err, event: name }, "Could not persist domain event");
  }
  // Next tick: the request that published never waits for the handlers
  await new Promise<void>((resolve) => setImmediate(resolve));
  await dispatch({ id, name, payload, occurredAt } as DomainEvent);
};

export const publish = <N extends DomainEventName>(name: N, payload: DomainEventMap[N]): Promise<void> => {
  // Tracked from the very start (storing included), so drainEvents() and shutdown never lose one
  const run = persistAndDispatch(name, payload).catch((err) =>
    logger.error({ err, event: name }, "Domain event dispatch failed"),
  );
  inFlight.add(run);
  void run.finally(() => inFlight.delete(run));
  return Promise.resolve();
};

/** Wait until every handler started so far has finished (tests, graceful shutdown) */
export const drainEvents = async () => {
  while (inFlight.size) await Promise.all([...inFlight]);
};

/** For tests only */
export const resetSubscriptions = () => subscriptions.clear();
