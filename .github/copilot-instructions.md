# ICMP Network Map - Copilot Instructions

## Project Overview
A Python-based web application that monitors network device up/down status using ICMP ping. Deployed as a local web server with a browser-based topology map UI.

## Tech Stack
- **Backend**: Python 3, Flask (REST API + web server)
- **Ping Engine**: `icmplib` (requires admin/root for raw sockets) or subprocess ping fallback
- **Frontend**: Vanilla HTML/CSS/JavaScript with vis.js for topology visualization
- **Storage**: JSON file (`devices.json`) for device persistence
- **Realtime**: Server-Sent Events (SSE) for live status push to browser

## Project Structure
- `app.py` — Flask app: REST API, SSE endpoint, static file serving
- `pinger.py` — Background thread pinging all devices periodically
- `devices.json` — Persisted device list (name, ip, group/notes)
- `templates/index.html` — Main UI page
- `static/` — CSS and JS assets
- `requirements.txt` — Python dependencies

## Key Rules
- Always use absolute paths when running terminal commands
- The app must run with `python app.py` from the project root
- ICMP on Windows requires admin privileges; use subprocess ping as fallback if needed
- Device status is polled every 10 seconds by default
- All API responses are JSON
