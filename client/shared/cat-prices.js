export function catPricesForRound(round) {
  if (round.catPrices) return round.catPrices;
  let min = Infinity;
  let max = 0;
  for (const theme of round.themes) {
    for (const question of theme.questions) {
      if (!Number.isSafeInteger(question.price) || question.price <= 0) continue;
      min = Math.min(min, question.price);
      max = Math.max(max, question.price);
    }
  }
  if (!max) return [100, 500];
  if (min !== max) return [min, max];
  return max === Number.MAX_SAFE_INTEGER ? [max - 1, max] : [min, max + 1];
}
