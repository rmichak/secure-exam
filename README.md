# Secure Exam Desktop

A containerized desktop environment system for secure student exams and labs. Provides isolated XFCE desktops accessible via browser with clipboard blocking and network isolation to prevent cheating and data exfiltration.

## Features

- **Isolated Desktop Environments** - Each student gets a dedicated Ubuntu container with XFCE desktop
- **Browser-Based Access** - No software installation required; access via noVNC in any modern browser
- **Clipboard Blocking** - RFB protocol filtering prevents copy/paste between container and host
- **Website Allowlisting** - DNS-based filtering restricts internet access to approved domains only
- **Course Management** - Professors create courses, assignments, and manage student enrollments
- **Exam Mode** - Time-windowed exams with automatic session termination
- **Role-Based Access** - Admin, professor, and student roles with appropriate permissions
- **Submission System** - Students submit work directly from the desktop environment

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│ Gateway (Node.js Express on port 80)                        │
│ - Serves frontend pages (landing, login, dashboards)        │
│ - REST API for courses, students, assignments               │
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

## Prerequisites

- Docker and Docker Compose
- Node.js 18+ (for local development only)
- 4GB+ RAM recommended
- Linux or macOS host (Windows via WSL2)

## Getting Started

### 1. Clone the Repository

```bash
git clone <repository-url>
cd secure-exam
```

### 2. Build and Start

```bash
# Build all Docker images and start services
docker compose up -d --build
```

This will:
- Build the base Ubuntu/XFCE/VNC image
- Build the VS Code + Python development image
- Start the gateway service on port 80
- Create the isolated Docker network

### 3. Access the Application

Open your browser and navigate to:

```
http://localhost
```

### 4. Default Login

A demo admin account is created automatically:

- **Email:** `demo@example.com`
- **Password:** `demo123`

> **Important:** Change this password in production!

## Usage

### For Professors

1. **Login** at `/login.html` with your credentials
2. **Create a Course** from the professor dashboard
3. **Add Students** by entering their names and emails
4. **Create Assignments** with optional restriction templates:
   - *Open Homework* - Full clipboard, broad website access
   - *Restricted Lab* - Full clipboard, limited websites
   - *Closed Exam* - No clipboard, minimal website access
5. **Share Access Links** with students via email
6. **Monitor Sessions** and download submissions

### For Students

1. **Click the access link** provided by your professor
2. **Wait for the desktop to load** (takes 5-10 seconds)
3. **Work in the isolated environment** using VS Code, Firefox, and terminal
4. **Submit your work** using the submit script in the desktop

### For Administrators

1. **Manage Professors** - Approve waitlist accounts, assign admin roles
2. **Configure Settings** - Set system-wide policies
3. **Monitor All Courses** - View activity across all professors

## Project Structure

```
secure-exam/
├── gateway/                    # Node.js backend
│   ├── index.js               # Main application (API, proxy, filtering)
│   ├── db.js                  # SQLite database layer
│   └── Dockerfile             # Gateway container image
├── frontend/                   # HTML/CSS/JS frontend
│   ├── landing.html           # Public landing page
│   ├── login.html             # Professor login
│   ├── professor.html         # Professor dashboard
│   ├── student.html           # Student interface
│   └── settings.html          # Admin settings
├── images/                     # Desktop container images
│   ├── base/                   # Ubuntu + XFCE + VNC base image
│   │   ├── Dockerfile
│   │   ├── startup.sh         # Container initialization
│   │   └── filtering/         # DNS/website filtering
│   └── vscode-python/         # Base + VS Code + Python + Firefox
│       └── Dockerfile
├── data/                       # Persistent data (gitignored)
├── docker-compose.yml         # Service orchestration
└── CLAUDE.md                  # Development instructions
```

## Configuration

### Website Allowlist

Edit `images/base/filtering/allowlist.txt` to customize allowed domains:

