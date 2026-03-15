// ===== SOCKET CONNECTION =====
const socket = io();
let currentStats = null;
let previousBlockCount = null;
let previousValues = {};
let debugOpen = false;
let activeLogSource = 'raven';
let blockTimeTimer = null;

// ===== PARTICLES (orange-tinted, mouse-reactive) =====
(function initParticles() {
  const canvas = document.getElementById('particles');
  const ctx = canvas.getContext('2d');
  let particles = [];
  const PARTICLE_COUNT = 80;
  let mouse = { x: -1000, y: -1000 };

  function resize() {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
  }
  window.addEventListener('resize', resize);
  resize();

  document.addEventListener('mousemove', (e) => {
    mouse.x = e.clientX;
    mouse.y = e.clientY;
  });

  class Particle {
    constructor() { this.reset(); }
    reset() {
      this.x = Math.random() * canvas.width;
      this.y = Math.random() * canvas.height;
      this.vx = (Math.random() - 0.5) * 0.4;
      this.vy = (Math.random() - 0.5) * 0.4;
      this.radius = Math.random() * 1.5 + 0.5;
      this.baseOpacity = Math.random() * 0.12 + 0.03;
      this.opacity = this.baseOpacity;
      // Mix of orange and blue particles
      this.isOrange = Math.random() < 0.4;
    }
    update() {
      const dx = this.x - mouse.x;
      const dy = this.y - mouse.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist < 120) {
        const force = (120 - dist) / 120 * 0.8;
        this.vx += (dx / dist) * force;
        this.vy += (dy / dist) * force;
        this.opacity = Math.min(0.4, this.baseOpacity + force * 0.3);
      } else {
        this.opacity += (this.baseOpacity - this.opacity) * 0.05;
      }
      this.vx *= 0.99;
      this.vy *= 0.99;
      this.x += this.vx;
      this.y += this.vy;
      if (this.x < 0 || this.x > canvas.width) this.vx *= -1;
      if (this.y < 0 || this.y > canvas.height) this.vy *= -1;
    }
    draw() {
      ctx.beginPath();
      ctx.arc(this.x, this.y, this.radius, 0, Math.PI * 2);
      if (this.isOrange) {
        ctx.fillStyle = `rgba(247, 147, 26, ${this.opacity})`;
      } else {
        ctx.fillStyle = `rgba(56, 74, 255, ${this.opacity * 0.7})`;
      }
      ctx.fill();
    }
  }

  for (let i = 0; i < PARTICLE_COUNT; i++) particles.push(new Particle());

  function drawConnections() {
    for (let i = 0; i < particles.length; i++) {
      for (let j = i + 1; j < particles.length; j++) {
        const dx = particles[i].x - particles[j].x;
        const dy = particles[i].y - particles[j].y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < 140) {
          const alpha = 0.06 * (1 - dist / 140);
          ctx.beginPath();
          ctx.moveTo(particles[i].x, particles[i].y);
          ctx.lineTo(particles[j].x, particles[j].y);
          // Orange connections between orange particles
          if (particles[i].isOrange || particles[j].isOrange) {
            ctx.strokeStyle = `rgba(247, 147, 26, ${alpha * 0.6})`;
          } else {
            ctx.strokeStyle = `rgba(30, 58, 95, ${alpha})`;
          }
          ctx.lineWidth = 0.5;
          ctx.stroke();
        }
      }
    }
  }

  function animate() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    particles.forEach(p => { p.update(); p.draw(); });
    drawConnections();
    requestAnimationFrame(animate);
  }
  animate();
})();

// ===== FORMAT HELPERS =====
function formatNumber(n) {
  if (n == null) return '—';
  return n.toLocaleString('en-US');
}

function formatHashrate(h) {
  if (!h) return '—';
  const units = ['H/s', 'KH/s', 'MH/s', 'GH/s', 'TH/s', 'PH/s'];
  let i = 0;
  while (h >= 1000 && i < units.length - 1) { h /= 1000; i++; }
  return h.toFixed(2) + ' ' + units[i];
}

function formatDifficulty(d) {
  if (!d) return '—';
  if (d >= 1e12) return (d / 1e12).toFixed(2) + 'T';
  if (d >= 1e9) return (d / 1e9).toFixed(2) + 'G';
  if (d >= 1e6) return (d / 1e6).toFixed(2) + 'M';
  if (d >= 1e3) return (d / 1e3).toFixed(2) + 'K';
  return d.toFixed(2);
}

function formatBytes(bytes) {
  if (!bytes) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let b = bytes;
  while (b >= 1024 && i < units.length - 1) { b /= 1024; i++; }
  return b.toFixed(2) + ' ' + units[i];
}

