# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Secure Exam Desktop - a containerized desktop environment system for student exams. Provides isolated XFCE desktops accessible via browser with clipboard blocking and network isolation to prevent cheating/data exfiltration.

## Build Commands

```bash
# Build all images and start services
docker compose up -d --build

# Build individual images
docker build -t exam-desktop-base ./images/base
docker build -t exam-desktop-vscode-python ./images/vscode-python

# Stop everything
docker compose down

# Clean up exam containers
docker ps -a --filter "name=exam-" --format "{{.Names}}" | xargs -r docker rm -f
```

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│ Gateway (Node.js Express on port 80)                        │
│ - Serves frontend/index.html                                │
│ - REST API: /api/images, /api/sessions, /api/sessions/:id   │
│ - HTTP Proxy: /vnc/:sessionId/* → container:6080            │
│ - WebSocket Proxy with RFB clipboard filtering              │
├─────────────────────────────────────────────────────────────┤
│ Docker Network: secure-exam_vnc-internal (isolated)           │
│ ┌──────────────┐  ┌──────────────┐  ┌──────────────┐       │
│ │ exam-session1│  │ exam-session2│  │ exam-sessionN│       │
│ │ XFCE + VNC   │  │ XFCE + VNC   │  │ XFCE + VNC   │       │
│ │ :5901/:6080  │  │ :5901/:6080  │  │ :5901/:6080  │       │
│ └──────────────┘  └──────────────┘  └──────────────┘       │
└─────────────────────────────────────────────────────────────┘
```

**Data flow**: Browser → Gateway:80 → Docker Network → Container:6080 (websockify) → VNC:5901

## Key Files

- `gateway/index.js` - Unified gateway (API, VNC proxy, clipboard filtering)
- `frontend/index.html` - Landing page with session management UI
- `images/base/Dockerfile` - Ubuntu + XFCE + TigerVNC + noVNC + website filtering
- `images/base/startup.sh` - Container initialization (filtering setup, VNC start)
- `images/base/filtering/` - DNS-based website allowlist system
- `images/vscode-python/Dockerfile` - Base + VS Code + Python + Firefox
- `docker-compose.yml` - Orchestration with Docker socket access

## API Endpoints

| Method | Endpoint | Purpose |
|--------|----------|---------|
| GET | /api/images | List available desktop images |
| GET | /api/sessions | List running containers |
| POST | /api/sessions | Create container (body: {imageId, sessionName}) |
| DELETE | /api/sessions/:id | Terminate container |
| GET | /api/sessions/:id/status | Check VNC readiness (returns {status: "starting"|"ready"}) |

## Security Implementation

- **Clipboard blocking**: Gateway filters RFB protocol messages (type 3 server→client, type 6 client→server)
- **Network isolation**: Containers on internal Docker network, no direct internet
- **DNS filtering**: dnsmasq resolves only allowlisted domains, iptables blocks external DNS
- **NET_ADMIN capability**: Required for containers to run iptables rules

## Website Allowlist

Edit `images/base/filtering/allowlist.txt` then rebuild images. Format: one domain per line, subdomains included automatically.

## Debugging

```bash
# View gateway logs
docker compose logs -f gateway

# Test API
curl http://localhost/api/images
curl http://localhost/api/sessions

# Check container status
curl http://localhost/api/sessions/{sessionId}/status
```
