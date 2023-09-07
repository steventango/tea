export function weightedRandom(weights: Array<number>) {
  const r = Math.random();
  let sum = 0;
  for (const [i, p] of weights.entries()) {
    sum += p;
    if (r < sum) {
      return i;
    }
  }
  return 0;
}

export function sample<T>(array: Array<T>, lo=0, high=array.length) {
  const index = Math.floor(Math.random() * (high - lo)) + lo;
  const item = array[index];
  array.splice(index, 1);
  return item;
}
