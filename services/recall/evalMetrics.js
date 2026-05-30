// services/recall/evalMetrics.js
function precisionAtN(rankedKeys, expectedSet, n) {
  const top = rankedKeys.slice(0, n);
  if (top.length === 0) return 0;
  const hits = top.filter((k) => expectedSet.has(k)).length;
  return hits / top.length;
}

function ndcgAtN(rankedKeys, expectedSet, n) {
  const top = rankedKeys.slice(0, n);
  let dcg = 0;
  for (let i = 0; i < top.length; i++) {
    if (expectedSet.has(top[i])) dcg += 1 / Math.log2(i + 2);
  }
  let idcg = 0;
  const ideal = Math.min(expectedSet.size, n);
  for (let i = 0; i < ideal; i++) idcg += 1 / Math.log2(i + 2);
  return idcg === 0 ? 0 : dcg / idcg;
}

module.exports = { precisionAtN, ndcgAtN };
