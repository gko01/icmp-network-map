/* =====================================================================
   app.js — ICMP Network Map frontend logic
   ===================================================================== */

// ---- State ----
let devices = [];   // { id, name, ip, group, notes, status, latency, last_checked }
let links   = [];   // { id, source, target, label }
let statuses = {};  // { device_id: { status, latency, last_checked } }
let selectedId = null;

// ---- Link mode state ----
let linkMode = false;
let linkFirstNode = null;  // id of the first node clicked in link mode

// ---- Layout persistence ----
// Node positions are stored in localStorage so the map layout survives
// page reloads, device adds, and container restarts.
const _POS_KEY = 'icmp-map-positions';
let _positions = {};   // { deviceId: { x, y } }  — in-memory cache

function _loadPositions() {
  try { _positions = JSON.parse(localStorage.getItem(_POS_KEY) || '{}'); }
  catch (_) { _positions = {}; }
}

function _savePositions(updates) {
  Object.assign(_positions, updates);
  localStorage.setItem(_POS_KEY, JSON.stringify(_positions));
}

function _deletePosition(deviceId) {
  delete _positions[deviceId];
  localStorage.setItem(_POS_KEY, JSON.stringify(_positions));
}

// ---- vis.js network ----
const visNodes = new vis.DataSet();
const visEdges = new vis.DataSet();
let network = null;

// ---- Colour helpers ----
const STATUS_COLOR = {
  up:      { bg: '#22c55e', border: '#16a34a', font: '#fff' },
  down:    { bg: '#ef4444', border: '#b91c1c', font: '#fff' },
  unknown: { bg: '#475569', border: '#334155', font: '#cbd5e1' },
};

function statusColor(status) {
  return STATUS_COLOR[status] || STATUS_COLOR.unknown;
}

function nodeOptions(device) {
  const s = device.status || 'unknown';
  const c = statusColor(s);
  const latencyStr = device.latency != null ? ` (${device.latency}ms)` : '';
  const isFirst = linkMode && linkFirstNode === device.id;
  const opts = {
    id: device.id,
    label: `${device.name}\n${device.ip}${latencyStr}`,
    title: buildTooltip(device),
    color: {
      background: isFirst ? '#f59e0b' : c.bg,
      border: isFirst ? '#d97706' : c.border,
      highlight: { background: isFirst ? '#f59e0b' : c.bg, border: '#fff' },
    },
    font: { color: isFirst ? '#000' : c.font, size: 13, face: 'Segoe UI, system-ui, sans-serif' },
    shape: 'box',
    shapeProperties: { borderRadius: 10 },
    size: 28,
    widthConstraint: { minimum: 100 },
    borderWidth: isFirst ? 3 : 2,
    shadow: { enabled: s === 'up', size: 10, color: c.bg },
  };
  // Restore saved position so the node stays put across reloads/updates
  const pos = _positions[device.id];
  if (pos) {
    opts.x = pos.x;
    opts.y = pos.y;
    opts.physics = false;
  }
  return opts;
}

function edgeOptions(link) {
  return {
    id: link.id,
    from: link.source,
    to: link.target,
    label: link.label || '',
    font: { color: '#94a3b8', size: 11, align: 'middle', background: 'rgba(15,17,23,0.75)' },
    color: { color: '#4a5568', highlight: '#4f8ef7', hover: '#4f8ef7' },
    width: 2,
    hoverWidth: 3,
    smooth: { type: 'dynamic' },
    arrows: { to: { enabled: false } },
  };
}

function buildTooltip(device) {
  const s = device.status || 'unknown';
  const latencyStr = device.latency != null ? `${device.latency} ms` : '—';
  const checkedStr = device.last_checked
    ? new Date(device.last_checked * 1000).toLocaleTimeString()
    : '—';
  const group = device.group ? `<br><b>Group:</b> ${escHtml(device.group)}` : '';
  const notes = device.notes ? `<br><b>Notes:</b> ${escHtml(device.notes)}` : '';
  return `<b>${escHtml(device.name)}</b><br><b>IP:</b> ${escHtml(device.ip)}<br><b>Status:</b> ${escHtml(s.toUpperCase())}<br><b>Latency:</b> ${latencyStr}<br><b>Last check:</b> ${checkedStr}${group}${notes}`;
}

