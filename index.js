const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { exec, spawn } = require('child_process');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 8080;
const POLL_INTERVAL = process.env.POLL_INTERVAL || 5000;

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));

// Parse node_status output into structured data
function parseNodeStatus(raw) {
  const lines = raw.split('\n').filter(l => l.trim());
  const data = { raw: lines };
  for (const line of lines) {
    if (line.includes('Node version:')) data.version = line.split('Node version:')[1].trim();
    else if (line.includes('Node IP/port:')) data.ipPort = line.split('Node IP/port:')[1].trim();
    else if (line.includes('Node Peer Count:')) data.peers = parseInt(line.split('Node Peer Count:')[1].trim(), 10);
    else if (line.includes('Node score:')) data.score = parseInt(line.split('Node score:')[1].trim(), 10);
    else if (line.includes('block count:')) data.blockHeight = parseInt(line.split('block count:')[1].trim(), 10);
    else if (line.includes('block hash:')) data.blockHash = line.split('block hash:')[1].trim();
    else if (line.includes('block timestamp is:')) data.blockTimestamp = parseInt(line.split('block timestamp is:')[1].trim(), 10);
    else if (line.includes('Difference is:')) data.timeSinceBlock = line.split('Difference is:')[1].trim();
    else if (line.includes('Extraction skipped') || line.includes('UTC 2')) data.timestamp = line.trim();
  }
  return data;
}

let latestData = null;

function pollNodeStatus() {
  exec('/usr/local/bin/raven_init node_status', { timeout: 15000 }, (error, stdout, stderr) => {
    if (error) {
      console.error('Poll error:', error.message);
      return;
    }
    if (stdout.trim()) {
      latestData = parseNodeStatus(stdout);
      latestData.updatedAt = Date.now();
      io.emit('node_status', latestData);
    }
  });
}

// Socket.IO
io.on('connection', (socket) => {
  console.log('Client connected');
  if (latestData) socket.emit('node_status', latestData);

  // Stream logs on demand
  socket.on('subscribe_logs', (source) => {
    // source: 'core' or 'electrumx'
    const cmd = source === 'electrumx'
      ? 'docker logs --tail 80 --follow rvn-electrumx 2>&1'
      : 'docker logs --tail 80 --follow rvn-node 2>&1';

    const proc = spawn('sh', ['-c', cmd]);
    const channel = `log_${source}`;

    proc.stdout.on('data', (d) => socket.emit(channel, d.toString()));
    proc.stderr.on('data', (d) => socket.emit(channel, d.toString()));
    proc.on('close', () => socket.emit(channel, '\n--- stream ended ---\n'));

    socket.on(`unsubscribe_logs_${source}`, () => proc.kill());
    socket.on('disconnect', () => proc.kill());
  });
});

// REST fallback
app.get('/api/status', (req, res) => {
  if (latestData) return res.json(latestData);
  exec('/usr/local/bin/raven_init node_status', { timeout: 15000 }, (error, stdout) => {
    if (error) return res.status(500).json({ error: error.message });
    res.json(parseNodeStatus(stdout));
  });
});

// Start polling
setInterval(pollNodeStatus, POLL_INTERVAL);
pollNodeStatus();

server.listen(PORT, () => {
  console.log(`RVN Node Dashboard running on port ${PORT}`);
});