function formatTimeDiff(seconds) {
  if (seconds == null || seconds < 0) return '—';
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  const parts = [];
  if (d > 0) parts.push(`${d}d`);
  if (h > 0) parts.push(`${h}h`);
  parts.push(`${m}m ${s}s ago`);
  return parts.join(' ');
}

function formatTimestamp(unix) {
  if (!unix) return '—';
  const d = new Date(unix * 1000);
  return d.toLocaleString();
}

// ===== BLOCK COUNTER WITH DIGIT ANIMATION =====
function renderBlockCount(count) {
  const el = document.getElementById('asciiBlock');
  const formatted = formatNumber(count);

  if (previousBlockCount === null) {
    el.innerHTML = buildDigitHTML(formatted) + '<span class="live-dot" id="liveDot"></span>';
    previousBlockCount = count;
    return;
  }

  const prevFormatted = formatNumber(previousBlockCount);

  if (count !== previousBlockCount) {
    el.classList.add('new-block');
    setTimeout(() => el.classList.remove('new-block'), 800);
    if (window.triggerBlockNotification) {
      window.triggerBlockNotification();
    }
  }

  el.innerHTML = buildDigitHTML(formatted, prevFormatted) + '<span class="live-dot" id="liveDot"></span>';
  previousBlockCount = count;
}

function buildDigitHTML(current, previous) {
  let html = '';
  for (let i = 0; i < current.length; i++) {
    const ch = current[i];
    if (ch === ',') {
      html += `<span class="comma">,</span>`;
    } else {
      const changed = previous && i < previous.length && previous[i] !== ch;
      html += `<span class="digit-container"><span class="digit${changed ? ' flip' : ''}">${ch}</span></span>`;
    }
  }
  return html;
}

// ===== LIVE BLOCK TIME COUNTER =====
function startBlockTimeCounter(blockTimestamp) {
  if (blockTimeTimer) clearInterval(blockTimeTimer);
  function update() {
    const now = Math.floor(Date.now() / 1000);
    const diff = now - blockTimestamp;
    document.querySelector('#blockAge .meta-value').textContent = formatTimeDiff(diff);
  }
  update();
  blockTimeTimer = setInterval(update, 1000);
}

// ===== FLASH VALUE ON CHANGE =====
function updateValue(id, newValue) {
  const el = document.getElementById(id);
  if (!el) return;
  const prev = previousValues[id];
  el.textContent = newValue;
  if (prev !== undefined && prev !== newValue) {
    const card = el.closest('.stat-card');
    if (card) {
      card.classList.add('updated');
      setTimeout(() => card.classList.remove('updated'), 600);
    }
  }
  previousValues[id] = newValue;
}

// ===== TICKER =====
function updateTicker(stats) {
  let existing = document.querySelector('.ticker');
  if (!existing) {
    existing = document.createElement('div');
    existing.className = 'ticker';
    // Insert after hero
    const hero = document.querySelector('.hero');
    hero.parentNode.insertBefore(existing, hero.nextSibling);
  }

  const items = [
    { label: 'HEIGHT', value: formatNumber(stats.blockCount) },
    { label: 'HASH/s', value: formatHashrate(stats.networkHashrate) },
    { label: 'DIFF', value: formatDifficulty(stats.difficulty) },
    { label: 'PEERS', value: formatNumber(stats.peerCount) },
    { label: 'CONN', value: formatNumber(stats.connections) },
    { label: 'CHAIN', value: stats.chain || '—' },
    { label: 'HEADERS', value: formatNumber(stats.headers) },
  ];

  const itemsHTML = items.map(i =>
    `<span class="ticker-item"><span class="label">${i.label}</span><span class="value">${i.value}</span></span>`
  ).join('');

  existing.innerHTML = `<span class="ticker-inner">${itemsHTML}${itemsHTML}</span>`;
}