// ---- Bootstrap vis network ----
function initNetwork() {
  const container = document.getElementById('network-container');
  const options = {
    layout: { randomSeed: 42 },
    physics: {
      enabled: true,
      barnesHut: { gravitationalConstant: -3000, springLength: 180, springConstant: 0.04 },
      stabilization: { iterations: 150 },
    },
    interaction: {
      hover: true,
      tooltipDelay: 100,
      navigationButtons: true,
      keyboard: true,
    },
    nodes: { chosen: true },
    edges: {
      color: { color: '#4a5568', hover: '#4f8ef7', highlight: '#4f8ef7' },
      smooth: { type: 'dynamic' },
      font: { size: 11 },
    },
    manipulation: { enabled: false },
  };
  network = new vis.Network(container, { nodes: visNodes, edges: visEdges }, options);

  network.on('click', (params) => {
    if (linkMode) {
      handleLinkModeClick(params);
      return;
    }
    if (params.nodes.length > 0) {
      openEditModal(params.nodes[0]);
    } else if (params.edges.length > 0) {
      openLinkEditModal(params.edges[0]);
    } else {
      selectDevice(null);
    }
  });

  // Save positions when the user drags a node
  network.on('dragEnd', (params) => {
    if (params.nodes.length === 0) return;
    _savePositions(network.getPositions(params.nodes));
  });

  // After physics settles (initial load or new node added), pin every node in place
  network.on('stabilized', () => {
    const ids = visNodes.getIds();
    if (ids.length === 0) return;
    _savePositions(network.getPositions(ids));
    visNodes.update(ids.map(id => ({ id, physics: false })));
  });
}

// ---- Link mode ----
function setLinkMode(on) {
  linkMode = on;
  linkFirstNode = null;
  document.getElementById('btn-link-mode').classList.toggle('active', on);
  document.getElementById('link-mode-banner').hidden = !on;
  document.getElementById('network-container').classList.toggle('link-mode', on);
  if (on) {
    setLinkBannerMsg('🔗 <strong>Link Mode</strong> — click the <strong>first</strong> device');
  }
  // Refresh nodes so highlight clears
  visNodes.update(devices.map(nodeOptions));
}

function setLinkBannerMsg(html) {
  document.getElementById('link-mode-msg').innerHTML = html;
}

function handleLinkModeClick(params) {
  if (params.nodes.length === 0) return;
  const nodeId = params.nodes[0];

  if (!linkFirstNode) {
    // First node selected
    linkFirstNode = nodeId;
    const d = devices.find(x => x.id === nodeId);
    setLinkBannerMsg(`🔗 <strong>${escHtml(d?.name || nodeId)}</strong> → click the <strong>second</strong> device`);
    visNodes.update([nodeOptions(d)]);  // highlight first node
  } else {
    if (nodeId === linkFirstNode) {
      toast('Cannot link a device to itself', 'error');
      return;
    }
    // Second node — create the link
    const src = linkFirstNode;
    const tgt = nodeId;
    linkFirstNode = null;
    setLinkMode(false);
    addLink({ source: src, target: tgt, label: '' })
      .then(link => {
        links.push(link);
        visEdges.add(edgeOptions(link));
        renderLinkList();
        toast('Link created', 'success');
      })
      .catch(err => toast(err.message, 'error'));
  }
}

// ---- Render helpers ----
function applyStatuses() {
  devices.forEach(d => {
    const s = statuses[d.id] || {};
    d.status = s.status || 'unknown';
    d.latency = s.latency ?? null;
    d.last_checked = s.last_checked ?? null;
  });
}

