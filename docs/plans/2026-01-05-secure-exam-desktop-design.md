# Secure Exam Desktop Environment - Design Document

## Overview

A secure, containerized desktop environment for student exams. Students access a locked-down desktop via browser where they can code but cannot copy/paste to their host machine or access the internet.

## Requirements

| Requirement | Decision |
|-------------|----------|
| Scale | 1-10 concurrent students, single machine |
| Desktop | XFCE via TigerVNC + noVNC in browser |
| Network | Isolated Docker network, no internet |
| Clipboard | Blocked at proxy layer (no copy in/out) |
| File transfer | Blocked (no UI, network isolated) |
| Images | Multiple Dockerfiles, configurable per session |
| Management | Landing page + API to launch/list/terminate sessions |

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                      Host Machine                            │
│  ┌─────────────┐    ┌─────────────────────────────────────┐ │
│  │   Landing   │    │     Desktop Containers (isolated)    │ │
│  │    Page     │    │  ┌─────────┐ ┌─────────┐ ┌────────┐ │ │
│  │  (nginx)    │    │  │Student 1│ │Student 2│ │  ...   │ │ │
│  │  :8080      │    │  │ XFCE +  │ │ XFCE +  │ │        │ │ │
│  └──────┬──────┘    │  │ VS Code │ │ Python  │ │        │ │ │
│         │           │  └────┬────┘ └────┬────┘ └────────┘ │ │
│         │           └───────┼───────────┼─────────────────┘ │
│  ┌──────▼──────┐            │           │                   │
│  │   Proxy     │◄───────────┴───────────┘                   │
│  │  (routes &  │    VNC connections (clipboard disabled)    │
│  │  security)  │                                            │
│  │  :6080      │    Network: isolated (no internet)         │
│  └─────────────┘                                            │
└─────────────────────────────────────────────────────────────┘
```

### Components

1. **Landing Page** - Web UI for launching and managing desktop sessions
2. **Backend API** - Manages container lifecycle via Docker API
3. **Clipboard-blocking Proxy** - WebSocket proxy that filters clipboard messages
4. **Desktop Containers** - Isolated XFCE desktops with pre-installed tools

## Image System

Multiple Dockerfiles define different "templates" for student environments:

```
images/
├── base/
│   └── Dockerfile          # XFCE + noVNC + common tools
├── vscode-python/
│   └── Dockerfile          # Base + VS Code + Python
├── vscode-java/
│   └── Dockerfile          # Base + VS Code + Java/JDK
└── cpp-dev/
    └── Dockerfile          # Base + VS Code + gcc/g++
```

### Base Image Includes
- Ubuntu 22.04 + XFCE desktop
- TigerVNC server
- noVNC + websockify
- Common utilities (file manager, terminal)

### Specialized Images
Extend base and add:
- VS Code (via .deb install)
- Language runtimes/compilers
- Course-specific tools

## Security Controls

### Network Isolation

```yaml
networks:
  isolated:
    driver: bridge
    internal: true  # No outbound internet

  frontend:
    driver: bridge
```

Desktop containers attach only to `isolated`. The proxy bridges `frontend` and `isolated`.

### Clipboard Blocking

noVNC clipboard sharing uses WebSocket message types:
- Type 6 = client cut text (browser → container)
- Type 3 = server cut text (container → browser)

The proxy inspects noVNC protocol messages and drops clipboard-related ones.

```
Browser ──WebSocket──▶ Proxy ──WebSocket──▶ noVNC ──▶ VNC Server
                         │
                    Filters out
                    clipboard messages
```

### What This Prevents
- Copy from host browser → paste into container
- Copy from container → paste on host
- Drag-and-drop files
- File upload/download

### What Students CAN Do
- Copy/paste within the container (internal clipboard works)
- Use all desktop applications normally

## Session Management

### Landing Page UI

```
┌─────────────────────────────────────────────┐
│  Secure Desktop Launcher                    │
├─────────────────────────────────────────────┤
│  Available Images:                          │
│  ┌─────────────┐ ┌─────────────┐            │
│  │ Python Dev  │ │  Java Dev   │            │
│  │   Launch    │ │   Launch    │            │
│  └─────────────┘ └─────────────┘            │
├─────────────────────────────────────────────┤
│  Running Sessions:                          │
│  ┌─────────────────────────────────────┐    │
│  │ student-1 │ Python │ Running │ [X]  │    │
│  │ student-2 │ Java   │ Running │ [X]  │    │
│  └─────────────────────────────────────┘    │
│                              [Connect]      │
└─────────────────────────────────────────────┘
```

### Backend API

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/images` | GET | List available images |
| `/api/sessions` | GET | List running sessions |
| `/api/sessions` | POST | Launch new desktop container |
| `/api/sessions/:id` | DELETE | Terminate a session |

## File Structure

```
secure-exam/
├── images/
│   ├── base/
│   │   └── Dockerfile
│   └── vscode-python/
│       └── Dockerfile
├── proxy/
│   └── index.js          # Clipboard-blocking proxy
├── backend/
│   └── server.js         # API for session management
├── frontend/
│   └── index.html        # Landing page
├── docker-compose.yml
└── config.yml            # Image definitions
```

## Prototype Scope

### Included
- Base desktop image (Ubuntu + XFCE + TigerVNC + noVNC)
- One specialized image (Base + VS Code + Python)
- Clipboard-blocking proxy
- Isolated Docker network (no internet)
- Simple landing page (launch, list, terminate sessions)
- Basic API backend (manages container lifecycle)

### Deferred
- Multiple image types (just Python + VS Code for now)
- Student authentication/login
- Persistent student work folders
- Website allowlist
- Work submission system
- Test mode vs learning mode toggle
