import { firebaseConfig } from "./firebase-config.js";
import { getApp, getApps, initializeApp } from "https://www.gstatic.com/firebasejs/11.10.0/firebase-app.js";
import { getAuth, onAuthStateChanged, signInAnonymously } from "https://www.gstatic.com/firebasejs/11.10.0/firebase-auth.js";
import { get, getDatabase, ref, set } from "https://www.gstatic.com/firebasejs/11.10.0/firebase-database.js";

const FIREBASE_TEST_ROOT = "firebase-test";
const FIREBASE_STATUS_ID = "firebase-connection-status";

function showStatus(message, state = "pending") {
  const status = document.getElementById(FIREBASE_STATUS_ID);
  if (!status) return;
  status.dataset.state = state;
  status.textContent = message;
}

function addStatusIndicator() {
  if (document.getElementById(FIREBASE_STATUS_ID)) return;
  const style = document.createElement("style");
  style.textContent = `
    #${FIREBASE_STATUS_ID}{position:fixed;z-index:2001;left:8px;bottom:8px;max-width:calc(100vw - 16px);padding:5px 8px;border:1px solid #9a7b45;border-radius:999px;background:#1f312b;color:#f7e9c7;font:600 11px/1.2 system-ui,sans-serif;box-shadow:0 2px 8px #0006}
    #${FIREBASE_STATUS_ID}[data-state="success"]{border-color:#75b98d}
    #${FIREBASE_STATUS_ID}[data-state="error"]{border-color:#db8781;color:#ffd6d3}
  `;
  document.head.append(style);
  const status = document.createElement("div");
  status.id = FIREBASE_STATUS_ID;
  status.setAttribute("role", "status");
  status.dataset.state = "pending";
  document.body.append(status);
}

function waitForRestoredUser(auth) {
  return new Promise((resolve, reject) => {
    const unsubscribe = onAuthStateChanged(auth, user => {
      unsubscribe();
      resolve(user);
    }, reject);
  });
}

export async function getFirebaseContext() {
  const app = getApps().length ? getApp() : initializeApp(firebaseConfig);
  const auth = getAuth(app);
  const restoredUser = await waitForRestoredUser(auth);
  const user = restoredUser || (await signInAnonymously(auth)).user;
  if (!user?.uid) throw Error("匿名認証後のUIDを取得できませんでした。");
  return { app, auth, database: getDatabase(app), user, restored: Boolean(restoredUser) };
}

async function verifyFirebaseConnection() {
  const { database, user, restored } = await getFirebaseContext();

  const connectedAt = new Date().toISOString();
  const verificationId = crypto.randomUUID();
  const testPath = `${FIREBASE_TEST_ROOT}/${user.uid}`;
  const expected = { status: "connected", connectedAt, verificationId };

  await set(ref(database, testPath), expected);
  const snapshot = await get(ref(database, testPath));
  const actual = snapshot.val();

  if (!actual || actual.status !== expected.status || actual.connectedAt !== expected.connectedAt || actual.verificationId !== expected.verificationId) {
    throw Error("Realtime Databaseの読み込み内容が書き込み内容と一致しませんでした。");
  }

  return { uid: user.uid, restored, testPath };
}

async function startFirebaseConnectionCheck() {
  addStatusIndicator();
  showStatus("Firebase: 接続確認中…");
  try {
    const result = await verifyFirebaseConnection();
    const sessionLabel = result.restored ? "認証状態を復元" : "匿名認証";
    showStatus(`Firebase: 接続成功（${sessionLabel} / UID: ${result.uid.slice(0, 8)}…）`, "success");
    console.info("[Firebase接続確認]", result);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    showStatus(`Firebase: 接続失敗（${message}）`, "error");
    console.error("[Firebase接続確認]", error);
  }
}

startFirebaseConnectionCheck();
