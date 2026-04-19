"""
app.py — Flask web server for ICMP Network Map.
Serves the UI and provides REST API + SSE for device management and live status.
"""

import datetime
import ipaddress
import json
import os
import queue
import socket
import threading
import time
import uuid
from flask import Flask, request, jsonify, render_template, Response, stream_with_context
import pinger

app = Flask(__name__)

# ---------------------------------------------------------------------------
# Security headers
# ---------------------------------------------------------------------------

@app.after_request
def add_security_headers(response):
    # Prevent MIME-type sniffing
    response.headers["X-Content-Type-Options"] = "nosniff"
    # Disallow embedding in iframes (clickjacking protection)
    response.headers["X-Frame-Options"] = "DENY"
    # Don't send Referer header to third parties
    response.headers["Referrer-Policy"] = "no-referrer"
    # Content Security Policy:
    #   - scripts: only self + unpkg CDN (vis.js)
    #   - styles:  only self + unsafe-inline (vis.js injects inline styles)
    #   - connect: only self (SSE + REST API)
    #   - everything else blocked
    response.headers["Content-Security-Policy"] = (
        "default-src 'self'; "
        "script-src 'self' https://unpkg.com; "
        "style-src 'self' 'unsafe-inline'; "
        "img-src 'self' data:; "
        "connect-src 'self'; "
        "font-src 'self'; "
        "object-src 'none'; "
        "base-uri 'self';"
    )
    return response

# Support override via environment variable (used in Docker / Ubuntu deployment)
_BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DEVICES_FILE = os.environ.get("DEVICES_FILE", os.path.join(_BASE_DIR, "devices.json"))
LINKS_FILE   = os.environ.get("LINKS_FILE",   os.path.join(_BASE_DIR, "links.json"))

# SSE subscriber queues: list of Queue objects, one per connected browser tab
_sse_clients: list[queue.Queue] = []
_sse_lock = threading.Lock()

# ---------------------------------------------------------------------------
# Device persistence helpers
# ---------------------------------------------------------------------------

def load_devices() -> list[dict]:
    if os.path.exists(DEVICES_FILE):
        with open(DEVICES_FILE, "r", encoding="utf-8") as f:
            try:
                return json.load(f)
            except json.JSONDecodeError:
                return []
    return []


def save_devices(devices: list[dict]):
    with open(DEVICES_FILE, "w", encoding="utf-8") as f:
        json.dump(devices, f, indent=2)


def load_links() -> list[dict]:
    if os.path.exists(LINKS_FILE):
        with open(LINKS_FILE, "r", encoding="utf-8") as f:
            try:
                return json.load(f)
            except json.JSONDecodeError:
                return []
    return []


def save_links(links: list[dict]):
    with open(LINKS_FILE, "w", encoding="utf-8") as f:
        json.dump(links, f, indent=2)


# ---------------------------------------------------------------------------
# SSE helpers
# ---------------------------------------------------------------------------

def _broadcast(event_type: str, data: dict):
    """Push an SSE event to all connected clients."""
    payload = json.dumps(data)
    msg = f"event: {event_type}\ndata: {payload}\n\n"
    with _sse_lock:
        dead = []
        for q in _sse_clients:
            try:
                q.put_nowait(msg)
            except queue.Full:
                dead.append(q)
        for q in dead:
            _sse_clients.remove(q)


def _status_broadcast_loop():
    """Periodically push device statuses to all SSE clients."""
    while True:
        time.sleep(pinger.PING_INTERVAL)
        statuses = pinger.get_status()
        _broadcast("status", statuses)


# ---------------------------------------------------------------------------
# REST API
# ---------------------------------------------------------------------------

@app.get("/api/devices")
def api_get_devices():
    devices = load_devices()
    statuses = pinger.get_status()
    for d in devices:
        s = statuses.get(d["id"], {})
        d["status"] = s.get("status", "unknown")
        d["latency"] = s.get("latency")
        d["last_checked"] = s.get("last_checked")
    return jsonify(devices)


