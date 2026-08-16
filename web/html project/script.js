// ArduMedi - Web Serial dashboard

// ----- DOM references -----
const connectBtn = document.getElementById('connectBtn');
const statusEl = document.getElementById('status');
const tempEl = document.getElementById('temp');
const humidityEl = document.getElementById('humidity');
const gasEl = document.getElementById('gas');
const heartEl = document.getElementById('heart');
const heartSubEl = document.getElementById('heartSub');
const canvas = document.getElementById('bpmChart');
const ctx = canvas.getContext('2d');

// ----- State -----
let port = null;
let reader = null;
let connected = false;
let measuring = false;
let lastAvg = 0;
let bpmHistory = [];

// ============================================================
// Connection
// ============================================================

if (!('serial' in navigator)) {
  setStatus('Web Serial not supported - use Chrome or Edge over HTTPS');
  connectBtn.disabled = true;
}

connectBtn.addEventListener('click', () => {
  if (connected) {
    disconnect();
  } else {
    connect();
  }
});

async function connect() {
  try {
    port = await navigator.serial.requestPort();
    await port.open({ baudRate: 115200 });
    connected = true;
    resetHeart();
    updateConnectionUI('Connected');
    readLoop();
  } catch (err) {
    if (err.name !== 'NotFoundError') {
      setStatus('Could not connect: ' + err.message);
    }
  }
}

async function disconnect() {
  connected = false;
  if (reader) {
    try {
      await reader.cancel();
    } catch (e) {}
  }
  try {
    await port.close();
  } catch (e) {}
  reader = null;
  port = null;
  updateConnectionUI('Disconnected');
}

async function readLoop() {
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    reader = port.readable.getReader();
    while (connected) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let newline;
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line) handleLine(line);
      }
    }
  } catch (e) {
    // port closed or unplugged
  } finally {
    if (reader) {
      reader.releaseLock();
      reader = null;
    }
  }

  if (connected) {
    connected = false;
    measuring = false;
    updateConnectionUI('Connection lost - device unplugged?');
  }
}

function updateConnectionUI(message) {
  connectBtn.textContent = connected ? 'Disconnect' : 'Connect';
  connectBtn.classList.toggle('disconnect', connected);
  setStatus(message);
}

function setStatus(msg) {
  statusEl.textContent = msg;
}

// ============================================================
// Serial data parsing
// ============================================================

// M,1 | M,0 | E,h,t,g | R,ir | B,bpm,avg
function handleLine(line) {
  const p = line.split(',');
  switch (p[0]) {
    case 'M':
      if (p[1] === '1') {
        startMeasuring();
      } else {
        stopMeasuring();
      }
      break;
    case 'E':
      updateEnvironment(p[1], p[2], p[3]);
      break;
    case 'B':
      updateBeat(p[1], p[2]);
      break;
  }
}

// ============================================================
// Data updates
// ============================================================

function startMeasuring() {
  measuring = true;
  lastAvg = 0;
  bpmHistory = [];
  heartEl.textContent = '--';
  heartSubEl.textContent = 'Place your finger on the sensor';
  statusEl.classList.add('measuring');
  drawChart();
}

function stopMeasuring() {
  measuring = false;
  statusEl.classList.remove('measuring');
  if (bpmHistory.length > 0) {
    heartEl.textContent = lastAvg + ' bpm';
    heartSubEl.textContent = 'Average of the last measurement';
  } else {
    heartEl.textContent = '--';
    heartSubEl.textContent = 'No beats detected - try again';
  }
  drawChart();
}

function resetHeart() {
  measuring = false;
  lastAvg = 0;
  bpmHistory = [];
  heartEl.textContent = '--';
  heartSubEl.textContent = 'Press the button on your device to measure';
  statusEl.classList.remove('measuring');
  drawChart();
}

function updateEnvironment(hum, temp, gas) {
  const ok = hum !== 'DHT_ERROR';
  humidityEl.textContent = ok ? formatValue(hum) + '%' : '--';
  tempEl.textContent = ok ? formatValue(temp) + '\u00B0C' : '--';
  gasEl.textContent = ok ? formatValue(gas) + '%' : '--';
}

function updateRawReading(ir) {
  if (!measuring) return;
  latestIr = ir;
  updateHeartNote();
}

function updateBeat(bpm, avg) {
  if (!measuring) return;
  lastAvg = Number(avg) || lastAvg;
  bpmHistory.push(Number(bpm));
  heartEl.textContent = bpm + ' bpm';
  heartSubEl.textContent = 'Release button to see average';
  drawChart();
}

function formatValue(value) {
  const n = parseFloat(value);
  if (!isFinite(n)) return '--';
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

// ============================================================
// BPM chart (plain canvas, no libraries)
// ============================================================

function drawChart() {
  const rect = canvas.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return;

  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(rect.width * dpr);
  canvas.height = Math.round(rect.height * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  const w = rect.width;
  const h = rect.height;
  ctx.clearRect(0, 0, w, h);

  const pad = { left: 42, right: 14, top: 14, bottom: 26 };
  const plotW = w - pad.left - pad.right;
  const plotH = h - pad.top - pad.bottom;

  const data = bpmHistory;

  if (data.length === 0) {
    ctx.fillStyle = '#8b949e';
    ctx.font = '14px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('No BPM data yet - press the button to measure', w / 2, h / 2);
    return;
  }

  // y range with a little padding
  let lo = data[0];
  let hi = data[0];
  for (const v of data) {
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  lo = Math.max(0, lo - 15);
  hi = hi + 15;
  if (lo >= hi) {
    lo = 0;
    hi = 1;
  }

  const yPos = (v) => pad.top + plotH - ((v - lo) / (hi - lo)) * plotH;
  const xPos = (i) => pad.left + (data.length === 1 ? plotW / 2 : (i / (data.length - 1)) * plotW);

  // grid + y labels
  ctx.lineWidth = 1;
  ctx.font = '11px system-ui, sans-serif';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  for (let i = 0; i <= 4; i++) {
    const value = lo + ((hi - lo) * i) / 4;
    const y = yPos(value);
    ctx.strokeStyle = '#232c3e';
    ctx.beginPath();
    ctx.moveTo(pad.left, y);
    ctx.lineTo(w - pad.right, y);
    ctx.stroke();
    ctx.fillStyle = '#8b949e';
    ctx.fillText(String(Math.round(value)), pad.left - 8, y);
  }

  // data line
  ctx.strokeStyle = '#ff4d5e';
  ctx.lineWidth = 2;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.beginPath();
  data.forEach((v, i) => {
    if (i === 0) {
      ctx.moveTo(xPos(i), yPos(v));
    } else {
      ctx.lineTo(xPos(i), yPos(v));
    }
  });
  ctx.stroke();

  // data points
  ctx.fillStyle = '#ff4d5e';
  for (let i = 0; i < data.length; i++) {
    ctx.beginPath();
    ctx.arc(xPos(i), yPos(data[i]), 2.5, 0, Math.PI * 2);
    ctx.fill();
  }

  // x label
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = '#8b949e';
  ctx.fillText('Beats detected: ' + data.length, w / 2, h - 8);
}

window.addEventListener('resize', drawChart);
drawChart();

window.addEventListener('beforeunload', () => {
  if (reader) {
    try {
      reader.cancel();
    } catch (e) {}
  }
  if (port) {
    try {
      port.close();
    } catch (e) {}
  }
});
