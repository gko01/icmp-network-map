"""
pinger.py — Background thread that pings all devices periodically.
Uses icmplib for ICMP ping (requires admin/elevated privileges on Windows).
Falls back to subprocess ping if icmplib fails.
"""

import subprocess
import threading
import time
import platform
import os
from concurrent.futures import ThreadPoolExecutor, as_completed
from typing import Dict

# Status store: { device_id: { "status": "up"|"down", "latency": float|None, "last_checked": float } }
_status: Dict[str, dict] = {}
_status_lock = threading.Lock()

PING_INTERVAL = int(os.environ.get("PING_INTERVAL", 10))  # seconds between ping rounds


def _ping_subprocess(ip: str) -> tuple[bool, float | None]:
    """Fallback ping using OS subprocess."""
    system = platform.system().lower()
    if system == "windows":
        cmd = ["ping", "-n", "1", "-w", "1000", ip]
    else:
        cmd = ["ping", "-c", "1", "-W", "1", ip]
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=3)
        alive = result.returncode == 0
        latency = None
        if alive:
            # Try to parse latency from output
            for line in result.stdout.splitlines():
                line_lower = line.lower()
                if "time=" in line_lower or "time<" in line_lower:
                    # Windows: "time=1ms" or "time<1ms"
                    # Linux:   "time=1.23 ms"
                    try:
                        part = line_lower.split("time")[1]
                        part = part.lstrip("=<").split()[0].replace("ms", "").strip()
                        latency = float(part)
                    except Exception:
                        pass
                    break
        return alive, latency
    except Exception:
        return False, None


def _ping_icmplib(ip: str) -> tuple[bool, float | None]:
    """Ping using icmplib. Tries unprivileged (SOCK_DGRAM) first, then
    privileged (SOCK_RAW). Unprivileged works for non-root users on Linux
    kernels where net.ipv4.ping_group_range is set (most modern distros)."""
    from icmplib import ping as icmp_ping
    try:
        host = icmp_ping(ip, count=1, timeout=2, privileged=False)
        if host.is_alive:
            return True, round(host.avg_rtt, 2)
        # got a response but host reported down — trust it
        return False, None
    except Exception:
        pass
    # Unprivileged failed — try raw socket (requires root or CAP_NET_RAW)
    host = icmp_ping(ip, count=1, timeout=2, privileged=True)
    if host.is_alive:
        return True, round(host.avg_rtt, 2)
    return False, None


def ping_device(ip: str) -> tuple[bool, float | None]:
    """Ping a device, trying icmplib first, falling back to subprocess."""
    try:
        return _ping_icmplib(ip)
    except Exception:
        return _ping_subprocess(ip)


def get_status() -> Dict[str, dict]:
    """Return a snapshot of the current device statuses."""
    with _status_lock:
        return dict(_status)


def get_device_status(device_id: str) -> dict | None:
    with _status_lock:
        return _status.get(device_id)


def update_device_ids(device_list: list[dict]):
    """
    Sync the status store with the current device list.
    Adds new devices and removes stale ones.
    """
    current_ids = {d["id"] for d in device_list}
    with _status_lock:
        # Remove devices no longer in the list
        stale = [k for k in _status if k not in current_ids]
        for k in stale:
            del _status[k]
        # Add new devices with unknown status
        for d in device_list:
            if d["id"] not in _status:
                _status[d["id"]] = {"status": "unknown", "latency": None, "last_checked": None}


def _ping_loop(get_devices_fn):
    """Main ping loop running in a background thread."""
    while True:
        devices = get_devices_fn()
        update_device_ids(devices)
        for device in devices:
            dev_id = device["id"]
            ip = device["ip"]
            alive, latency = ping_device(ip)
            with _status_lock:
                _status[dev_id] = {
                    "status": "up" if alive else "down",
                    "latency": latency,
                    "last_checked": time.time(),
                }
        time.sleep(PING_INTERVAL)


def start_pinger(get_devices_fn):
    """Start the background ping thread."""
    t = threading.Thread(target=_ping_loop, args=(get_devices_fn,), daemon=True)
    t.start()
    return t


def scan_subnet(ips: list[str], max_workers: int = 100) -> dict[str, dict]:
    """
    Ping a list of IPs concurrently.
    Returns {ip: {"alive": bool, "latency": float|None}}.
    """
    results: dict[str, dict] = {}
    with ThreadPoolExecutor(max_workers=max_workers) as executor:
        future_to_ip = {executor.submit(ping_device, ip): ip for ip in ips}
        for future in as_completed(future_to_ip):
            ip = future_to_ip[future]
            try:
                alive, latency = future.result()
            except Exception:
                alive, latency = False, None
            results[ip] = {"alive": alive, "latency": latency}
    return results