@app.post("/api/devices")
def api_add_device():
    data = request.get_json(force=True)
    name = (data.get("name") or "").strip()
    ip = (data.get("ip") or "").strip()
    group = (data.get("group") or "").strip()
    notes = (data.get("notes") or "").strip()

    if not name or not ip:
        return jsonify({"error": "name and ip are required"}), 400

    # Validate field lengths
    if len(name) > 64 or len(group) > 64 or len(notes) > 256:
        return jsonify({"error": "name/group must be ≤64 chars; notes ≤256 chars"}), 400

    # Validate IP address
    try:
        ipaddress.ip_address(ip)
    except ValueError:
        return jsonify({"error": f"Invalid IP address: {ip}"}), 400

    devices = load_devices()
    # Check for duplicate IP
    if any(d["ip"] == ip for d in devices):
        return jsonify({"error": f"Device with IP {ip} already exists"}), 409

    device = {"id": str(uuid.uuid4()), "name": name, "ip": ip, "group": group, "notes": notes}
    devices.append(device)
    save_devices(devices)
    pinger.update_device_ids(devices)

    # Trigger an immediate ping for the new device
    alive, latency = pinger.ping_device(ip)
    import time as _time
    with pinger._status_lock:
        pinger._status[device["id"]] = {
            "status": "up" if alive else "down",
            "latency": latency,
            "last_checked": _time.time(),
        }

    _broadcast("device_added", device)
    _broadcast("status", pinger.get_status())
    return jsonify(device), 201


@app.delete("/api/devices/<device_id>")
def api_delete_device(device_id: str):
    devices = load_devices()
    new_devices = [d for d in devices if d["id"] != device_id]
    if len(new_devices) == len(devices):
        return jsonify({"error": "Device not found"}), 404
    save_devices(new_devices)
    pinger.update_device_ids(new_devices)

    # Cascade: remove all links involving this device
    links = load_links()
    removed_link_ids = [l["id"] for l in links if l["source"] == device_id or l["target"] == device_id]
    new_links = [l for l in links if l["id"] not in removed_link_ids]
    save_links(new_links)
    for lid in removed_link_ids:
        _broadcast("link_removed", {"id": lid})

    _broadcast("device_removed", {"id": device_id})
    return jsonify({"deleted": device_id})


@app.put("/api/devices/<device_id>")
def api_update_device(device_id: str):
    data = request.get_json(force=True)
    devices = load_devices()
    device = next((d for d in devices if d["id"] == device_id), None)
    if not device:
        return jsonify({"error": "Device not found"}), 404

    new_name  = (data.get("name")  or device["name"]).strip()
    new_ip    = (data.get("ip")    or device["ip"]).strip()
    new_group = (data.get("group") or "").strip()
    new_notes = (data.get("notes") or "").strip()

    if len(new_name) > 64 or len(new_group) > 64 or len(new_notes) > 256:
        return jsonify({"error": "name/group must be ≤64 chars; notes ≤256 chars"}), 400

    try:
        ipaddress.ip_address(new_ip)
    except ValueError:
        return jsonify({"error": f"Invalid IP address: {new_ip}"}), 400

    device["name"]  = new_name
    device["ip"]    = new_ip
    device["group"] = new_group
    device["notes"] = new_notes
    save_devices(devices)
    _broadcast("device_updated", device)
    return jsonify(device)


@app.post("/api/devices/<device_id>/ping")
def api_ping_now(device_id: str):
    """Trigger an on-demand ping for a specific device."""
    devices = load_devices()
    device = next((d for d in devices if d["id"] == device_id), None)
    if not device:
        return jsonify({"error": "Device not found"}), 404
    alive, latency = pinger.ping_device(device["ip"])
    import time as _time
    entry = {
        "status": "up" if alive else "down",
        "latency": latency,
        "last_checked": _time.time(),
    }
    with pinger._status_lock:
        pinger._status[device_id] = entry
    _broadcast("status", pinger.get_status())
    return jsonify(entry)


