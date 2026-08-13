import assert from "node:assert/strict";
import { evaluateRound, nextParentIndex, orderedChildren, scoreRound } from "../game-rules.js";

const players = [
  { id: "a", name: "A", score: 2 },
  { id: "b", name: "B", score: 2 },
  { id: "c", name: "C", score: 2 }
];
const base = { players, order: [2, 0, 1], parentIndex: 1, parentCandidateId: "parent" };

assert.deepEqual(orderedChildren(players, base.order, base.parentIndex).map(player => player.id), ["b", "c"]);
assert.deepEqual(orderedChildren(players, base.order, 2).map(player => player.id), ["c", "a"]);
assert.deepEqual(nextParentIndex(base.order, 2), 0);

let scored = scoreRound({ ...base, answers: { b: "official-0", c: "official-1" } });
assert.equal(scored.resultKind, "none-correct");
assert.deepEqual(scored.players.map(player => player.score), [3, 2, 2]);

scored = scoreRound({ ...base, answers: { b: "parent", c: "parent" } });
assert.equal(scored.resultKind, "all-correct");
assert.deepEqual(scored.players.map(player => player.score), [1, 3, 3]);

scored = scoreRound({ ...base, answers: { b: "parent", c: "official-2" } });
assert.equal(scored.resultKind, "some-correct");
assert.deepEqual(scored.players.map(player => player.score), [2, 3, 2]);

const twoPlayers = players.slice(0, 2).map(player => ({ ...player, score: 0 }));
assert.deepEqual(scoreRound({ players: twoPlayers, order: [0, 1], parentIndex: 0, parentCandidateId: "parent", answers: { b: "official-0" } }).players.map(player => player.score), [0, 0]);
assert.deepEqual(scoreRound({ players: twoPlayers, order: [0, 1], parentIndex: 0, parentCandidateId: "parent", answers: { b: "parent" } }).players.map(player => player.score), [0, 1]);
assert.equal(evaluateRound({ ...base, answers: { b: "parent", c: "official-0" } }).correct[0].id, "b");

console.log("ゲームルール検査: OK");