function renderAll() {
  applyStatuses();
  renderGraph();
  renderSidebar();
  renderLinkList();
  renderStats();
}

function renderGraph() {
  const currentNodeIds = visNodes.getIds();
  const incomingIds = devices.map(d => d.id);
  visNodes.remove(currentNodeIds.filter(id => !incomingIds.includes(id)));
  devices.forEach(d => {
    if (visNodes.get(d.id)) visNodes.update(nodeOptions(d));
    else visNodes.add(nodeOptions(d));
  });

  const currentEdgeIds = visEdges.getIds();
  const incomingEdgeIds = links.map(l => l.id);
  visEdges.remove(currentEdgeIds.filter(id => !incomingEdgeIds.includes(id)));
  links.forEach(l => {
    if (visEdges.get(l.id)) visEdges.update(edgeOptions(l));
    else visEdges.add(edgeOptions(l));
  });
}

function renderSidebar(filter = '') {
  const ul = document.getElementById('device-list');
  ul.innerHTML = '';
  const q = filter.toLowerCase();
  const filtered = devices.filter(d =>
    d.name.toLowerCase().includes(q) ||
    d.ip.includes(q) ||
    (d.group || '').toLowerCase().includes(q)
  );
  filtered.forEach(d => {
    const li = document.createElement('li');
    if (d.id === selectedId) li.classList.add('selected');

    const dot = document.createElement('span');
    dot.className = `device-dot dot-${d.status || 'unknown'}`;

    const info = document.createElement('div');
    info.className = 'device-info';
    info.innerHTML = `<div class="device-name">${escHtml(d.name)}</div><div class="device-ip">${escHtml(d.ip)}${d.group ? ' · ' + escHtml(d.group) : ''}</div>`;

    const lat = document.createElement('span');
    lat.className = 'device-latency';
    lat.textContent = d.latency != null ? `${d.latency}ms` : '';

    li.append(dot, info, lat);
    li.addEventListener('click', () => {
      if (linkMode) {
        handleLinkModeClick({ nodes: [d.id] });
        return;
      }
      selectDevice(d.id);
      openEditModal(d.id);
    });
    ul.appendChild(li);
  });
}

function renderLinkList() {
  const ul = document.getElementById('link-list');
  ul.innerHTML = '';
  if (links.length === 0) {
    const empty = document.createElement('li');
    empty.style.cssText = 'color:var(--text-muted);font-size:12px;padding:16px;cursor:default;';
    empty.textContent = 'No links yet. Use 🔗 Link Mode to connect devices.';
    ul.appendChild(empty);
    return;
  }
  links.forEach(l => {
    const src = devices.find(d => d.id === l.source);
    const tgt = devices.find(d => d.id === l.target);
    const srcName = src?.name || l.source;
    const tgtName = tgt?.name || l.target;

    const li = document.createElement('li');

    const icon = document.createElement('span');
    icon.className = 'link-icon';
    icon.textContent = '—';

    const info = document.createElement('div');
    info.className = 'link-info';
    info.innerHTML = `<div class="link-endpoints">${escHtml(srcName)} ↔ ${escHtml(tgtName)}</div>${l.label ? `<div class="link-label-text">${escHtml(l.label)}</div>` : ''}`;

    const delBtn = document.createElement('button');
    delBtn.className = 'link-delete-btn';
    delBtn.title = 'Delete link';
    delBtn.textContent = '✕';
    delBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      deleteLink(l.id).then(() => {
        links = links.filter(x => x.id !== l.id);
        visEdges.remove(l.id);
        renderLinkList();
        toast('Link removed', 'info');
      }).catch(err => toast(err.message, 'error'));
    });

    li.append(icon, info, delBtn);
    li.addEventListener('click', () => openLinkEditModal(l.id));
    ul.appendChild(li);
  });
}