# ---------------------------------------------------------------------------
# Subnet scan API
# ---------------------------------------------------------------------------

@app.post("/api/scan")
def api_scan_subnet():
    data = request.get_json(force=True)
    subnet_str = (data.get("subnet") or "").strip()
    group = (data.get("group") or "").strip()

    if not subnet_str:
        return jsonify({"error": "subnet is required"}), 400

    try:
        net = ipaddress.ip_network(subnet_str, strict=False)
    except ValueError as exc:
        return jsonify({"error": f"Invalid subnet: {exc}"}), 400

    host_ips = [str(ip) for ip in net.hosts()]
    if len(host_ips) == 0:
        return jsonify({"error": "Subnet contains no host addresses"}), 400
    if len(host_ips) > 1024:
        return jsonify({"error": "Subnet too large — maximum 1024 host addresses (/22)"}), 400

    scan_results = pinger.scan_subnet(host_ips)

    devices = load_devices()
    existing_ips = {d["ip"] for d in devices}

    added = []
    skipped = []
    unreachable = 0

    for ip in host_ips:
        result = scan_results.get(ip, {"alive": False, "latency": None})
        if not result["alive"]:
            unreachable += 1
            continue
        if ip in existing_ips:
            skipped.append(ip)
            continue
        device = {
            "id": str(uuid.uuid4()),
            "name": ip,
            "ip": ip,
            "group": group,
            "notes": f"Discovered via subnet scan ({subnet_str})",
        }
        devices.append(device)
        existing_ips.add(ip)
        with pinger._status_lock:
            pinger._status[device["id"]] = {
                "status": "up",
                "latency": result["latency"],
                "last_checked": time.time(),
            }
        added.append(device)
        _broadcast("device_added", device)

    if added:
        save_devices(devices)
        pinger.update_device_ids(devices)
        _broadcast("status", pinger.get_status())

    return jsonify({
        "added": added,
        "skipped": skipped,
        "unreachable": unreachable,
        "total_scanned": len(host_ips),
    })


# ---------------------------------------------------------------------------
# Links API
# ---------------------------------------------------------------------------

@app.get("/api/links")
def api_get_links():
    return jsonify(load_links())


@app.post("/api/links")
def api_add_link():
    data = request.get_json(force=True)
    source = (data.get("source") or "").strip()
    target = (data.get("target") or "").strip()
    label  = (data.get("label") or "").strip()

    if not source or not target:
        return jsonify({"error": "source and target device IDs are required"}), 400
    if source == target:
        return jsonify({"error": "Cannot link a device to itself"}), 400
    if len(label) > 64:
        return jsonify({"error": "label must be ≤64 chars"}), 400

    # Validate both devices exist
    devices = load_devices()
    ids = {d["id"] for d in devices}
    if source not in ids or target not in ids:
        return jsonify({"error": "One or both device IDs not found"}), 404

    links = load_links()
    # Prevent duplicate links (regardless of direction)
    if any((l["source"] == source and l["target"] == target) or
           (l["source"] == target and l["target"] == source) for l in links):
        return jsonify({"error": "Link already exists between these devices"}), 409

    link = {"id": str(uuid.uuid4()), "source": source, "target": target, "label": label}
    links.append(link)
    save_links(links)
    _broadcast("link_added", link)
    return jsonify(link), 201


@app.delete("/api/links/<link_id>")
def api_delete_link(link_id: str):
    links = load_links()
    new_links = [l for l in links if l["id"] != link_id]
    if len(new_links) == len(links):
        return jsonify({"error": "Link not found"}), 404
    save_links(new_links)
    _broadcast("link_removed", {"id": link_id})
    return jsonify({"deleted": link_id})


@app.put("/api/links/<link_id>")
def api_update_link(link_id: str):
    data = request.get_json(force=True)
    links = load_links()
    link = next((l for l in links if l["id"] == link_id), None)
    if not link:
        return jsonify({"error": "Link not found"}), 404
    link["label"] = (data.get("label") or "").strip()
    save_links(links)
    _broadcast("link_updated", link)
    return jsonify(link)


