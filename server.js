/**
 * Ravencoin Node Dashboard — Backend
 *
 * Architecture:
 *   ZMQ (hashblock/hashtx) → triggers RPC fetch → singleton NodeDataManager → broadcasts to all Socket.IO clients
 *   File-based log tailing (fs.watch + read stream) for RVN Core and ElectrumX logs
 *   Periodic fallback refresh every 60s in case ZMQ events are missed
 *
 * No polling loops. No docker exec. No shell commands.
 */

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const zmq = require('zeromq');
const fs = require('fs');
const path = require('path');

// ─── Config ──────────────────────────────────────────────────────────────────

const PORT = parseInt(process.env.PORT || '3000', 10);

// RPC
const RPC_USER = process.env.RPC_USER || 'electrumx';
const RPC_PASS = process.env.RPC_PASS || '';
const RPC_HOST = process.env.RPC_HOST || '127.0.0.1';
const RPC_PORT = parseInt(process.env.RPC_PORT || '8766', 10);

// ZMQ endpoints (ravend publishes here)
const ZMQ_BLOCK_URL = process.env.ZMQ_BLOCK_URL || 'tcp://127.0.0.1:28332';
const ZMQ_TX_URL = process.env.ZMQ_TX_URL || 'tcp://127.0.0.1:28333';

// Log files (host paths, mounted into container or accessed via host network)
const RVN_LOG_FILE = process.env.RVN_LOG_FILE || '/kingofthenorth/raven-dir/debug.log';
const ELECTRUMX_LOG_FILE = process.env.ELECTRUMX_LOG_FILE || '';

// How many lines to send on initial log subscribe
const LOG_TAIL_LINES = parseInt(process.env.LOG_TAIL_LINES || '80', 10);

// Fallback refresh interval (ms) — safety net if ZMQ misses events
const FALLBACK_REFRESH_MS = parseInt(process.env.FALLBACK_REFRESH_MS || '60000', 10);

// ─── RPC Helper ──────────────────────────────────────────────────────────────

let rpcId = 0;

function rpcCall(method, params = []) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({
      jsonrpc: '1.0',
      id: String(++rpcId),
      method,
      params,
    });

    const options = {
      hostname: RPC_HOST,
      port: RPC_PORT,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        Authorization:
          'Basic ' + Buffer.from(`${RPC_USER}:${RPC_PASS}`).toString('base64'),
      },
      timeout: 10000,
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.error) return reject(new Error(parsed.error.message));
          resolve(parsed.result);
        } catch (e) {
          reject(new Error(`RPC parse error: ${data.slice(0, 200)}`));
        }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('RPC timeout'));
    });
    req.write(payload);
    req.end();
  });
}

// ─── Data Fetcher ────────────────────────────────────────────────────────────

async function getNodeStats() {
  try {
    const [blockcount, bestblockhash, networkinfo, peerinfo, mininginfo, chaininfo, nettotals] =
      await Promise.all([
        rpcCall('getblockcount'),
        rpcCall('getbestblockhash'),
        rpcCall('getnetworkinfo'),
        rpcCall('getpeerinfo'),
        rpcCall('getmininginfo'),
        rpcCall('getblockchaininfo'),
        rpcCall('getnettotals').catch(() => null),
      ]);

    const bestblock = await rpcCall('getblock', [bestblockhash]);

    const now = Math.floor(Date.now() / 1000);
    const timeDiff = now - bestblock.time;

    // Sum of peer ban scores (lower = better)
    const totalBanScore = peerinfo.reduce((sum, p) => sum + (p.banscore || 0), 0);

    // Node IP from localaddresses or first peer's addrlocal
    let nodeIP = null;
    if (networkinfo.localaddresses && networkinfo.localaddresses.length > 0) {
      const la = networkinfo.localaddresses[0];
      nodeIP = `${la.address}:${la.port}`;
    } else {
      const withLocal = peerinfo.find((p) => p.addrlocal);
      if (withLocal) nodeIP = withLocal.addrlocal;
    }

    return {
      blockCount: blockcount,
      bestBlockHash: bestblockhash,
      blockTime: bestblock.time,
      blockTimeDiff: timeDiff,
      blockSize: bestblock.size,
      blockTxCount: bestblock.nTx || (bestblock.tx ? bestblock.tx.length : 0),
      blockConfirmations: bestblock.confirmations,
      difficulty: mininginfo.difficulty,
      networkHashrate: mininginfo.networkhashps,
      connections: networkinfo.connections,
      connectionsIn: networkinfo.connections_in || 0,
      connectionsOut: networkinfo.connections_out || 0,
      version: networkinfo.subversion,
      protocolVersion: networkinfo.protocolversion,
      nodeIP,
      nodeScore: totalBanScore,
      chain: chaininfo.chain,
      chainSize: chaininfo.size_on_disk,
      headers: chaininfo.headers,
      verificationProgress: chaininfo.verificationprogress,
      peerCount: peerinfo.length,
      peers: peerinfo.slice(0, 20).map((p) => ({
        addr: p.addr,
        subver: p.subver,
        pingtime: p.pingtime,
        synced_blocks: p.synced_blocks,
        inbound: p.inbound,
      })),
      netTotals: nettotals
        ? { received: nettotals.totalbytesrecv, sent: nettotals.totalbytessent }
        : null,
      timestamp: now,
    };
  } catch (err) {
    console.error('[RPC] Error fetching stats:', err.message);
    return { error: err.message, timestamp: Math.floor(Date.now() / 1000) };
  }
}