```text
# Documentation sites
docs.python.org
developer.mozilla.org
readthedocs.io

# Programming resources
stackoverflow.com
github.com

# Package managers
pypi.org
```

After editing, rebuild the images:

```bash
docker compose down
docker compose up -d --build
```

### Environment Variables

The gateway accepts these environment variables (set in `docker-compose.yml`):

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `80` | Gateway listen port |
| `DOCKER_NETWORK` | `secure-exam_vnc-internal` | Docker network for containers |
| `DATA_DIR` | `/data` | Data directory inside gateway |
| `HOST_DATA_DIR` | `./data` | Host path for volume mounts |

## Security Features

### Clipboard Blocking

The gateway intercepts VNC WebSocket traffic and filters RFB protocol messages:
- **Type 3** (ServerCutText) - Blocks server-to-client clipboard
- **Type 6** (ClientCutText) - Blocks client-to-server clipboard

### Network Isolation

- Containers run on an internal Docker network with no direct internet access
- All DNS queries are handled by dnsmasq inside each container
- iptables rules block external DNS (port 53) except to the local resolver
- Only whitelisted domains resolve successfully

### Authentication

- Session-based authentication with 24-hour timeout
- Passwords hashed with bcrypt
- Role-based access control (admin, professor, student)
- Student access via unique enrollment tokens

## API Reference

### Authentication

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/login` | Professor login |
| POST | `/api/signup` | Professor registration |
| POST | `/api/logout` | End session |
| GET | `/api/me` | Get current user |

### Courses

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/courses` | List courses |
| POST | `/api/courses` | Create course |
| GET | `/api/courses/:id` | Get course details |
| PUT | `/api/courses/:id` | Update course |
| DELETE | `/api/courses/:id` | Delete course |

### Assignments

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/courses/:id/assignments` | List assignments |
| POST | `/api/assignments` | Create assignment |
| PUT | `/api/assignments/:id` | Update assignment |
| DELETE | `/api/assignments/:id` | Delete assignment |

### Students & Enrollments

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/students` | List all students |
| POST | `/api/students` | Create student |
| GET | `/api/courses/:id/enrollments` | List course enrollments |
| POST | `/api/courses/:id/enrollments` | Enroll student |
| POST | `/api/enrollments/:id/start` | Start container |
| POST | `/api/enrollments/:id/stop` | Stop container |

## Development

### Running Locally

```bash
# Install gateway dependencies
cd gateway
npm install

# Start in development mode (requires Docker running)
npm start
```

### Building Images Individually

```bash
# Build base image
docker build -t exam-desktop-base ./images/base

# Build VS Code + Python image
docker build -t exam-desktop-vscode-python ./images/vscode-python
```

### Debugging

```bash
# View gateway logs
docker compose logs -f gateway

# Test API endpoints
curl http://localhost/api/images
curl http://localhost/api/sessions

# Access container shell
docker exec -it <container-name> bash

# Check container DNS filtering
docker exec <container-name> nslookup docs.python.org
docker exec <container-name> nslookup blocked-site.com
```

## Troubleshooting

### Container won't start

1. Check Docker is running: `docker ps`
2. Verify network exists: `docker network ls | grep vnc-internal`
3. Check gateway logs: `docker compose logs gateway`

### VNC connection fails

1. Wait 5-10 seconds for container initialization
2. Check container status via API: `curl http://localhost/api/sessions`
3. Verify port 6080 is exposed in container

### Website blocked unexpectedly

1. Check allowlist: `cat images/base/filtering/allowlist.txt`
2. Verify domain format (no `http://` prefix)
3. Rebuild images after changes: `docker compose up -d --build`

## License

MIT License - See LICENSE file for details.

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Submit a pull request

## Acknowledgments

- [noVNC](https://novnc.com/) - VNC client for the browser
- [TigerVNC](https://tigervnc.org/) - VNC server implementation
- [XFCE](https://xfce.org/) - Lightweight desktop environment
