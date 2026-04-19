# Deployment Guide

Two deployment options are covered:

1. **Docker on Linux / WSL** — build and run locally
2. **Synology NAS** — push to Docker Hub, pull and run on the NAS

---

## Option 1 — Docker (Linux host or WSL)

### Prerequisites

- Docker Engine 24+ and Docker Compose v2
- Linux host or WSL2 Ubuntu
- User must be in the `docker` group (or use `sudo`)

### One-time WSL Docker setup

```bash
# Install Docker Engine (if not already installed)
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER

# Start the daemon and activate the new group in the current shell
sudo service docker start
newgrp docker
```

### Build and run

```bash
cd /mnt/c/Users/<you>/OneDrive/lab/icmp-network-map   # adjust path

# Create the data directory (persists devices.json, links.json, TLS certs)
mkdir -p data

# Build the image and start the container
docker compose build
docker compose up -d

# Watch logs
docker compose logs -f
```

Open **http://localhost:5000** (or **https://localhost:5000** if HTTPS is enabled).

### Useful commands

```bash
# Stop
docker compose down

# Rebuild after code changes
docker compose build ; docker compose up -d --force-recreate

# Shell into running container
docker compose exec icmp-network-map sh
```

### Why `network_mode: host`?

ICMP raw sockets need direct access to the host's network interfaces.  
`network_mode: host` + `cap_add: [NET_RAW, NET_ADMIN]` + `user: "0"` gives the container that access reliably across all kernel versions.

> **Docker Desktop on Windows / macOS**: `network_mode: host` connects to the
> Docker Desktop Linux VM, **not** your physical machine's interfaces.  
> Use WSL2 with Docker Engine (not Docker Desktop) to reach your real LAN,
> or run the app with plain `python app.py` instead.

---

## Option 2 — Synology NAS (Container Manager)

Synology DSM runs Linux, so `network_mode: host` and raw ICMP capabilities work natively.

### Prerequisites

- DSM 7.2+ with **Container Manager** installed (Package Center)
- SSH access to the NAS
- Docker Hub account (image is pushed to `garykoys/icmp-network-map:latest`)

---

### Step 1 — Build and push the image (from WSL)

```bash
cd /mnt/c/Users/<you>/OneDrive/lab/icmp-network-map

# Build
docker compose build

# Log in and push
docker login -u garykoys
docker compose push
```

---

### Step 2 — Prepare the NAS

```bash
# Create project and data folders
ssh garyk@192.168.119.10 "mkdir -p /volume1/docker/icmp-network-map/data"

# Seed your existing device and link data
scp data/devices.json garyk@192.168.119.10:/volume1/docker/icmp-network-map/data/devices.json
scp data/links.json   garyk@192.168.119.10:/volume1/docker/icmp-network-map/data/links.json

# Copy the Synology compose file
scp docker-compose.synology.yml garyk@192.168.119.10:/volume1/docker/icmp-network-map/docker-compose.yml
```

---

### Step 3 — Start on the NAS

```bash
ssh garyk@192.168.119.10
cd /volume1/docker/icmp-network-map

docker compose pull
docker compose up -d
docker compose logs -f
```

Open **https://192.168.119.10:5000** in your browser.  
Accept the self-signed certificate warning on first visit (click **Advanced → Proceed**).

---

### Step 4 — Update (after a code change)

```bash
# On WSL — rebuild and push new image
docker compose build ; docker compose push

# On the NAS — pull and restart
ssh garyk@192.168.119.10
cd /volume1/docker/icmp-network-map
docker compose pull
docker compose up -d --force-recreate
```

---

### HTTPS / TLS

HTTPS is enabled by default in `docker-compose.synology.yml` (`FLASK_HTTPS: "true"`).

On the **first boot**, the app auto-generates a self-signed RSA-2048 certificate and saves it to:

```
/volume1/docker/icmp-network-map/data/cert.pem
/volume1/docker/icmp-network-map/data/key.pem
```

The cert includes Subject Alternative Names for `localhost`, `127.0.0.1`, and the container's LAN IP.  
It persists across restarts so you only see the browser warning once.

**To use your own certificate:** place your `cert.pem` and `key.pem` in the data directory before starting the container — the app will use them instead of generating new ones.

**To disable HTTPS:** set `FLASK_HTTPS: "false"` in `docker-compose.yml` and access via `http://`.

---

### ICMP / Ping

The container runs as `user: "0"` (root) with `cap_add: [NET_RAW, NET_ADMIN]`.  
The pinger attempts ICMP in this order:

1. **Unprivileged ICMP** (`SOCK_DGRAM`) — works on modern kernels without root
2. **Privileged ICMP** (`SOCK_RAW`) — requires `CAP_NET_RAW`
3. **subprocess ping** — OS `ping` binary fallback

Running as root with `NET_RAW` guarantees all three methods work.

---

### Data persistence

All runtime data lives in the mounted volume:

| File | Contents |
|------|----------|
| `/volume1/docker/icmp-network-map/data/devices.json` | Device list |
| `/volume1/docker/icmp-network-map/data/links.json` | Topology links |
| `/volume1/docker/icmp-network-map/data/cert.pem` | TLS certificate |
| `/volume1/docker/icmp-network-map/data/key.pem` | TLS private key |

Data survives container restarts, image updates, and `docker compose down`.

---

### Port conflicts

If port 5000 conflicts with another DSM service, change `FLASK_PORT` in `docker-compose.yml`:

```yaml
environment:
  FLASK_PORT: "5001"
```

Then open that port in **DSM → Control Panel → Security → Firewall** if the firewall is enabled.

---

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `DEVICES_FILE` | `./devices.json` | Path to the devices JSON file |
| `LINKS_FILE` | `./links.json` | Path to the links JSON file |
| `FLASK_HOST` | `0.0.0.0` | Bind address |
| `FLASK_PORT` | `5000` | Listen port |
| `PING_INTERVAL` | `10` | Seconds between ping sweeps |
| `FLASK_HTTPS` | `false` | Set to `true` to enable HTTPS with a self-signed certificate |

---

## Security Hardening

The following measures are built into the application. No extra configuration is required.

### HTTP Security Headers

Every HTTP/HTTPS response includes:

| Header | Value |
|---|---|
| `X-Content-Type-Options` | `nosniff` |
| `X-Frame-Options` | `DENY` |
| `Referrer-Policy` | `no-referrer` |
| `Content-Security-Policy` | scripts: self + unpkg.com; styles: self + inline; connect: self; all else blocked |

### Input Validation

- **IP addresses** are validated with Python's `ipaddress` module on every add/update. Invalid values return `400`.
- **Field length limits**: name/group ≤ 64 chars, notes ≤ 256 chars, link label ≤ 64 chars.
- **Subnet** CIDR validated and capped at `/22` (1,024 hosts).

### XSS Prevention

All user-supplied data (device name, IP, group, notes, link labels) is HTML-escaped before being rendered in the browser or vis.js tooltips.

### Network Exposure

- The app has **no authentication**. It is designed for trusted LAN use only.
- **Do not expose port 5000 to the internet** via port forwarding or reverse proxy without adding authentication in front (e.g. nginx + HTTP basic auth, or a VPN).
- On Synology, ensure DSM's firewall restricts port 5000 to your LAN subnet only:  
  **DSM → Control Panel → Security → Firewall → Edit Rules → Source IP → Specific IP → subnet**.