function renderStats() {
  const counts = { up: 0, down: 0, unknown: 0 };
  devices.forEach(d => { counts[d.status || 'unknown'] = (counts[d.status || 'unknown'] || 0) + 1; });
  document.getElementById('up-count').textContent = counts.up;
  document.getElementById('down-count').textContent = counts.down;
  document.getElementById('unknown-count').textContent = counts.unknown;
}

function selectDevice(id) {
  selectedId = id;
  if (id && network) {
    network.selectNodes([id], true);
    network.focus(id, { animation: { duration: 400, easingFunction: 'easeInOutQuad' }, scale: 1.2 });
  }
  renderSidebar(document.getElementById('search-input').value);
}

// ---- API helpers ----
async function fetchDevices() {
  const res = await fetch('/api/devices');
  devices = await res.json();
}

async function fetchLinks() {
  const res = await fetch('/api/links');
  links = await res.json();
}

async function addDevice(data) {
  const res = await fetch('/api/devices', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error || 'Failed to add device');
  return json;
}

async function updateDevice(id, data) {
  const res = await fetch(`/api/devices/${id}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error || 'Failed to update device');
  return json;
}

async function deleteDevice(id) {
  const res = await fetch(`/api/devices/${id}`, { method: 'DELETE' });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error || 'Failed to delete device');
  return json;
}

async function addLink(data) {
  const res = await fetch('/api/links', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error || 'Failed to create link');
  return json;
}

async function updateLink(id, data) {
  const res = await fetch(`/api/links/${id}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error || 'Failed to update link');
  return json;
}

async function deleteLink(id) {
  const res = await fetch(`/api/links/${id}`, { method: 'DELETE' });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error || 'Failed to delete link');
  return json;
}

async function scanSubnet(subnet, group) {
  const res = await fetch('/api/scan', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ subnet, group }),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error || 'Scan failed');
  return json;
}

// ---- Modals ----
function openAddModal() {
  document.getElementById('form-add').reset();
  document.getElementById('add-error').textContent = '';
  document.getElementById('modal-add').hidden = false;
}
function closeAddModal() { document.getElementById('modal-add').hidden = true; }

function openEditModal(deviceId) {
  const d = devices.find(x => x.id === deviceId);
  if (!d) return;
  selectDevice(deviceId);
  const form = document.getElementById('form-edit');
  form.elements['id'].value = d.id;
  form.elements['name'].value = d.name;
  form.elements['ip'].value = d.ip;
  form.elements['group'].value = d.group || '';
  form.elements['notes'].value = d.notes || '';
  document.getElementById('edit-error').textContent = '';
  document.getElementById('modal-edit').hidden = false;
}
function closeEditModal() { document.getElementById('modal-edit').hidden = true; }

function openLinkEditModal(linkId) {
  const l = links.find(x => x.id === linkId);
  if (!l) return;
  const src = devices.find(d => d.id === l.source);
  const tgt = devices.find(d => d.id === l.target);
  document.getElementById('link-edit-desc').textContent =
    `${src?.name || l.source}  ↔  ${tgt?.name || l.target}`;
  const form = document.getElementById('form-link-edit');
  form.elements['id'].value = l.id;
  form.elements['label'].value = l.label || '';
  document.getElementById('link-edit-error').textContent = '';
  document.getElementById('modal-link-edit').hidden = false;
  // Highlight the edge
  if (network) network.selectEdges([linkId]);
}
function closeLinkEditModal() { document.getElementById('modal-link-edit').hidden = true; }

// ---- Scan subnet modal ----
function openScanModal() {
  document.getElementById('form-scan').reset();
  document.getElementById('form-scan').hidden = false;
  document.getElementById('scan-error').textContent = '';
  document.getElementById('scan-progress').hidden = true;
  document.getElementById('scan-results').hidden = true;
  document.getElementById('modal-scan').hidden = false;
}
function closeScanModal() { document.getElementById('modal-scan').hidden = true; }