// ─── Singleton Data Manager ──────────────────────────────────────────────────

class NodeDataManager {
  constructor() {
    this.stats = null;
    this.refreshing = false;
    this.listeners = new Set();
  }

  /** Refresh stats from RPC and broadcast to all listeners */
  async refresh() {
    if (this.refreshing) return; // coalesce concurrent triggers
    this.refreshing = true;
    try {
      this.stats = await getNodeStats();
      // Derive legacy format for index.html compatibility
      this.legacyStats = this.stats.error ? this.stats : this._toLegacy(this.stats);
      this.broadcast();
    } finally {
      this.refreshing = false;
    }
  }

  /** Convert rich stats to legacy node_status format (used by index.html) */
  _toLegacy(s) {
    const timeDiff = s.blockTimeDiff || 0;
    const days = Math.floor(timeDiff / 86400);
    const h = Math.floor((timeDiff % 86400) / 3600);
    const m = Math.floor((timeDiff % 3600) / 60);
    const sec = timeDiff % 60;
    const timeSinceBlock = `${days} days, ${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;

    return {
      blockHeight: s.blockCount,
      blockHash: s.bestBlockHash,
      blockTime: s.blockTime,           // unix timestamp for live client-side counter
      peers: s.peerCount,
      score: s.nodeScore,
      version: s.version,
      ipPort: s.nodeIP,
      timeSinceBlock,
      updatedAt: Date.now(),
      // Pass through extra fields for any future UI use
      difficulty: s.difficulty,
      networkHashrate: s.networkHashrate,
      connections: s.connections,
      chain: s.chain,
      chainSize: s.chainSize,
    };
  }

  broadcast() {
    for (const fn of this.listeners) {
      try {
        fn(this.stats, this.legacyStats);
      } catch (_) {}
    }
  }

  subscribe(fn) {
    this.listeners.add(fn);
    if (this.stats) fn(this.stats, this.legacyStats);
    return () => this.listeners.delete(fn);
  }
}

const dataManager = new NodeDataManager();

// ─── File-Based Log Tailer ───────────────────────────────────────────────────

class FileTailer {
  constructor(filePath) {
    this.filePath = filePath;
    this.subscribers = new Set(); // Set of (lines: string[]) => void
    this.position = 0;
    this.watcher = null;
    this.debounceTimer = null;
  }

  /** Read last N lines from file */
  tailLast(n) {
    return new Promise((resolve) => {
      try {
        if (!fs.existsSync(this.filePath)) return resolve([]);
        const stat = fs.statSync(this.filePath);
        // Read last ~64KB to find tail lines
        const readSize = Math.min(stat.size, 65536);
        const start = Math.max(0, stat.size - readSize);
        const buf = Buffer.alloc(readSize);
        const fd = fs.openSync(this.filePath, 'r');
        fs.readSync(fd, buf, 0, readSize, start);
        fs.closeSync(fd);
        const lines = buf.toString('utf8').split('\n').filter(Boolean);
        this.position = stat.size;
        resolve(lines.slice(-n));
      } catch (err) {
        console.error(`[FileTailer] Error reading ${this.filePath}:`, err.message);
        resolve([]);
      }
    });
  }

  /** Subscribe to new lines. Returns unsubscribe function. */
  subscribe(callback) {
    this.subscribers.add(callback);

    // Send initial tail
    this.tailLast(LOG_TAIL_LINES).then((lines) => {
      if (lines.length > 0 && this.subscribers.has(callback)) {
        callback(lines);
      }
    });

    // Start watching if first subscriber
    if (this.subscribers.size === 1) this._startWatching();

    return () => {
      this.subscribers.delete(callback);
      if (this.subscribers.size === 0) this._stopWatching();
    };
  }

  _startWatching() {
    try {
      this.watcher = fs.watch(this.filePath, () => {
        // Debounce rapid fire events (inotify can fire multiple times)
        if (this.debounceTimer) return;
        this.debounceTimer = setTimeout(() => {
          this.debounceTimer = null;
          this._readNew();
        }, 100);
      });
      this.watcher.on('error', (err) => {
        console.error(`[FileTailer] Watch error on ${this.filePath}:`, err.message);
        // Try to recover by restarting watch after delay
        this._stopWatching();
        setTimeout(() => {
          if (this.subscribers.size > 0) this._startWatching();
        }, 5000);
      });
    } catch (err) {
      console.error(`[FileTailer] Cannot watch ${this.filePath}:`, err.message);
    }
  }

  _stopWatching() {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
  }

  _readNew() {
    try {
      const stat = fs.statSync(this.filePath);

      // File truncated or rotated — reset position
      if (stat.size < this.position) {
        this.position = 0;
      }

      if (stat.size <= this.position) return;

      const stream = fs.createReadStream(this.filePath, {
        start: this.position,
        encoding: 'utf8',
      });

      let data = '';
      stream.on('data', (chunk) => (data += chunk));
      stream.on('end', () => {
        this.position = stat.size;
        const lines = data.split('\n').filter(Boolean);
        if (lines.length > 0) {
          for (const cb of this.subscribers) {
            try {
              cb(lines);
            } catch (_) {}
          }
        }
      });
      stream.on('error', (err) => {
        console.error(`[FileTailer] Read error:`, err.message);
      });
    } catch (err) {
      console.error(`[FileTailer] Stat error on ${this.filePath}:`, err.message);
    }
  }
}

// Create tailers for configured log files
const logTailers = {};
if (RVN_LOG_FILE) {
  logTailers.raven = new FileTailer(RVN_LOG_FILE);
  console.log(`[Logs] RVN Core log: ${RVN_LOG_FILE}`);
}
if (ELECTRUMX_LOG_FILE) {
  logTailers.electrumx = new FileTailer(ELECTRUMX_LOG_FILE);
  console.log(`[Logs] ElectrumX log: ${ELECTRUMX_LOG_FILE}`);
} else {
  console.log('[Logs] ElectrumX log file not configured (set ELECTRUMX_LOG_FILE)');
}

// ─── ZMQ Subscriber ─────────────────────────────────────────────────────────

async function startZmqSubscriber(url, topic, label) {
  const sock = new zmq.Subscriber();

  try {
    sock.connect(url);
    sock.subscribe(topic);
    console.log(`[ZMQ] Subscribed to ${topic} on ${url}`);

    for await (const [topicBuf, msgBuf] of sock) {
      const hash = Buffer.from(msgBuf).reverse().toString('hex');
      console.log(`[ZMQ] ${label}: ${hash}`);
      await dataManager.refresh();
    }
  } catch (err) {
    console.error(`[ZMQ] ${label} error:`, err.message);
    // Reconnect after delay
    setTimeout(() => startZmqSubscriber(url, topic, label), 5000);
  }
}

// ─── Express + Socket.IO ─────────────────────────────────────────────────────

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

// REST fallback
app.get('/api/stats', async (_req, res) => {
  if (dataManager.stats) return res.json(dataManager.stats);
  try {
    const stats = await getNodeStats();
    res.json(stats);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Health check
app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    hasStats: !!dataManager.stats,
    zmqBlock: ZMQ_BLOCK_URL,
    zmqTx: ZMQ_TX_URL,
    logFiles: {
      raven: RVN_LOG_FILE || null,
      electrumx: ELECTRUMX_LOG_FILE || null,
    },
  });
});

// ─── Log source mapping ──────────────────────────────────────────────────────
// index.html uses 'core'/'electrumx', app.js uses 'raven'/'electrumx'
const LOG_SOURCE_MAP = { core: 'raven', raven: 'raven', electrumx: 'electrumx' };
const LOG_EVENT_MAP = { raven: 'log_core', electrumx: 'log_electrumx' };

// Socket.IO
io.on('connection', (socket) => {
  console.log(`[Socket.IO] Client connected (${io.engine.clientsCount} total)`);

  // Subscribe to singleton data manager — broadcasts stats to this client
  const unsubStats = dataManager.subscribe((stats, legacyStats) => {
    socket.emit('stats', stats);           // for app.js
    socket.emit('node_status', legacyStats); // for index.html
  });

  // Log streaming (file-based)
  const logUnsubs = {};

  function handleLogSubscribe(rawSource) {
    const source = LOG_SOURCE_MAP[rawSource] || rawSource;
    const tailer = logTailers[source];
    if (!tailer) {
      const legacyEvent = LOG_EVENT_MAP[source] || `log_${rawSource}`;
      socket.emit('log', { source, lines: [`[No log file configured for ${source}]`] });
      socket.emit(legacyEvent, `[No log file configured for ${source}]\n`);
      return;
    }

    // Don't double-subscribe
    if (logUnsubs[source]) return;

    logUnsubs[source] = tailer.subscribe((lines) => {
      const text = lines.join('\n') + '\n';
      const legacyEvent = LOG_EVENT_MAP[source] || `log_${source}`;
      socket.emit('log', { source, lines });   // for app.js
      socket.emit(legacyEvent, text);           // for index.html
    });
  }

  function handleLogUnsubscribe(rawSource) {
    const source = LOG_SOURCE_MAP[rawSource] || rawSource;
    if (logUnsubs[source]) {
      logUnsubs[source]();
      delete logUnsubs[source];
    }
  }

  // Support both event naming conventions
  socket.on('subscribe-logs', handleLogSubscribe);   // app.js style
  socket.on('subscribe_logs', handleLogSubscribe);    // index.html style
  socket.on('unsubscribe-logs', handleLogUnsubscribe);
  socket.on('unsubscribe_logs', handleLogUnsubscribe);

  socket.on('disconnect', () => {
    unsubStats();
    for (const unsub of Object.values(logUnsubs)) unsub();
    console.log(`[Socket.IO] Client disconnected (${io.engine.clientsCount} total)`);
  });
});

// ─── Startup ─────────────────────────────────────────────────────────────────

async function main() {
  // Initial data fetch
  console.log('[Startup] Fetching initial node stats...');
  await dataManager.refresh();

  if (dataManager.stats && !dataManager.stats.error) {
    console.log(`[Startup] Block height: ${dataManager.stats.blockCount}, Peers: ${dataManager.stats.peerCount}`);
  } else {
    console.warn('[Startup] Could not fetch initial stats (RPC may be unavailable). Will retry on ZMQ events.');
  }

  // Start ZMQ subscribers
  startZmqSubscriber(ZMQ_BLOCK_URL, 'hashblock', 'New block');
  startZmqSubscriber(ZMQ_TX_URL, 'hashtx', 'New tx');

  // Fallback periodic refresh (safety net)
  setInterval(() => {
    dataManager.refresh().catch((err) =>
      console.error('[Fallback] Refresh error:', err.message)
    );
  }, FALLBACK_REFRESH_MS);

  // Start HTTP server
  server.listen(PORT, () => {
    console.log(`[Server] Ravencoin Dashboard running on port ${PORT}`);
    console.log(`[Server] ZMQ block: ${ZMQ_BLOCK_URL}, tx: ${ZMQ_TX_URL}`);
  });
}

main().catch((err) => {
  console.error('[Fatal]', err);
  process.exit(1);
});
