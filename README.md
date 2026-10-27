# Livepeer Delegator Dashboard

Track LPT delegation earnings, claims history, unbonding and orchestrator stats. Data from the Livepeer subgraph on The Graph Network plus live `pendingStake`/`pendingFees` eth_calls to the BondingManager on Arbitrum.

## Deploy (Vercel)
1. Import the repo in Vercel (framework: Vite).
2. Add env var `GRAPH_API_KEY` (server-side only, never `VITE_`-prefixed).
3. Deploy. The browser calls `/api/graph?sg=livepeer|ens`; `api/graph.js` adds the key.

Local: `npm i -g vercel && vercel dev` with `GRAPH_API_KEY` in `.env.local` (see `.env.example`).
