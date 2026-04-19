# ICMP Network Map

A lightweight web application that monitors network device **up/down** status using ICMP ping and displays a live topology map in the browser.

---

## Features

- **Live topology map** — interactive vis.js graph showing all devices and links
- **Real-time status** — Server-Sent Events push ping results every 10 seconds
- **Subnet scanner** — enter a CIDR (e.g. `192.168.1.0/24`), ping every host in parallel, and add all reachable devices to the map in one step
- **Add / Edit / Delete** devices manually via the browser UI
- **Link management** — draw connections between devices in Link Mode; label each link (e.g. `1Gbps`, `WAN`)
- **Latency display** on each node and in the sidebar
- **On-demand ping** — REST endpoint to ping a single device immediately
- **HTTPS** — optional self-signed TLS; certificate is auto-generated on first boot and persisted to the data volume
- **Security hardened** — HTTP security headers (CSP, X-Frame-Options, X-Content-Type-Options), IP address validation, input length limits, XSS-safe tooltips
- **Persistent storage** — device list, links, and TLS cert saved to JSON/PEM files, mounted as a volume in Docker so data survives container restarts and upgrades
- **Dark UI** — clean dark-mode interface

---

## Requirements

- Python 3.11+
- **Administrator / root privileges** are required for raw ICMP sockets on Windows and Linux.  
  If not running as admin, the app automatically falls back to `subprocess` ping.

---

## Quick Start (local Python)

### 1. Install dependencies

```bash
pip install -r requirements.txt
```

### 2. Run the server (as Administrator on Windows)

```bash
python app.py
```

### 3. Open in browser

```
http://localhost:5000
```

To enable HTTPS locally:

```bash
set FLASK_HTTPS=true   # Windows
# or
export FLASK_HTTPS=true  # Linux/macOS
python app.py
# then open https://localhost:5000
```

---

## Docker

### Run locally with Docker Compose

```bash
mkdir -p data
docker compose up -d --build
```

Data is persisted to `./data/` on the host — restarting or rebuilding the container does not affect it.

### Deploy to Synology NAS

See [DEPLOY.md](DEPLOY.md) for full Synology deployment instructions.

---

## Project Structure

```
icmp-network-map/
├── app.py                          # Flask server — REST API, SSE, HTTPS, static serving
├── pinger.py                       # Background ICMP ping engine + subnet scanner
├── requirements.txt                # Python dependencies (flask, icmplib, cryptography)
├── Dockerfile                      # Multi-stage Docker image (python:3.13-slim)
├── docker-compose.yml              # Local / Linux Docker Compose
├── docker-compose.synology.yml     # Synology NAS Docker Compose
├── data/                           # Runtime data (volume-mounted in Docker)
│   ├── devices.json                # Persisted device list
│   ├── links.json                  # Persisted topology links
│   ├── cert.pem                    # Auto-generated TLS certificate (created on first HTTPS boot)
│   └── key.pem                     # Auto-generated TLS private key
├── templates/
│   └── index.html                  # Main UI page
└── static/
    ├── style.css                   # Dark-mode styles
    └── app.js                      # Frontend logic (vis.js topology + SSE)
```

---

## REST API

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/devices` | List all devices with current status |
| `POST` | `/api/devices` | Add a device `{ name, ip, group?, notes? }` |
| `PUT` | `/api/devices/<id>` | Update a device |
| `DELETE` | `/api/devices/<id>` | Remove a device (cascades to links) |
| `POST` | `/api/devices/<id>/ping` | Trigger an immediate ping |
| `POST` | `/api/scan` | Scan a subnet `{ subnet, group? }` — pings all hosts in parallel and adds reachable ones |
| `GET` | `/api/links` | List all topology links |
| `POST` | `/api/links` | Add a link `{ source, target, label? }` |
| `PUT` | `/api/links/<id>` | Update a link label |
| `DELETE` | `/api/links/<id>` | Remove a link |
| `GET` | `/api/events` | SSE stream of live status / device / link events |

---

## Configuration

All settings can be overridden via environment variables (supported in Docker Compose and systemd):

| Variable | Default | Description |
|---|---|---|
| `DEVICES_FILE` | `./devices.json` | Path to the devices JSON file |
| `LINKS_FILE` | `./links.json` | Path to the links JSON file |
| `FLASK_HOST` | `0.0.0.0` | Bind address |
| `FLASK_PORT` | `5000` | Listen port |
| `PING_INTERVAL` | `10` | Seconds between ping sweeps |
| `FLASK_HTTPS` | `false` | Set to `true` to enable HTTPS with a self-signed certificate |

---

## HTTPS / TLS

When `FLASK_HTTPS=true`, the app:

1. Looks for `cert.pem` and `key.pem` in the same directory as `DEVICES_FILE` (i.e. `/data/` in Docker).
2. If they don't exist, generates a self-signed RSA-2048 certificate valid for 10 years, including SANs for `localhost`, `127.0.0.1`, and the container's LAN IP.
3. Starts Flask with that certificate.

The files are written to the mounted volume so they persist across restarts — your browser only shows the "Not secure" warning on the very first visit.

To use your own certificate instead, place your `cert.pem` and `key.pem` in the data directory before starting the container.

---

## Notes

- On **Windows**, running as Administrator is recommended for ICMP raw sockets.  
  If not elevated, the app falls back to `subprocess ping` automatically.
- The pinger tries **unprivileged ICMP** (no root needed on modern Linux kernels) first, then privileged raw socket, then subprocess ping.
- Subnet scan accepts any valid CIDR up to `/22` (1024 hosts max).  
  Network and broadcast addresses are excluded automatically.
- Deleting a device also removes all links connected to it.

---

## Security

The following hardening measures are applied (based on OWASP Top 10):

### HTTP Security Headers

Every response includes:

| Header | Value | Purpose |
|---|---|---|
| `X-Content-Type-Options` | `nosniff` | Prevent MIME-type sniffing |
| `X-Frame-Options` | `DENY` | Block clickjacking via iframes |
| `Referrer-Policy` | `no-referrer` | No referer leakage |
| `Content-Security-Policy` | see below | Restrict script/style/connect sources |

CSP policy: scripts allowed from `self` + `unpkg.com` (vis.js CDN only); styles from `self` + inline (required by vis.js); all other sources blocked.

### Input Validation

- **IP address** — validated with `ipaddress.ip_address()` on add and update; invalid values return `400`.
- **Field lengths** — `name` / `group` ≤ 64 chars; `notes` ≤ 256 chars; link `label` ≤ 64 chars.
- **Subnet** — validated with `ipaddress.ip_network()`, capped at `/22` (1024 hosts).

### XSS Prevention

- All device data (name, IP, group, notes) is HTML-escaped with `escHtml()` before being inserted into the DOM or vis.js tooltips.

### Known Limitations (acceptable for home-lab use)

- No authentication — intended for trusted LAN use only. Do not expose port 5000 to the internet.
- No rate limiting on `/api/scan`.
- vis.js loaded from CDN without Subresource Integrity (SRI) hash.
