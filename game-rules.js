export function orderedChildren(players, order, parentIndex) {
  const childIndexes = [...order.slice(parentIndex + 1), ...order.slice(0, parentIndex)];
  return childIndexes.map(index => players[index]);
}

export function evaluateRound({ players, order, parentIndex, answers, parentCandidateId }) {
  const parent = players[order[parentIndex]];
  const children = orderedChildren(players, order, parentIndex);
  const correct = children.filter(player => answers[player.id] === parentCandidateId);
  const isTwoPlayer = children.length === 1;
  const resultKind = correct.length === 0 ? "none-correct" : correct.length === children.length ? "all-correct" : "some-correct";
  return { parent, children, correct, isTwoPlayer, resultKind };
}

export function scoreRound(round) {
  const outcome = evaluateRound(round);
  const scores = round.players.map(player => player.score);
  const parentIndex = round.players.indexOf(outcome.parent);

  if (outcome.resultKind === "none-correct") {
    if (!outcome.isTwoPlayer) scores[parentIndex] += 1;
  } else if (outcome.resultKind === "all-correct") {
    if (!outcome.isTwoPlayer) scores[parentIndex] = Math.max(0, scores[parentIndex] - 1);
    outcome.children.forEach(child => { scores[round.players.indexOf(child)] += 1; });
  } else {
    outcome.correct.forEach(child => { scores[round.players.indexOf(child)] += 1; });
  }

  return { ...outcome, players: round.players.map((player, index) => ({ ...player, score: scores[index] })) };
}

export function nextParentIndex(order, parentIndex) {
  return (parentIndex + 1) % order.length;
}