function _scanShowForm() {
  document.getElementById('form-scan').hidden = false;
  document.getElementById('scan-progress').hidden = true;
  document.getElementById('scan-results').hidden = true;
}
function _scanShowProgress(subnet) {
  document.getElementById('form-scan').hidden = true;
  document.getElementById('scan-progress').hidden = false;
  document.getElementById('scan-results').hidden = true;
  document.getElementById('scan-progress-msg').textContent = `Scanning ${subnet} — please wait…`;
}
function _scanShowResults(result, subnet) {
  document.getElementById('form-scan').hidden = true;
  document.getElementById('scan-progress').hidden = true;
  document.getElementById('scan-results').hidden = false;
  const { added, skipped, unreachable, total_scanned } = result;
  const parts = [];
  if (added.length)    parts.push(`<span class="scan-stat-up">✓ ${added.length} device${added.length !== 1 ? 's' : ''} added</span>`);
  else                 parts.push(`<span class="scan-stat-none">No new devices found</span>`);
  if (skipped.length)  parts.push(`<span class="scan-stat-skip">${skipped.length} already existed</span>`);
  parts.push(`<span class="scan-stat-down">${unreachable} unreachable</span>`);
  parts.push(`<span class="scan-stat-info">${total_scanned} IPs scanned in ${subnet}</span>`);
  document.getElementById('scan-results-text').innerHTML = parts.join('<br>');
}

// ---- SSE ----
function connectSSE() {
  const es = new EventSource('/api/events');

  es.addEventListener('status', (e) => {
    statuses = JSON.parse(e.data);
    renderAll();
  });

  es.addEventListener('device_added', (e) => {
    const d = JSON.parse(e.data);
    if (!devices.find(x => x.id === d.id)) devices.push(d);
    renderAll();
    toast(`Device "${d.name}" added`, 'success');
  });

  es.addEventListener('device_removed', (e) => {
    const { id } = JSON.parse(e.data);
    devices = devices.filter(d => d.id !== id);
    _deletePosition(id);
    renderAll();
  });

  es.addEventListener('device_updated', (e) => {
    const updated = JSON.parse(e.data);
    const idx = devices.findIndex(d => d.id === updated.id);
    if (idx !== -1) { devices[idx] = { ...devices[idx], ...updated }; renderAll(); }
  });

  es.addEventListener('link_added', (e) => {
    const l = JSON.parse(e.data);
    if (!links.find(x => x.id === l.id)) links.push(l);
    visEdges.update(edgeOptions(l));
    renderLinkList();
  });

  es.addEventListener('link_removed', (e) => {
    const { id } = JSON.parse(e.data);
    links = links.filter(l => l.id !== id);
    visEdges.remove(id);
    renderLinkList();
  });

  es.addEventListener('link_updated', (e) => {
    const updated = JSON.parse(e.data);
    const idx = links.findIndex(l => l.id === updated.id);
    if (idx !== -1) { links[idx] = { ...links[idx], ...updated }; }
    visEdges.update(edgeOptions(updated));
    renderLinkList();
  });
}

// ---- Toast ----
function toast(msg, type = 'info', duration = 3000) {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = msg;
  document.getElementById('toast-container').appendChild(el);
  setTimeout(() => el.remove(), duration);
}

// ---- Utility ----
function escHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function formToObj(form) {
  const obj = {};
  new FormData(form).forEach((v, k) => { obj[k] = v; });
  return obj;
}

// ---- Sidebar tabs ----
document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach(p => p.hidden = true);
    btn.classList.add('active');
    document.getElementById(`tab-${btn.dataset.tab}`).hidden = false;
  });
});

// ---- Link mode controls ----
document.getElementById('btn-link-mode').addEventListener('click', () => setLinkMode(!linkMode));
document.getElementById('btn-link-cancel').addEventListener('click', () => setLinkMode(false));

// ---- Device modal controls ----
document.getElementById('btn-add-open').addEventListener('click', openAddModal);
document.getElementById('btn-add-cancel').addEventListener('click', closeAddModal);
document.getElementById('btn-edit-cancel').addEventListener('click', closeEditModal);

