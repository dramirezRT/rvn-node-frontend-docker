# Ravencoin Node Frontend Dashboard

Real-time web dashboard for monitoring a Ravencoin full node. Built with Node.js + Express + Socket.IO.

## Docker Hub

Published images: [https://hub.docker.com/r/dramirezrt/rvn-node-frontend](https://hub.docker.com/r/dramirezrt/rvn-node-frontend)

## How It Works

- **ZMQ-driven updates** — Subscribes to ravend ZMQ events (`hashblock`/`hashtx`) to trigger RPC data refreshes
- **RPC data fetching** — Retrieves node stats via RPC (block height, peers, difficulty, hashrate, chain info, mempool, etc.)
- **Real-time log streaming** — Streams log files in real-time via file watching (`fs.watch` + read stream)
- **GeoIP for peers** — Looks up peer locations using the ip-api.com batch API (cached)
- **Fallback refresh** — Periodic fallback refresh every 60s in case ZMQ events are missed
- **No polling loops** — Fully event-driven architecture
- **No docker exec** — No shell commands or docker exec needed

## Dockerfile

- Base: `node:20-slim`
- Exposes port 3000
- Runs as non-root user `node`

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | HTTP server port |
| `RPC_USER` | `electrumx` | ravend RPC username |
| `RPC_PASS` | _(empty)_ | ravend RPC password |
| `RPC_HOST` | `127.0.0.1` | ravend RPC host |
| `RPC_PORT` | `8766` | ravend RPC port |
| `ZMQ_BLOCK_URL` | `tcp://127.0.0.1:28332` | ZMQ hashblock endpoint |
| `ZMQ_TX_URL` | `tcp://127.0.0.1:28333` | ZMQ hashtx endpoint |
| `RVN_LOG_FILE` | `/kingofthenorth/raven-dir/debug.log` | Path to ravend debug log (mount into container) |
| `ELECTRUMX_LOG_FILE` | _(empty)_ | Path to ElectrumX log file (optional, mount into container) |
| `LOG_TAIL_LINES` | `80` | Lines to send on initial log subscribe |
| `FALLBACK_REFRESH_MS` | `60000` | Fallback RPC refresh interval (ms) |

## API Endpoints

- `GET /api/stats` — Returns full node stats as JSON
- `GET /health` — Health check, returns ZMQ/log config and data availability



- `stats` — Full node stats object
- `node_status` — Legacy format (used by index.html)
- `log` — `{ source: 'raven'|'electrumx', lines: string[] }`
- Subscribe to logs: emit `subscribe-logs` with source name (`core`, `raven`, or `electrumx`)

## Prerequisites

- A running ravend with ZMQ enabled (`ZMQ=true` in rvn-core-server-docker) and RPC accessible
- Log files must be mounted into the container if log streaming is desired

## Typical Docker Run Example

Host networking is required when ravend is on the same host:

```bash
docker run -d \
  -v ~/raven-node/kingofthenorth:/kingofthenorth:ro \
  -e RPC_PASS=your_rpc_password \
  -e ZMQ_BLOCK_URL=tcp://127.0.0.1:28332 \
  -e ZMQ_TX_URL=tcp://127.0.0.1:28333 \
  -e ELECTRUMX_LOG_FILE=/electrum-data/electrumx.log \
  -v /home/raven/electrum-data:/electrum-data:ro \
  --network host \
  --name rvn-node-frontend \
  dramirezrt/rvn-node-frontend:latest
```

## Building from Source

```bash
git clone https://github.com/dramirezRT/rvn-node-frontend-docker.git
cd rvn-node-frontend-docker
docker build -t rvn-node-frontend:local .
```

Run the locally built image:

```bash
docker run -d \
  -v ~/raven-node/kingofthenorth:/kingofthenorth:ro \
  -e RPC_PASS=your_rpc_password \
  -e ZMQ_BLOCK_URL=tcp://127.0.0.1:28332 \
  -e ZMQ_TX_URL=tcp://127.0.0.1:28333 \
  --network host \
  --name rvn-node-frontend \
  rvn-node-frontend:local
```