# ---------------------------------------------------------------------------
# SSE endpoint
# ---------------------------------------------------------------------------

@app.get("/api/events")
def api_events():
    def stream():
        q: queue.Queue = queue.Queue(maxsize=50)
        with _sse_lock:
            _sse_clients.append(q)
        # Send initial status immediately
        statuses = pinger.get_status()
        yield f"event: status\ndata: {json.dumps(statuses)}\n\n"
        try:
            while True:
                try:
                    msg = q.get(timeout=30)
                    yield msg
                except queue.Empty:
                    yield ": heartbeat\n\n"
        except GeneratorExit:
            pass
        finally:
            with _sse_lock:
                try:
                    _sse_clients.remove(q)
                except ValueError:
                    pass

    return Response(
        stream_with_context(stream()),
        mimetype="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
        },
    )


# ---------------------------------------------------------------------------
# Main UI
# ---------------------------------------------------------------------------

@app.get("/")
def index():
    return render_template("index.html")


# ---------------------------------------------------------------------------
# TLS helpers
# ---------------------------------------------------------------------------

def _generate_self_signed_cert(cert_path: str, key_path: str):
    """Generate a self-signed RSA certificate and write PEM files to disk."""
    from cryptography import x509
    from cryptography.x509.oid import NameOID
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import rsa

    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)

    # Build Subject Alternative Names: localhost, 127.0.0.1, and the host's LAN IP.
    san_entries = [
        x509.DNSName("localhost"),
        x509.IPAddress(ipaddress.IPv4Address("127.0.0.1")),
    ]
    try:
        lan_ip = socket.gethostbyname(socket.gethostname())
        san_entries.append(x509.IPAddress(ipaddress.IPv4Address(lan_ip)))
    except Exception:
        pass

    subject = issuer = x509.Name([
        x509.NameAttribute(NameOID.COMMON_NAME, "icmp-network-map"),
    ])
    cert = (
        x509.CertificateBuilder()
        .subject_name(subject)
        .issuer_name(issuer)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(datetime.datetime.now(datetime.timezone.utc))
        .not_valid_after(datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(days=3650))
        .add_extension(x509.SubjectAlternativeName(san_entries), critical=False)
        .sign(key, hashes.SHA256())
    )
    with open(key_path, "wb") as f:
        f.write(key.private_bytes(
            serialization.Encoding.PEM,
            serialization.PrivateFormat.TraditionalOpenSSL,
            serialization.NoEncryption(),
        ))
    with open(cert_path, "wb") as f:
        f.write(cert.public_bytes(serialization.Encoding.PEM))


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    # Start background pinger
    pinger.start_pinger(load_devices)

    # Start SSE broadcast loop
    t = threading.Thread(target=_status_broadcast_loop, daemon=True)
    t.start()

    host = os.environ.get("FLASK_HOST", "0.0.0.0")
    port = int(os.environ.get("FLASK_PORT", 5000))
    https_enabled = os.environ.get("FLASK_HTTPS", "false").lower() == "true"

    ssl_context = None
    if https_enabled:
        data_dir = os.path.dirname(os.path.abspath(DEVICES_FILE))
        cert_path = os.path.join(data_dir, "cert.pem")
        key_path  = os.path.join(data_dir, "key.pem")
        if not os.path.exists(cert_path) or not os.path.exists(key_path):
            print("  Generating self-signed TLS certificate...")
            _generate_self_signed_cert(cert_path, key_path)
            print(f"  Certificate saved to {cert_path}")
        ssl_context = (cert_path, key_path)

    scheme = "https" if https_enabled else "http"
    display_host = host if host != "0.0.0.0" else "localhost"
    print("=" * 60)
    print("  ICMP Network Map")
    print(f"  {scheme}://{display_host}:{port}")
    print("  Press Ctrl+C to stop")
    print("=" * 60)
    app.run(host=host, port=port, debug=False, use_reloader=False, ssl_context=ssl_context)
