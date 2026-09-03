import assert from "node:assert/strict";
import { staleFirebaseTestUids, staleRoomIds } from "../scripts/cleanup-firebase.mjs";

const cutoff = Date.parse("2026-09-01T00:00:00.000Z");

assert.deepEqual(staleRoomIds({
  OLD: { createdAt: cutoff - 1 },
  EDGE: { createdAt: cutoff },
  NEW: { createdAt: cutoff + 1 },
  UNKNOWN: {}
}, cutoff), ["OLD"]);

assert.deepEqual(staleFirebaseTestUids({
  old: { connectedAt: "2026-08-31T23:59:59.999Z" },
  edge: { connectedAt: "2026-09-01T00:00:00.000Z" },
  recent: { connectedAt: "2026-09-02T00:00:00.000Z" },
  invalid: { connectedAt: "not-a-date" }
}, cutoff), ["old"]);

console.log("Firebase cleanup selection: OK");
