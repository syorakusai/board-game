#!/usr/bin/env node
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";

const rootDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cardsDirectory = path.join(rootDirectory, "cards");
const sourceJsonPath = path.join(rootDirectory, "source", "yokai.json");
const summary = { targetCardSets: [], targetCardCount: 0, updated: 0, unchanged: 0, errors: [] };

function addError(target, reason) {
  summary.errors.push({ target, reason });
}

function parseYokaiNumber(value) {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return value;
  if (typeof value === "string" && /^\d+$/.test(value)) {
    const parsed = Number(value);
    if (Number.isSafeInteger(parsed)) return parsed;
  }
  return null;
}

function hasRequiredText(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function printSummary() {
  console.log("妖怪物語同期結果");
  console.log("対象カードセット: " + (summary.targetCardSets.join(", ") || "なし"));
  console.log("対象カード数: " + summary.targetCardCount);
  console.log("更新件数: " + summary.updated);
  console.log("変更なし件数: " + summary.unchanged);
  console.log("エラー件数: " + summary.errors.length);
  for (const error of summary.errors) console.error("- " + error.target + ": " + error.reason);
}

async function discoverCardSets() {
  const entries = await fs.readdir(cardsDirectory, { withFileTypes: true });
  return entries
    .filter(entry => entry.isDirectory() && /^yokai\d+$/i.test(entry.name))
    .map(entry => entry.name)
    .sort((left, right) => left.localeCompare(right, "en", { numeric: true }));
}

async function loadLoreByNumber() {
  let source;
  try {
    source = await fs.readFile(sourceJsonPath, "utf8");
  } catch (error) {
    addError(sourceJsonPath, "source/yokai.jsonを読み込めません: " + error.message);
    return new Map();
  }

  let entries;
  try {
    entries = JSON.parse(source);
  } catch (error) {
    addError(sourceJsonPath, "source/yokai.jsonを解析できません: " + error.message);
    return new Map();
  }

  if (!Array.isArray(entries)) {
    addError(sourceJsonPath, "妖怪情報の配列ではありません");
    return new Map();
  }

  const loreByNumber = new Map();
  entries.forEach((entry, index) => {
    const label = "source/yokai.json[" + index + "]";
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      addError(label, "妖怪情報のオブジェクトではありません");
      return;
    }

    const number = parseYokaiNumber(entry.number);
    if (number === null) {
      addError(label, "妖怪固有番号として扱えません: " + String(entry.number));
      return;
    }
    if (loreByNumber.has(number)) {
      addError(label, "妖怪固有番号 " + number + " が重複しています");
      return;
    }
    if (!hasRequiredText(entry.name) || !hasRequiredText(entry.appearance) || !hasRequiredText(entry.traits)) {
      addError(label, "name・appearance・traitsの必要データが空です");
      return;
    }

    loreByNumber.set(number, {
      number,
      name: entry.name,
      appearance: entry.appearance,
      traits: entry.traits
    });
  });

  return loreByNumber;
}

function parseImageNumber(image, label) {
  if (typeof image !== "string") {
    addError(label, "カード画像名がありません");
    return null;
  }

  if (!image.endsWith(".webp")) {
    addError(label, "カード画像名の拡張子が.webpではありません: " + image);
    return null;
  }

  const parts = image.slice(0, -".webp".length).split("_");
  if (parts.length < 3 || parts[1] === "") {
    addError(label, "カード画像名から妖怪固有番号を取得できません: " + image);
    return null;
  }

  const number = parseYokaiNumber(parts[1]);
  if (number === null) {
    addError(label, "カード画像名の第2要素が妖怪固有番号として不正です: " + image);
    return null;
  }

  return number;
}

async function readCardSet(cardSetId, loreByNumber) {
  const filePath = path.join(cardsDirectory, cardSetId, "cards.json");
  let source;
  try {
    source = await fs.readFile(filePath, "utf8");
  } catch (error) {
    addError(filePath, "JSONを読み込めません: " + error.message);
    return null;
  }

  let document;
  try {
    document = JSON.parse(source);
  } catch (error) {
    addError(filePath, "JSONを解析できません: " + error.message);
    return null;
  }

  if (!Array.isArray(document.cards)) {
    addError(filePath, "cards配列がありません");
    return null;
  }

  const usedNumbers = new Map();
  const nextCards = [];
  let changed = false;

  for (const card of document.cards) {
    const label = cardSetId + "/cards.json cardId=" + String(card?.id);
    const number = parseImageNumber(card?.image, label);
    if (number === null) {
      nextCards.push(card);
      continue;
    }

    const previous = usedNumbers.get(number);
    if (previous) {
      addError(label, "妖怪固有番号 " + number + " を " + previous + " と重複使用しています");
      nextCards.push(card);
      continue;
    }
    usedNumbers.set(number, label);

    const lore = loreByNumber.get(number);
    if (!lore) {
      addError(label, "妖怪固有番号 " + number + " に対応するsource/yokai.jsonの情報がありません");
      nextCards.push(card);
      continue;
    }

    const nextCard = { ...card, lore };
    if (JSON.stringify(card.lore) === JSON.stringify(lore)) {
      summary.unchanged += 1;
    } else {
      summary.updated += 1;
      changed = true;
    }
    nextCards.push(nextCard);
  }

  summary.targetCardCount += document.cards.length;
  return {
    filePath,
    source,
    content: JSON.stringify({ ...document, cards: nextCards }, null, 2) + "\n",
    changed
  };
}

async function main() {
  const argumentsAfterScript = process.argv.slice(2);
  if (argumentsAfterScript.length > 1) {
    addError("引数", "指定できるカードセットは1つだけです");
    printSummary();
    process.exitCode = 1;
    return;
  }

  let detectedCardSets;
  try {
    detectedCardSets = await discoverCardSets();
  } catch (error) {
    addError(cardsDirectory, "妖怪カードセットを検出できません: " + error.message);
    printSummary();
    process.exitCode = 1;
    return;
  }

  const requestedCardSet = argumentsAfterScript[0];
  const targetCardSets = requestedCardSet ? [requestedCardSet] : detectedCardSets;
  if (requestedCardSet && !detectedCardSets.includes(requestedCardSet)) {
    addError(requestedCardSet, "妖怪カードセットとして存在しません");
  }
  if (!targetCardSets.length) {
    addError(cardsDirectory, "妖怪カードセットが見つかりません");
  }

  summary.targetCardSets = targetCardSets;
  const loreByNumber = await loadLoreByNumber();
  const updates = [];
  for (const cardSetId of targetCardSets) {
    if (!detectedCardSets.includes(cardSetId)) continue;
    const update = await readCardSet(cardSetId, loreByNumber);
    if (update) updates.push(update);
  }

  if (summary.errors.length) {
    printSummary();
    process.exitCode = 1;
    return;
  }

  const written = [];
  try {
    for (const update of updates.filter(update => update.changed)) {
      await fs.writeFile(update.filePath, update.content, "utf8");
      written.push(update);
    }
  } catch (error) {
    for (const update of written.reverse()) {
      await fs.writeFile(update.filePath, update.source, "utf8").catch(() => {});
    }
    addError("書き込み", "cards.jsonを更新できません: " + error.message);
    printSummary();
    process.exitCode = 1;
    return;
  }

  printSummary();
}

main().catch(error => {
  addError("同期処理", error.message || String(error));
  printSummary();
  process.exitCode = 1;
});