// ---- Scan subnet controls ----
document.getElementById('btn-scan-open').addEventListener('click', openScanModal);
document.getElementById('btn-scan-cancel').addEventListener('click', closeScanModal);
document.getElementById('btn-scan-done').addEventListener('click', closeScanModal);
document.getElementById('btn-scan-again').addEventListener('click', _scanShowForm);

document.getElementById('form-scan').addEventListener('submit', async (e) => {
  e.preventDefault();
  const data = formToObj(e.target);
  const subnet = data.subnet.trim();
  const group  = (data.group || '').trim();
  document.getElementById('scan-error').textContent = '';
  _scanShowProgress(subnet);
  try {
    const result = await scanSubnet(subnet, group);
    _scanShowResults(result, subnet);
    if (result.added.length > 0) {
      toast(`Subnet scan: ${result.added.length} device${result.added.length !== 1 ? 's' : ''} added`, 'success', 5000);
    } else {
      toast('Scan complete — no new devices found', 'info');
    }
  } catch (err) {
    _scanShowForm();
    document.getElementById('scan-error').textContent = err.message;
  }
});

// ---- Link modal controls ----
document.getElementById('btn-link-edit-cancel').addEventListener('click', closeLinkEditModal);

document.getElementById('btn-link-delete').addEventListener('click', async () => {
  const id = document.getElementById('form-link-edit').elements['id'].value;
  try {
    await deleteLink(id);
    links = links.filter(l => l.id !== id);
    visEdges.remove(id);
    renderLinkList();
    closeLinkEditModal();
    toast('Link deleted', 'info');
  } catch (err) {
    document.getElementById('link-edit-error').textContent = err.message;
  }
});

document.getElementById('form-link-edit').addEventListener('submit', async (e) => {
  e.preventDefault();
  const data = formToObj(e.target);
  const id = data.id; delete data.id;
  try {
    const updated = await updateLink(id, data);
    const idx = links.findIndex(l => l.id === id);
    if (idx !== -1) links[idx] = { ...links[idx], ...updated };
    visEdges.update(edgeOptions(links[idx] || updated));
    renderLinkList();
    closeLinkEditModal();
    toast('Link updated', 'success');
  } catch (err) {
    document.getElementById('link-edit-error').textContent = err.message;
  }
});

// ---- Close modals on overlay click ----
['modal-add', 'modal-edit', 'modal-link-edit', 'modal-scan'].forEach(id => {
  document.getElementById(id).addEventListener('click', (e) => {
    if (e.target === e.currentTarget) e.currentTarget.hidden = true;
  });
});

document.getElementById('form-add').addEventListener('submit', async (e) => {
  e.preventDefault();
  const errEl = document.getElementById('add-error');
  errEl.textContent = '';
  try {
    await addDevice(formToObj(e.target));
    closeAddModal();
  } catch (err) { errEl.textContent = err.message; }
});

document.getElementById('form-edit').addEventListener('submit', async (e) => {
  e.preventDefault();
  const data = formToObj(e.target);
  const id = data.id; delete data.id;
  const errEl = document.getElementById('edit-error');
  errEl.textContent = '';
  try {
    await updateDevice(id, data);
    closeEditModal();
  } catch (err) { errEl.textContent = err.message; }
});

document.getElementById('btn-delete').addEventListener('click', async () => {
  const id = document.getElementById('form-edit').elements['id'].value;
  const d = devices.find(x => x.id === id);
  if (!d || !confirm(`Delete "${d.name}"?`)) return;
  try {
    await deleteDevice(id);
    closeEditModal();
  } catch (err) { document.getElementById('edit-error').textContent = err.message; }
});

document.getElementById('search-input').addEventListener('input', (e) => {
  renderSidebar(e.target.value);
});

// ---- Init ----
(async () => {
  _loadPositions();
  initNetwork();
  await Promise.all([fetchDevices(), fetchLinks()]);
  renderAll();
  connectSSE();
})();