// ===== UPDATE UI =====
function updateUI(stats) {
  if (stats.error) {
    document.getElementById('statusPill').className = 'status-pill error';
    document.querySelector('.status-text').textContent = 'ERROR';
    document.getElementById('asciiBlock').innerHTML = '<span class="loading" style="color:var(--red)">CONNECTION ERROR</span>';
    return;
  }

  currentStats = stats;

  // Status
  document.getElementById('statusPill').className = 'status-pill online';
  document.querySelector('.status-text').textContent = 'ONLINE';

  // Block counter
  renderBlockCount(stats.blockCount);

  // Live ticking block age
  if (stats.blockTime) startBlockTimeCounter(stats.blockTime);

  document.querySelector('#chainStatus .meta-value').textContent = stats.chain || '—';

  const progress = stats.verificationProgress;
  const syncEl = document.querySelector('#syncProgress .meta-value');
  if (progress >= 0.9999) {
    syncEl.textContent = 'Synced';
    syncEl.style.color = 'var(--green)';
  } else {
    syncEl.textContent = (progress * 100).toFixed(2) + '%';
    syncEl.style.color = 'var(--c-network)';
  }

  // Network
  updateValue('difficulty', formatDifficulty(stats.difficulty));
  updateValue('hashrate', formatHashrate(stats.networkHashrate));

  // Node
  updateValue('nodeVersion', stats.version || '—');
  updateValue('nodeIP', stats.nodeIP || '—');
  updateValue('nodeScore', stats.nodeScore != null ? String(stats.nodeScore) : '—');
  updateValue('protocolVersion', stats.protocolVersion ? String(stats.protocolVersion) : '—');

  // Connectivity
  updateValue('connections', formatNumber(stats.connections));
  const connDetail = document.getElementById('connDetail');
  if (connDetail && (stats.connectionsIn != null || stats.connectionsOut != null)) {
    connDetail.textContent = `IN ${stats.connectionsIn || 0} / OUT ${stats.connectionsOut || 0}`;
  }
  updateValue('peerCount', formatNumber(stats.peerCount));

  // Bandwidth
  if (stats.netTotals) {
    updateValue('bandwidth', `↓ ${formatBytes(stats.netTotals.received)}  ↑ ${formatBytes(stats.netTotals.sent)}`);
  }

  // Chain size
  updateValue('chainSize', formatBytes(stats.chainSize));

  // Block info
  updateValue('bestHash', stats.bestBlockHash || '—');
  updateValue('blockTimestamp', stats.blockTime ? formatTimestamp(stats.blockTime) : '—');

  const blockMetaParts = [];
  if (stats.blockSize) blockMetaParts.push(formatBytes(stats.blockSize));
  if (stats.blockTxCount) blockMetaParts.push(`${stats.blockTxCount} txs`);
  updateValue('blockMeta', blockMetaParts.join(' / ') || '—');

  // Ticker
  updateTicker(stats);

  // Peers
  if (stats.peers && stats.peers.length > 0) {
    document.getElementById('peersSection').style.display = 'block';
    const table = document.getElementById('peersTable');
    table.innerHTML = stats.peers.map(p => `
      <div class="peer-row">
        <span class="addr">${escapeHtml(p.addr)}</span>
        <span class="subver">${escapeHtml(p.subver)}</span>
        <span class="direction">${p.inbound ? 'IN' : 'OUT'}</span>
        <span class="ping">${p.pingtime ? (p.pingtime * 1000).toFixed(0) + 'ms' : '—'}</span>
      </div>
    `).join('');
  }

  // Footer
  document.getElementById('lastUpdate').textContent = 'Updated ' + new Date().toLocaleTimeString();
}

function escapeHtml(str) {
  if (!str) return '';
  return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// ===== SOCKET EVENTS =====
socket.on('stats', updateUI);

socket.on('connect', () => {
  document.getElementById('statusPill').className = 'status-pill';
  document.querySelector('.status-text').textContent = 'CONNECTING';
});

socket.on('disconnect', () => {
  document.getElementById('statusPill').className = 'status-pill error';
  document.querySelector('.status-text').textContent = 'DISCONNECTED';
});

// ===== DEBUG PANEL =====
const debugPanel = document.getElementById('debugPanel');
const debugOverlay = document.getElementById('debugOverlay');
const debugToggle = document.getElementById('debugToggle');
const debugClose = document.getElementById('debugClose');

function openDebug() {
  debugOpen = true;
  debugPanel.classList.add('open');
  debugOverlay.classList.add('open');
  socket.emit('subscribe-logs', activeLogSource);
}

function closeDebug() {
  debugOpen = false;
  debugPanel.classList.remove('open');
  debugOverlay.classList.remove('open');
  socket.emit('unsubscribe-logs', 'raven');
  socket.emit('unsubscribe-logs', 'electrumx');
}

debugToggle.addEventListener('click', () => debugOpen ? closeDebug() : openDebug());
debugClose.addEventListener('click', closeDebug);
debugOverlay.addEventListener('click', closeDebug);

document.querySelectorAll('.debug-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    const source = tab.dataset.source;
    document.querySelectorAll('.debug-tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    document.getElementById('logRaven').style.display = source === 'raven' ? 'block' : 'none';
    document.getElementById('logElectrumx').style.display = source === 'electrumx' ? 'block' : 'none';
    socket.emit('unsubscribe-logs', activeLogSource);
    activeLogSource = source;
    if (debugOpen) socket.emit('subscribe-logs', source);
  });
});

const MAX_LOG_LINES = 500;

