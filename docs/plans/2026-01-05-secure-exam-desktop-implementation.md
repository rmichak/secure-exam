# Secure Exam Desktop Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a secure, containerized desktop environment where students can code in VS Code but cannot copy/paste to their host or access the internet.

**Architecture:** Desktop containers run XFCE + TigerVNC, accessed via noVNC in browser. A WebSocket proxy blocks clipboard messages. Docker's internal network prevents internet access. A Node.js backend manages container lifecycle.

**Tech Stack:** Docker, Node.js, Express, WebSocket (ws), noVNC, TigerVNC, XFCE, Ubuntu 22.04

---

## Task 1: Clean Up Existing Files

**Files:**
- Delete: `index.html`
- Delete: `nginx.conf`
- Delete: `Dockerfile`
- Delete: `startup.sh`
- Delete: `docker-compose.yml`

**Step 1: Stop running containers**

Run: `docker compose down`
Expected: Containers stopped

**Step 2: Remove old files**

Run: `rm -f index.html nginx.conf Dockerfile startup.sh docker-compose.yml`
Expected: Files removed

**Step 3: Create new directory structure**

Run: `mkdir -p images/base images/vscode-python proxy backend frontend`
Expected: Directories created

**Step 4: Commit**

```bash
git init
git add -A
git commit -m "chore: clean up and create new directory structure"
```

---

## Task 2: Create Base Desktop Image

**Files:**
- Create: `images/base/Dockerfile`
- Create: `images/base/startup.sh`

**Step 1: Create base Dockerfile**

Create `images/base/Dockerfile`:

```dockerfile
FROM ubuntu:22.04

ENV DEBIAN_FRONTEND=noninteractive
ENV USER=student
ENV HOME=/home/student

# Install desktop environment and VNC
RUN apt-get update && apt-get install -y \
    xfce4 \
    xfce4-terminal \
    tigervnc-standalone-server \
    tigervnc-common \
    novnc \
    websockify \
    dbus-x11 \
    sudo \
    && rm -rf /var/lib/apt/lists/*

# Create non-root user
RUN useradd -m -s /bin/bash $USER \
    && echo "$USER:$USER" | chpasswd \
    && adduser $USER sudo

# Set up VNC
RUN mkdir -p $HOME/.vnc \
    && echo "student" | vncpasswd -f > $HOME/.vnc/passwd \
    && chmod 600 $HOME/.vnc/passwd \
    && chown -R $USER:$USER $HOME/.vnc

# VNC startup script
COPY startup.sh /startup.sh
RUN chmod +x /startup.sh

EXPOSE 5901 6080

USER $USER
WORKDIR $HOME

CMD ["/startup.sh"]
```

**Step 2: Create startup script**

Create `images/base/startup.sh`:

```bash
#!/bin/bash

# Start VNC server
vncserver :1 -geometry 1920x1080 -depth 24 -localhost no

# Start noVNC
/usr/share/novnc/utils/novnc_proxy --vnc localhost:5901 --listen 6080 &

# Keep container running
tail -f /dev/null
```

**Step 3: Build and test base image**

Run: `docker build -t exam-desktop-base images/base/`
Expected: Image builds successfully

**Step 4: Test base image runs**

Run: `docker run -d --name test-base -p 6080:6080 exam-desktop-base`
Wait 5 seconds, then run: `curl -s -o /dev/null -w "%{http_code}" http://localhost:6080/`
Expected: `200`

**Step 5: Clean up test container**

Run: `docker stop test-base && docker rm test-base`
Expected: Container removed

**Step 6: Commit**

```bash
git add images/base/
git commit -m "feat: add base desktop image with XFCE and VNC"
```

---

## Task 3: Create VS Code + Python Image

**Files:**
- Create: `images/vscode-python/Dockerfile`

**Step 1: Create vscode-python Dockerfile**

Create `images/vscode-python/Dockerfile`:

```dockerfile
FROM exam-desktop-base

USER root

# Install Python
RUN apt-get update && apt-get install -y \
    python3 \
    python3-pip \
    python3-venv \
    && rm -rf /var/lib/apt/lists/*

# Install VS Code
RUN apt-get update && apt-get install -y wget gpg \
    && wget -qO- https://packages.microsoft.com/keys/microsoft.asc | gpg --dearmor > packages.microsoft.gpg \
    && install -D -o root -g root -m 644 packages.microsoft.gpg /etc/apt/keyrings/packages.microsoft.gpg \
    && echo "deb [arch=amd64 signed-by=/etc/apt/keyrings/packages.microsoft.gpg] https://packages.microsoft.com/repos/code stable main" > /etc/apt/sources.list.d/vscode.list \
    && apt-get update \
    && apt-get install -y code \
    && rm -rf /var/lib/apt/lists/* packages.microsoft.gpg

# Create workspace directory
RUN mkdir -p /home/student/workspace && chown student:student /home/student/workspace

USER student
WORKDIR /home/student
```

