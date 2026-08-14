import { EventLedger } from "../../src/event-ledger.js";

const [home, taskId, sessionId, countText] = process.argv.slice(2);
const count = Number(countText);
if (home === undefined || taskId === undefined || sessionId === undefined || !Number.isInteger(count) || count < 1) {
  throw new Error("usage: ledger-writer <home> <taskId> <sessionId> <positive-count>");
}

const ledger = new EventLedger(home);
await Promise.all(
  Array.from({ length: count }, (_, seq) =>
    ledger.append(taskId, {
      sourceSessionId: sessionId,
      sourceSeq: seq,
      origin: "root",
      type: "session/event",
      raw: {
        type: "session/event",
        sessionId,
        event: {
          type: "user/message",
          seq,
          time: seq,
          data: { content: [{ type: "text", text: `SECRET ${sessionId} ${seq}` }] },
        },
      },
    }),
  ),
);
