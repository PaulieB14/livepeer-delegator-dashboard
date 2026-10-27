/* global process */
// Vercel serverless proxy for The Graph gateway. Keeps GRAPH_API_KEY server-side.
const SUBGRAPHS = {
  livepeer: () => process.env.LIVEPEER_SUBGRAPH_ID || "FE63YgkzcpVocxdCEyEYbvjYqEf2kb1A6daMYRxmejYC",
  ens: () => process.env.ENS_SUBGRAPH_ID || "5XqPmWe6gjyrJtFn9cLy237i4cWw2j9HcUJEXsP5qGtH",
};

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ errors: [{ message: "POST only" }] });
  const pick = SUBGRAPHS[req.query.sg];
  if (!pick) return res.status(400).json({ errors: [{ message: "unknown subgraph" }] });
  const key = process.env.GRAPH_API_KEY;
  if (!key) return res.status(500).json({ errors: [{ message: "GRAPH_API_KEY not configured" }] });
  const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
  if (!body?.query || typeof body.query !== "string" || body.query.length > 10000)
    return res.status(400).json({ errors: [{ message: "bad query" }] });
  const r = await fetch(`https://gateway.thegraph.com/api/subgraphs/id/${pick()}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({ query: body.query, variables: body.variables }),
  });
  res.setHeader("Cache-Control", "s-maxage=30, stale-while-revalidate=60");
  res.status(r.status).send(await r.text());
}