**Step 2: Build vscode-python image**

Run: `docker build -t exam-desktop-vscode-python images/vscode-python/`
Expected: Image builds successfully (this may take a few minutes)

**Step 3: Commit**

```bash
git add images/vscode-python/
git commit -m "feat: add VS Code + Python image"
```

---

## Task 4: Create Clipboard-Blocking Proxy

**Files:**
- Create: `proxy/package.json`
- Create: `proxy/index.js`

**Step 1: Create package.json**

Create `proxy/package.json`:

```json
{
  "name": "vnc-proxy",
  "version": "1.0.0",
  "description": "WebSocket proxy that blocks clipboard messages",
  "main": "index.js",
  "scripts": {
    "start": "node index.js"
  },
  "dependencies": {
    "ws": "^8.14.0",
    "http-proxy": "^1.18.1"
  }
}
```

**Step 2: Create proxy server**

Create `proxy/index.js`:

```javascript
const http = require('http');
const WebSocket = require('ws');
const url = require('url');

const PROXY_PORT = process.env.PROXY_PORT || 6080;

// Track active sessions: sessionId -> { targetPort, ws connections }
const sessions = new Map();

const server = http.createServer((req, res) => {
  // Health check endpoint
  if (req.url === '/health') {
    res.writeHead(200);
    res.end('OK');
    return;
  }

  // Serve noVNC static files - proxy to first available session
  // In production, would route based on session ID in path
  res.writeHead(404);
  res.end('Use WebSocket connection');
});

const wss = new WebSocket.Server({ server });

wss.on('connection', (clientWs, req) => {
  const parsedUrl = url.parse(req.url, true);
  const targetPort = parsedUrl.query.port || 6081;

  console.log(`New connection, proxying to port ${targetPort}`);

  // Connect to the actual noVNC server
  const targetWs = new WebSocket(`ws://localhost:${targetPort}`);

  targetWs.on('open', () => {
    console.log('Connected to target VNC');
  });

  targetWs.on('error', (err) => {
    console.error('Target connection error:', err.message);
    clientWs.close();
  });

  // Client -> Target (filter clipboard)
  clientWs.on('message', (data) => {
    if (Buffer.isBuffer(data) && data.length > 0) {
      const messageType = data[0];

      // Block client cut text (type 6 in RFB protocol)
      if (messageType === 6) {
        console.log('Blocked clipboard: client -> server');
        return;
      }
    }

    if (targetWs.readyState === WebSocket.OPEN) {
      targetWs.send(data);
    }
  });

  // Target -> Client (filter clipboard)
  targetWs.on('message', (data) => {
    if (Buffer.isBuffer(data) && data.length > 0) {
      const messageType = data[0];

      // Block server cut text (type 3 in RFB protocol)
      if (messageType === 3) {
        console.log('Blocked clipboard: server -> client');
        return;
      }
    }

    if (clientWs.readyState === WebSocket.OPEN) {
      clientWs.send(data);
    }
  });

  clientWs.on('close', () => {
    console.log('Client disconnected');
    targetWs.close();
  });

  targetWs.on('close', () => {
    console.log('Target disconnected');
    clientWs.close();
  });

  clientWs.on('error', (err) => {
    console.error('Client error:', err.message);
  });
});

server.listen(PROXY_PORT, () => {
  console.log(`Clipboard-blocking proxy running on port ${PROXY_PORT}`);
});
```

**Step 3: Commit**

```bash
git add proxy/
git commit -m "feat: add clipboard-blocking WebSocket proxy"
```

---

## Task 5: Create Backend API

**Files:**
- Create: `backend/package.json`
- Create: `backend/server.js`

**Step 1: Create package.json**

Create `backend/package.json`:

```json
{
  "name": "exam-desktop-backend",
  "version": "1.0.0",
  "description": "API for managing secure desktop sessions",
  "main": "server.js",
  "scripts": {
    "start": "node server.js"
  },
  "dependencies": {
    "express": "^4.18.2",
    "cors": "^2.8.5",
    "dockerode": "^4.0.0"
  }
}
```

**Step 2: Create backend server**

Create `backend/server.js`:

```javascript
const express = require('express');
const cors = require('cors');
const Docker = require('dockerode');
const path = require('path');

const app = express();
const docker = new Docker();

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../frontend')));

const PORT = process.env.PORT || 3000;
const BASE_VNC_PORT = 6081;

