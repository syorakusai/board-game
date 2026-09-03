import { createSign } from "node:crypto";
import { pathToFileURL } from "node:url";

export const ROOM_SCOPED_ROOTS = [
  "roomPresence",
  "roomHistories",
  "roomSecrets",
  "roomProgress",
  "roomAnswers",
  "roomReactions",
  "roomCardReservations",
  "roomPreparations",
  "roomPreparationProgress"
];

const DAY_MS = 24 * 60 * 60 * 1000;

function base64Url(value) {
  return Buffer.from(value).toString("base64url");
}

function parsePositiveInteger(value, label) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${label} must be a positive integer.`);
  }
  return parsed;
}

export function staleRoomIds(rooms, cutoffMs) {
  return Object.entries(rooms || {})
    .filter(([, room]) => Number.isFinite(Number(room?.createdAt)) && Number(room.createdAt) < cutoffMs)
    .map(([roomId]) => roomId)
    .sort();
}

export function staleFirebaseTestUids(entries, cutoffMs) {
  return Object.entries(entries || {})
    .filter(([, entry]) => {
      const connectedAt = Date.parse(entry?.connectedAt || "");
      return Number.isFinite(connectedAt) && connectedAt < cutoffMs;
    })
    .map(([uid]) => uid)
    .sort();
}

async function accessToken(serviceAccount) {
  if (!serviceAccount?.client_email || !serviceAccount?.private_key) {
    throw new Error("FIREBASE_SERVICE_ACCOUNT must contain client_email and private_key.");
  }

  const now = Math.floor(Date.now() / 1000);
  const header = base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claim = base64Url(JSON.stringify({
    iss: serviceAccount.client_email,
    scope: "https://www.googleapis.com/auth/firebase.database https://www.googleapis.com/auth/userinfo.email",
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600
  }));
  const unsigned = `${header}.${claim}`;
  const signer = createSign("RSA-SHA256");
  signer.update(unsigned);
  signer.end();
  const assertion = `${unsigned}.${signer.sign(serviceAccount.private_key).toString("base64url")}`;

  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth2:grant-type:jwt-bearer",
      assertion
    })
  });
  if (!response.ok) {
    throw new Error(`Google access token request failed: ${response.status} ${await response.text()}`);
  }
  const result = await response.json();
  if (!result.access_token) throw new Error("Google access token was not returned.");
  return result.access_token;
}

function databaseEndpoint(databaseUrl, path, token) {
  const base = databaseUrl.replace(/\/$/, "");
  return `${base}/${path}.json?access_token=${encodeURIComponent(token)}`;
}

async function readJson(databaseUrl, path, token) {
  const response = await fetch(databaseEndpoint(databaseUrl, path, token));
  if (!response.ok) {
    throw new Error(`Firebase read failed for ${path}: ${response.status} ${await response.text()}`);
  }
  return response.json();
}

async function deletePath(databaseUrl, path, token) {
  const response = await fetch(databaseEndpoint(databaseUrl, path, token), { method: "DELETE" });
  if (!response.ok) {
    throw new Error(`Firebase delete failed for ${path}: ${response.status} ${await response.text()}`);
  }
}

export async function cleanup({ databaseUrl, serviceAccount, retentionDays = 7, nowMs = Date.now() }) {
  const days = parsePositiveInteger(retentionDays, "retentionDays");
  const cutoffMs = nowMs - days * DAY_MS;
  const token = await accessToken(serviceAccount);
  const [rooms, firebaseTests] = await Promise.all([
    readJson(databaseUrl, "rooms", token),
    readJson(databaseUrl, "firebase-test", token)
  ]);
  const roomIds = staleRoomIds(rooms, cutoffMs);
  const testUids = staleFirebaseTestUids(firebaseTests, cutoffMs);

  for (const roomId of roomIds) {
    for (const root of ROOM_SCOPED_ROOTS) {
      await deletePath(databaseUrl, `${root}/${roomId}`, token);
    }
    await deletePath(databaseUrl, `rooms/${roomId}`, token);
    console.log(`Deleted stale room: ${roomId}`);
  }

  for (const uid of testUids) {
    await deletePath(databaseUrl, `firebase-test/${uid}`, token);
  }

  console.log(JSON.stringify({
    databaseUrl,
    retentionDays: days,
    cutoff: new Date(cutoffMs).toISOString(),
    deletedRooms: roomIds.length,
    deletedFirebaseTests: testUids.length
  }));
}

async function main() {
  const databaseUrl = process.env.FIREBASE_DATABASE_URL;
  const serviceAccountJson = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!databaseUrl) throw new Error("FIREBASE_DATABASE_URL is not set.");
  if (!serviceAccountJson) throw new Error("FIREBASE_SERVICE_ACCOUNT repository secret is not set.");

  let serviceAccount;
  try {
    serviceAccount = JSON.parse(serviceAccountJson);
  } catch {
    throw new Error("FIREBASE_SERVICE_ACCOUNT is not valid JSON.");
  }

  await cleanup({
    databaseUrl,
    serviceAccount,
    retentionDays: process.env.RETENTION_DAYS || "7"
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