socket.on('log', ({ source, lines }) => {
  const container = source === 'raven'
    ? document.getElementById('logRaven')
    : document.getElementById('logElectrumx');

  lines.forEach(line => {
    const el = document.createElement('div');
    el.className = 'log-line';
    if (/error|exception|traceback/i.test(line)) el.classList.add('error');
    else if (/warn/i.test(line)) el.classList.add('warn');
    else el.classList.add('info');
    el.textContent = line;
    container.appendChild(el);
  });

  while (container.children.length > MAX_LOG_LINES) {
    container.removeChild(container.firstChild);
  }

  document.getElementById('debugLogs').scrollTop = document.getElementById('debugLogs').scrollHeight;
});

// ===== KEYBOARD SHORTCUTS =====
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && debugOpen) closeDebug();
  if (e.key === '`' && e.ctrlKey) { e.preventDefault(); debugOpen ? closeDebug() : openDebug(); }
});

// ===== BLOCK SOUND NOTIFICATIONS =====
(function() {
  const SOUNDS = [
    'sounds/rvn-notify-raven1.mp3',
    'sounds/rvn-notify-raven2.mp3',
    'sounds/rvn-notify-corax-1a.mp3',
    'sounds/rvn-notify-corax-1b.mp3',
    'sounds/rvn-notify-corax-2.mp3',
    'sounds/rvn-notify-corax-3.mp3',
    'sounds/rvn-notify-corax-4.mp3',
    'sounds/rvn-notify-corax-5.mp3',
    'sounds/rvn-notify-corax-7.mp3',
    'sounds/rvn-notify-corax-8.mp3',
    'sounds/rvn-notify-corax-9.mp3',
    'sounds/rvn-notify-corax-10.mp3',
  ];

  // Preload all audio objects
  const audioPool = SOUNDS.map(src => {
    const a = new Audio(src);
    a.preload = 'auto';
    return a;
  });

  // Audio unlock on first user interaction
  let audioUnlocked = false;
  function unlockAudio() {
    if (audioUnlocked) return;
    audioUnlocked = true;
    console.log('Unlocking audio...');
    audioPool.forEach(s => {
      s.volume = 0.5;
      s.play().then(() => {
        console.log('Audio unlocked for:', s.src);
        s.pause();
        s.currentTime = 0;
      }).catch(e => console.log('Audio unlock failed:', e));
    });
  }
  document.addEventListener('click', unlockAudio, { once: true });
  document.addEventListener('keydown', unlockAudio, { once: true });

  let lastPlayedIdx = -1;

  function playRandomSound() {
    let idx;
    do { idx = Math.floor(Math.random() * audioPool.length); }
    while (idx === lastPlayedIdx && audioPool.length > 1);
    lastPlayedIdx = idx;
    const a = audioPool[idx];
    a.currentTime = 0;
    a.play().catch(() => {});
  }

  // ── White light animation ──
  const overlay   = document.getElementById('blockOverlay');
  const whiteLight = document.getElementById('whiteLight');

  let animFrame = null;
  let animStart = null;
  const ANIM_DURATION = 5000; // ms — matches sound length

  function animateWhiteLight(ts) {
    if (!animStart) animStart = ts;
    const progress = Math.min((ts - animStart) / ANIM_DURATION, 1);

    // Envelope: fade in 0→0.2, hold 0.2→0.6, fade out 0.6→1.0
    let envAlpha;
    if (progress < 0.2)      envAlpha = progress / 0.2;
    else if (progress < 0.6) envAlpha = 1.0;
    else                      envAlpha = 1.0 - (progress - 0.6) / 0.4;
    envAlpha = Math.max(0, Math.min(1, envAlpha));

    if (whiteLight) {
      whiteLight.style.opacity = envAlpha.toFixed(3);
    }
    overlay.style.opacity = envAlpha > 0 ? '1' : '0';

    if (progress < 1) {
      animFrame = requestAnimationFrame(animateWhiteLight);
    } else {
      // Clean up
      if (whiteLight) whiteLight.style.opacity = '0';
      overlay.style.opacity = '0';
      overlay.style.pointerEvents = 'none';
      animFrame = null;
    }
  }

  function startAnimation() {
    if (animFrame) {
      cancelAnimationFrame(animFrame);
      animFrame = null;
    }
    animStart = null;
    overlay.style.pointerEvents = 'none';
    animFrame = requestAnimationFrame(animateWhiteLight);
  }

  // ── Public trigger ──
  window.triggerBlockNotification = function() {
    console.log('triggerBlockNotification called');
    const toggle = document.getElementById('soundToggle');
    console.log('Toggle checked:', toggle ? toggle.checked : 'toggle not found');
    if (toggle && !toggle.checked) return;
    console.log('Playing sound, audioPool length:', audioPool.length);
    playRandomSound();
    startAnimation();
  };

  // Toggle icon update
  const toggle = document.getElementById('soundToggle');
  const icon   = document.getElementById('soundIcon');
  if (toggle && icon) {
    toggle.addEventListener('change', () => {
      icon.textContent = toggle.checked ? '🔔' : '🔕';
    });
  }
})();