// Track sessions
const sessions = new Map();
let nextPort = BASE_VNC_PORT;

// Available images
const images = [
  {
    id: 'vscode-python',
    name: 'VS Code + Python',
    image: 'exam-desktop-vscode-python',
    description: 'Ubuntu desktop with VS Code and Python 3'
  }
];

// GET /api/images - list available images
app.get('/api/images', (req, res) => {
  res.json(images);
});

// GET /api/sessions - list running sessions
app.get('/api/sessions', async (req, res) => {
  const sessionList = [];

  for (const [id, session] of sessions) {
    try {
      const container = docker.getContainer(session.containerId);
      const info = await container.inspect();
      sessionList.push({
        id,
        imageId: session.imageId,
        imageName: session.imageName,
        port: session.port,
        status: info.State.Running ? 'running' : 'stopped',
        created: session.created
      });
    } catch (err) {
      // Container no longer exists
      sessions.delete(id);
    }
  }

  res.json(sessionList);
});

// POST /api/sessions - create new session
app.post('/api/sessions', async (req, res) => {
  const { imageId, sessionName } = req.body;

  const imageConfig = images.find(i => i.id === imageId);
  if (!imageConfig) {
    return res.status(400).json({ error: 'Invalid image ID' });
  }

  const sessionId = sessionName || `session-${Date.now()}`;
  const port = nextPort++;

  try {
    // Create container on isolated network
    const container = await docker.createContainer({
      Image: imageConfig.image,
      name: `exam-${sessionId}`,
      ExposedPorts: {
        '6080/tcp': {}
      },
      HostConfig: {
        PortBindings: {
          '6080/tcp': [{ HostPort: port.toString() }]
        },
        NetworkMode: 'exam-isolated'
      }
    });

    await container.start();

    sessions.set(sessionId, {
      containerId: container.id,
      imageId: imageConfig.id,
      imageName: imageConfig.name,
      port,
      created: new Date().toISOString()
    });

    res.json({
      id: sessionId,
      port,
      connectUrl: `/connect?port=${port}`
    });

  } catch (err) {
    console.error('Failed to create session:', err);
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/sessions/:id - terminate session
app.delete('/api/sessions/:id', async (req, res) => {
  const { id } = req.params;
  const session = sessions.get(id);

  if (!session) {
    return res.status(404).json({ error: 'Session not found' });
  }

  try {
    const container = docker.getContainer(session.containerId);
    await container.stop();
    await container.remove();
    sessions.delete(id);
    res.json({ success: true });
  } catch (err) {
    console.error('Failed to terminate session:', err);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Backend API running on port ${PORT}`);
});
```

**Step 3: Commit**

```bash
git add backend/
git commit -m "feat: add backend API for session management"
```

---

## Task 6: Create Frontend Landing Page

**Files:**
- Create: `frontend/index.html`

**Step 1: Create landing page**

Create `frontend/index.html`:

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Secure Exam Desktop</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }

    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);
      min-height: 100vh;
      color: white;
      padding: 20px;
    }

    .container { max-width: 1200px; margin: 0 auto; }

    h1 {
      margin-bottom: 30px;
      display: flex;
      align-items: center;
      gap: 15px;
    }

    .logo {
      width: 40px;
      height: 40px;
      background: linear-gradient(135deg, #00d4ff, #0099cc);
      border-radius: 8px;
      display: flex;
      align-items: center;
      justify-content: center;
      font-weight: bold;
    }

    .section {
      background: rgba(255,255,255,0.1);
      border-radius: 12px;
      padding: 20px;
      margin-bottom: 20px;
    }

    .section h2 {
      margin-bottom: 15px;
      font-size: 18px;
      color: #00d4ff;
    }

    .images-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(250px, 1fr));
      gap: 15px;
    }

    .image-card {
      background: rgba(255,255,255,0.95);
      border-radius: 8px;
      padding: 20px;
      color: #333;
    }

    .image-card h3 { margin-bottom: 8px; }

    .image-card p {
      font-size: 14px;
      color: #666;
      margin-bottom: 15px;
    }

    .btn {
      background: linear-gradient(135deg, #00d4ff, #0099cc);
      border: none;
      color: white;
      padding: 10px 20px;
      border-radius: 6px;
      cursor: pointer;
      font-size: 14px;
      font-weight: 500;
    }

    .btn:hover { opacity: 0.9; }
    .btn-danger { background: #e74c3c; }
    .btn-secondary { background: #666; }

    .sessions-list {
      display: flex;
      flex-direction: column;
      gap: 10px;
    }

    .session-item {
      background: rgba(0,0,0,0.3);
      border-radius: 8px;
      padding: 15px;
      display: flex;
      align-items: center;
      justify-content: space-between;
    }

    .session-info {
      display: flex;
      align-items: center;
      gap: 15px;
    }

    .status-dot {
      width: 10px;
      height: 10px;
      border-radius: 50%;
      background: #00ff88;
    }

    .status-dot.stopped { background: #e74c3c; }

    .session-actions {
      display: flex;
      gap: 10px;
    }

    .empty-state {
      text-align: center;
      padding: 40px;
      color: #888;
    }

    .modal {
      display: none;
      position: fixed;
      inset: 0;
      background: rgba(0,0,0,0.8);
      align-items: center;
      justify-content: center;
      z-index: 100;
    }

    .modal.active { display: flex; }

    .modal-content {
      background: #1a1a2e;
      border-radius: 12px;
      padding: 30px;
      max-width: 400px;
      width: 90%;
    }

    .modal h3 { margin-bottom: 20px; }

    .form-group { margin-bottom: 15px; }

    .form-group label {
      display: block;
      margin-bottom: 5px;
      font-size: 14px;
    }

    .form-group input {
      width: 100%;
      padding: 10px;
      border-radius: 6px;
      border: 1px solid #333;
      background: #0a0a15;
      color: white;
      font-size: 14px;
    }

    .modal-actions {
      display: flex;
      gap: 10px;
      margin-top: 20px;
    }
  </style>
</head>
<body>
  <div class="container">
    <h1>
      <div class="logo">S</div>
      Secure Exam Desktop
    </h1>

    <div class="section">
      <h2>Available Images</h2>
      <div class="images-grid" id="imagesGrid"></div>
    </div>

    <div class="section">
      <h2>Running Sessions</h2>
      <div class="sessions-list" id="sessionsList"></div>
    </div>
  </div>

  <div class="modal" id="launchModal">
    <div class="modal-content">
      <h3>Launch Desktop</h3>
      <div class="form-group">
        <label>Session Name</label>
        <input type="text" id="sessionName" placeholder="e.g., student-1">
      </div>
      <input type="hidden" id="selectedImage">
      <div class="modal-actions">
        <button class="btn" id="confirmLaunchBtn">Launch</button>
        <button class="btn btn-secondary" id="cancelModalBtn">Cancel</button>
      </div>
    </div>
  </div>

  <script>
    const API_BASE = '';

    // DOM element creation helpers
    function createElement(tag, className, textContent) {
      const el = document.createElement(tag);
      if (className) el.className = className;
      if (textContent) el.textContent = textContent;
      return el;
    }

    function createButton(className, text, onClick) {
      const btn = createElement('button', className, text);
      btn.addEventListener('click', onClick);
      return btn;
    }

    // Render images
    async function loadImages() {
      const res = await fetch(API_BASE + '/api/images');
      const images = await res.json();
      const grid = document.getElementById('imagesGrid');

      // Clear existing content
      while (grid.firstChild) {
        grid.removeChild(grid.firstChild);
      }

      images.forEach(function(img) {
        const card = createElement('div', 'image-card');

        const title = createElement('h3', null, img.name);
        const desc = createElement('p', null, img.description);
        const btn = createButton('btn', 'Launch', function() {
          showLaunchModal(img.id);
        });

        card.appendChild(title);
        card.appendChild(desc);
        card.appendChild(btn);
        grid.appendChild(card);
      });
    }

    // Render sessions
    async function loadSessions() {
      const res = await fetch(API_BASE + '/api/sessions');
      const sessions = await res.json();
      const list = document.getElementById('sessionsList');

      // Clear existing content
      while (list.firstChild) {
        list.removeChild(list.firstChild);
      }

      if (sessions.length === 0) {
        const empty = createElement('div', 'empty-state', 'No running sessions');
        list.appendChild(empty);
        return;
      }

      sessions.forEach(function(s) {
        const item = createElement('div', 'session-item');

        const info = createElement('div', 'session-info');
        const dot = createElement('div', 'status-dot' + (s.status !== 'running' ? ' stopped' : ''));
        const details = createElement('div');

        const name = createElement('strong', null, s.id);
        const imageName = createElement('div', null, s.imageName);
        imageName.style.fontSize = '12px';
        imageName.style.color = '#888';

        details.appendChild(name);
        details.appendChild(imageName);
        info.appendChild(dot);
        info.appendChild(details);

        const actions = createElement('div', 'session-actions');
        const connectBtn = createButton('btn', 'Connect', function() {
          connect(s.port);
        });
        const terminateBtn = createButton('btn btn-danger', 'Terminate', function() {
          terminate(s.id);
        });

        actions.appendChild(connectBtn);
        actions.appendChild(terminateBtn);

        item.appendChild(info);
        item.appendChild(actions);
        list.appendChild(item);
      });
    }

    function showLaunchModal(imageId) {
      document.getElementById('selectedImage').value = imageId;
      document.getElementById('sessionName').value = '';
      document.getElementById('launchModal').classList.add('active');
    }

    function closeModal() {
      document.getElementById('launchModal').classList.remove('active');
    }

    async function confirmLaunch() {
      const imageId = document.getElementById('selectedImage').value;
      const sessionName = document.getElementById('sessionName').value;

      const res = await fetch(API_BASE + '/api/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ imageId: imageId, sessionName: sessionName })
      });

      if (res.ok) {
        closeModal();
        loadSessions();
        const data = await res.json();
        setTimeout(function() { connect(data.port); }, 2000);
      } else {
        const err = await res.json();
        alert('Failed to launch: ' + err.error);
      }
    }

    function connect(port) {
      window.open('http://localhost:' + port + '/vnc.html', '_blank');
    }

    async function terminate(sessionId) {
      if (!confirm('Terminate this session?')) return;

      await fetch(API_BASE + '/api/sessions/' + sessionId, {
        method: 'DELETE'
      });

      loadSessions();
    }

    // Event listeners
    document.getElementById('confirmLaunchBtn').addEventListener('click', confirmLaunch);
    document.getElementById('cancelModalBtn').addEventListener('click', closeModal);

    // Initial load
    loadImages();
    loadSessions();

    // Refresh sessions every 5 seconds
    setInterval(loadSessions, 5000);
  </script>
</body>
</html>
```

**Step 2: Commit**

```bash
git add frontend/
git commit -m "feat: add frontend landing page"
```

---

## Task 7: Create Docker Compose Configuration

**Files:**
- Create: `docker-compose.yml`

**Step 1: Create docker-compose.yml**

Create `docker-compose.yml`:

```yaml
services:
  backend:
    build:
      context: ./backend
      dockerfile: Dockerfile
    ports:
      - "3000:3000"
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
      - ./frontend:/app/frontend
    networks:
      - frontend
    depends_on:
      - proxy

  proxy:
    build:
      context: ./proxy
      dockerfile: Dockerfile
    ports:
      - "6080:6080"
    networks:
      - frontend
      - exam-isolated

networks:
  frontend:
    driver: bridge
  exam-isolated:
    driver: bridge
    internal: true
```

**Step 2: Create backend Dockerfile**

Create `backend/Dockerfile`:

```dockerfile
FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .

EXPOSE 3000

CMD ["npm", "start"]
```

**Step 3: Create proxy Dockerfile**

Create `proxy/Dockerfile`:

```dockerfile
FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .

EXPOSE 6080

CMD ["npm", "start"]
```

**Step 4: Commit**

```bash
git add docker-compose.yml backend/Dockerfile proxy/Dockerfile
git commit -m "feat: add Docker Compose configuration"
```

---

## Task 8: Integration Test

**Step 1: Build all images**

Run: `docker build -t exam-desktop-base images/base/`
Run: `docker build -t exam-desktop-vscode-python images/vscode-python/`
Expected: Both images build successfully

**Step 2: Create isolated network**

Run: `docker network create --internal exam-isolated`
Expected: Network created

**Step 3: Start the stack**

Run: `docker compose up --build -d`
Expected: backend and proxy services start

**Step 4: Verify services are running**

Run: `docker compose ps`
Expected: Both services show as "Up"

**Step 5: Test the landing page**

Run: `curl -s -o /dev/null -w "%{http_code}" http://localhost:3000/`
Expected: `200`

**Step 6: Test API endpoints**

Run: `curl http://localhost:3000/api/images`
Expected: JSON array with vscode-python image

Run: `curl http://localhost:3000/api/sessions`
Expected: Empty JSON array `[]`

**Step 7: Commit final state**

```bash
git add -A
git commit -m "feat: complete secure exam desktop prototype"
```

---

## Task 9: Manual Verification Checklist

After all automated steps, manually verify:

- [ ] Open http://localhost:3000 in browser
- [ ] Click "Launch" on VS Code + Python image
- [ ] Enter a session name and confirm
- [ ] Wait for desktop to load in new tab
- [ ] Verify VS Code is installed (look in applications menu)
- [ ] Try to copy text from host and paste in container (should fail)
- [ ] Try to copy text from container and paste on host (should fail)
- [ ] Verify copy/paste works WITHIN the container
- [ ] Terminate the session from landing page
- [ ] Verify container is removed
