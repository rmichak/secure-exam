const express = require('express');
const session = require('express-session');
const http = require('http');
const httpProxy = require('http-proxy');
const WebSocket = require('ws');
const Docker = require('dockerode');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const db = require('./db');

const app = express();
const server = http.createServer(app);
const docker = new Docker();

// Create HTTP proxy for VNC static files
const proxy = httpProxy.createProxyServer({});

proxy.on('error', (err, req, res) => {
  console.error('Proxy error:', err.message);
  if (res.writeHead) {
    res.writeHead(502);
    res.end('Bad Gateway');
  }
});

const PORT = process.env.PORT || 80;
const DOCKER_NETWORK = process.env.DOCKER_NETWORK || 'secure-exam_vnc-internal';
const HOST_DATA_DIR = process.env.HOST_DATA_DIR || '/data';

// Track sessions in memory (for backward compatibility and quick lookups)
const sessions = new Map();

// Available images (legacy - will be replaced by course.environment_image)
const images = [
  {
    id: 'vscode-python',
    name: 'VS Code + Python',
    image: 'exam-desktop-vscode-python',
    description: 'Ubuntu desktop with VS Code and Python 3'
  }
];

console.log('Database initialized at:', db.DATA_DIR + '/lms.db');

// Middleware
app.use(express.json());

// Session middleware
app.use(session({
  secret: process.env.SESSION_SECRET || 'exam-desktop-demo-secret-2024',
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    maxAge: 24 * 60 * 60 * 1000 // 24 hours
  }
}));

// Auth middleware - protects professor routes
function requireAuth(req, res, next) {
  if (req.session && req.session.professorId) {
    return next();
  }
  // For API routes, return JSON error
  if (req.path.startsWith('/api/')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  // For HTML pages, redirect to login
  return res.redirect('/login');
}

// Admin middleware - protects admin-only routes
function requireAdmin(req, res, next) {
  if (req.session && req.session.role === 'admin') {
    return next();
  }
  if (req.path.startsWith('/api/')) {
    return res.status(403).json({ error: 'Admin access required' });
  }
  return res.redirect('/professor.html');
}

// ============================================================
// Authentication Routes
// ============================================================

app.post('/api/login', (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required' });
  }

  const professor = db.verifyProfessorPassword(email, password);
  if (!professor) {
    return res.status(401).json({ error: 'Invalid email or password' });
  }

  // Check account status
  if (professor.status === 'waitlist') {
    return res.status(403).json({ error: 'Your account is pending approval. Please contact an administrator.' });
  }
  if (professor.status === 'disabled') {
    return res.status(403).json({ error: 'Your account has been disabled. Please contact an administrator.' });
  }

  // Set session
  req.session.professorId = professor.id;
  req.session.professorEmail = professor.email;
  req.session.professorName = professor.name;
  req.session.role = professor.role;

  res.json({
    success: true,
    professor: {
      id: professor.id,
      email: professor.email,
      name: professor.name,
      role: professor.role
    }
  });
});

app.post('/api/signup', (req, res) => {
  const { email, password, name } = req.body;

  if (!email || !password || !name) {
    return res.status(400).json({ error: 'Email, password, and name are required' });
  }

  if (password.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters' });
  }

  // Check if email already exists
  const existing = db.getProfessorByEmail(email);
  if (existing) {
    return res.status(400).json({ error: 'An account with this email already exists' });
  }

  // Check waitlist setting
  const waitlistEnabled = db.getSetting('waitlist_enabled') === 'true';
  const status = waitlistEnabled ? 'waitlist' : 'active';

  try {
    const id = db.createProfessor(email, password, name, 'professor', status);

    if (waitlistEnabled) {
      res.json({
        success: true,
        message: 'Account created. Your account is pending approval by an administrator.',
        waitlist: true
      });
    } else {
      res.json({
        success: true,
        message: 'Account created successfully. You can now log in.',
        waitlist: false
      });
    }
  } catch (err) {
    console.error('Failed to create professor:', err);
    res.status(500).json({ error: 'Failed to create account' });
  }
});

app.post('/api/logout', (req, res) => {
  req.session.destroy((err) => {
    if (err) {
      return res.status(500).json({ error: 'Failed to logout' });
    }
    res.json({ success: true });
  });
});

app.get('/api/me', (req, res) => {
  if (req.session && req.session.professorId) {
    return res.json({
      id: req.session.professorId,
      email: req.session.professorEmail,
      name: req.session.professorName,
      role: req.session.role
    });
  }
  res.status(401).json({ error: 'Not authenticated' });
});

// ============================================================
// Professor Management Routes (Admin only)
// ============================================================

app.get('/api/professors', requireAuth, requireAdmin, (req, res) => {
  try {
    const professors = db.getProfessors();
    res.json(professors);
  } catch (err) {
    console.error('Failed to get professors:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/professors/:id', requireAuth, requireAdmin, (req, res) => {
  try {
    const professor = db.getProfessor(req.params.id);
    if (!professor) {
      return res.status(404).json({ error: 'Professor not found' });
    }
    // Don't return password hash
    const { password_hash, ...safe } = professor;
    res.json(safe);
  } catch (err) {
    console.error('Failed to get professor:', err);
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/professors/:id', requireAuth, requireAdmin, (req, res) => {
  try {
    const { email, name, role, status } = req.body;
    const professor = db.getProfessor(req.params.id);
    if (!professor) {
      return res.status(404).json({ error: 'Professor not found' });
    }

    // Prevent demoting the last admin
    if (professor.role === 'admin' && role !== 'admin') {
      const admins = db.getProfessors().filter(p => p.role === 'admin');
      if (admins.length <= 1) {
        return res.status(400).json({ error: 'Cannot demote the last administrator' });
      }
    }

    db.updateProfessor(req.params.id, email, name, role, status);
    res.json({ success: true });
  } catch (err) {
    console.error('Failed to update professor:', err);
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/professors/:id', requireAuth, requireAdmin, (req, res) => {
  try {
    const professor = db.getProfessor(req.params.id);
    if (!professor) {
      return res.status(404).json({ error: 'Professor not found' });
    }

    // Prevent deleting the last admin
    if (professor.role === 'admin') {
      const admins = db.getProfessors().filter(p => p.role === 'admin');
      if (admins.length <= 1) {
        return res.status(400).json({ error: 'Cannot delete the last administrator' });
      }
    }

    // Prevent self-deletion
    if (professor.id === req.session.professorId) {
      return res.status(400).json({ error: 'Cannot delete your own account' });
    }

    db.deleteProfessor(req.params.id);
    res.json({ success: true });
  } catch (err) {
    console.error('Failed to delete professor:', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/professors/:id/approve', requireAuth, requireAdmin, (req, res) => {
  try {
    const professor = db.getProfessor(req.params.id);
    if (!professor) {
      return res.status(404).json({ error: 'Professor not found' });
    }
    if (professor.status !== 'waitlist') {
      return res.status(400).json({ error: 'Professor is not on waitlist' });
    }
    db.updateProfessor(req.params.id, professor.email, professor.name, professor.role, 'active');
    res.json({ success: true });
  } catch (err) {
    console.error('Failed to approve professor:', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/professors/:id/promote', requireAuth, requireAdmin, (req, res) => {
  try {
    const professor = db.getProfessor(req.params.id);
    if (!professor) {
      return res.status(404).json({ error: 'Professor not found' });
    }
    if (professor.role === 'admin') {
      return res.status(400).json({ error: 'Professor is already an admin' });
    }
    db.updateProfessor(req.params.id, professor.email, professor.name, 'admin', professor.status);
    res.json({ success: true });
  } catch (err) {
    console.error('Failed to promote professor:', err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// Settings Routes (Admin only)
// ============================================================

app.get('/api/settings', requireAuth, requireAdmin, (req, res) => {
  try {
    const settings = db.getSettings();
    res.json(settings);
  } catch (err) {
    console.error('Failed to get settings:', err);
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/settings', requireAuth, requireAdmin, (req, res) => {
  try {
    const updates = req.body;
    for (const [key, value] of Object.entries(updates)) {
      db.setSetting(key, value);
    }
    res.json({ success: true });
  } catch (err) {
    console.error('Failed to update settings:', err);
    res.status(500).json({ error: err.message });
  }
});

// API Routes
app.get('/api/images', (req, res) => {
  res.json(images);
});

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
        status: info.State.Running ? 'running' : 'stopped',
        created: session.created
      });
    } catch (err) {
      sessions.delete(id);
    }
  }

  res.json(sessionList);
});

app.post('/api/sessions', async (req, res) => {
  const { imageId, sessionName } = req.body;

  const imageConfig = images.find(i => i.id === imageId);
  if (!imageConfig) {
    return res.status(400).json({ error: 'Invalid image ID' });
  }

  const sessionId = sessionName || 'session-' + Date.now();

  try {
    // Create container on internal network with NET_ADMIN for filtering
    const container = await docker.createContainer({
      Image: imageConfig.image,
      name: 'exam-' + sessionId,
      Env: [
        'SESSION_NAME=' + sessionId
      ],
      HostConfig: {
        NetworkMode: DOCKER_NETWORK,
        CapAdd: ['NET_ADMIN'],
        Dns: ['127.0.0.1']
      }
    });

    await container.start();

    sessions.set(sessionId, {
      containerId: container.id,
      imageId: imageConfig.id,
      imageName: imageConfig.name,
      created: new Date().toISOString()
    });

    res.json({
      id: sessionId,
      connectUrl: '/vnc/' + sessionId + '/vnc.html'
    });

  } catch (err) {
    console.error('Failed to create session:', err);
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/sessions/:id', async (req, res) => {
  const { id } = req.params;
  const session = sessions.get(id);

  if (!session) {
    return res.status(404).json({ error: 'Session not found' });
  }

  try {
    const container = docker.getContainer(session.containerId);
    try {
      await container.stop();
    } catch (stopErr) {
      console.log('Container already stopped');
    }
    try {
      await container.remove();
    } catch (removeErr) {
      console.log('Container already removed');
    }
    sessions.delete(id);
    res.json({ success: true });
  } catch (err) {
    console.error('Failed to terminate session:', err);
    sessions.delete(id);
    res.status(500).json({ error: err.message });
  }
});

// Check if session container is ready (VNC accepting connections)
app.get('/api/sessions/:id/status', async (req, res) => {
  const { id } = req.params;
  const session = sessions.get(id);

  if (!session) {
    return res.status(404).json({ error: 'Session not found' });
  }

  // LMS sessions use the session ID directly as container name
  // Legacy sessions use 'exam-' + id format
  const containerName = id.startsWith('lms-') ? id : ('exam-' + id);
  const net = require('net');

  const checkReady = new Promise((resolve) => {
    const socket = new net.Socket();
    socket.setTimeout(1000);

    socket.on('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.on('error', () => resolve(false));
    socket.on('timeout', () => {
      socket.destroy();
      resolve(false);
    });

    socket.connect(6080, containerName);
  });

  const ready = await checkReady;
  res.json({ status: ready ? 'ready' : 'starting' });
});

// ============================================================
// LMS API Routes (Protected - require professor login)
// ============================================================

// --- Courses ---
app.get('/api/courses', requireAuth, (req, res) => {
  try {
    // Admins see all courses, professors see only their own
    const courses = req.session.role === 'admin'
      ? db.getCourses()
      : db.getCoursesByProfessor(req.session.professorId);
    res.json(courses);
  } catch (err) {
    console.error('Failed to get courses:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/courses/:id', requireAuth, (req, res) => {
  try {
    const course = db.getCourse(req.params.id);
    if (!course) {
      return res.status(404).json({ error: 'Course not found' });
    }
    // Check ownership (admins can access any course)
    if (req.session.role !== 'admin' && course.professor_id !== req.session.professorId) {
      return res.status(403).json({ error: 'Access denied' });
    }
    res.json(course);
  } catch (err) {
    console.error('Failed to get course:', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/courses', requireAuth, (req, res) => {
  try {
    const { name, description, language, environment_image } = req.body;
    if (!name) {
      return res.status(400).json({ error: 'Name is required' });
    }
    // Course belongs to the creating professor
    const id = db.createCourse(req.session.professorId, name, description, language, environment_image);
    res.json({ id, professor_id: req.session.professorId, name, description, language, environment_image });
  } catch (err) {
    console.error('Failed to create course:', err);
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/courses/:id', requireAuth, (req, res) => {
  try {
    const course = db.getCourse(req.params.id);
    if (!course) {
      return res.status(404).json({ error: 'Course not found' });
    }
    // Check ownership (admins can edit any course)
    if (req.session.role !== 'admin' && course.professor_id !== req.session.professorId) {
      return res.status(403).json({ error: 'Access denied' });
    }
    const { name, description, language, environment_image } = req.body;
    db.updateCourse(req.params.id, name, description, language, environment_image);
    res.json({ success: true });
  } catch (err) {
    console.error('Failed to update course:', err);
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/courses/:id', requireAuth, (req, res) => {
  try {
    const course = db.getCourse(req.params.id);
    if (!course) {
      return res.status(404).json({ error: 'Course not found' });
    }
    // Check ownership (admins can delete any course)
    if (req.session.role !== 'admin' && course.professor_id !== req.session.professorId) {
      return res.status(403).json({ error: 'Access denied' });
    }
    db.deleteCourse(req.params.id);
    res.json({ success: true });
  } catch (err) {
    console.error('Failed to delete course:', err);
    res.status(500).json({ error: err.message });
  }
});

// --- Students ---
app.get('/api/students', requireAuth, (req, res) => {
  try {
    const students = db.getStudents();
    res.json(students);
  } catch (err) {
    console.error('Failed to get students:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/students/:id', requireAuth, (req, res) => {
  try {
    const student = db.getStudent(req.params.id);
    if (!student) {
      return res.status(404).json({ error: 'Student not found' });
    }
    res.json(student);
  } catch (err) {
    console.error('Failed to get student:', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/students', requireAuth, (req, res) => {
  try {
    const { first_name, last_name, email } = req.body;
    if (!first_name || !last_name || !email) {
      return res.status(400).json({ error: 'First name, last name, and email are required' });
    }
    const id = db.createStudent(first_name, last_name, email);
    res.json({ id, first_name, last_name, email });
  } catch (err) {
    console.error('Failed to create student:', err);
    if (err.message.includes('UNIQUE constraint')) {
      return res.status(400).json({ error: 'A student with this email already exists' });
    }
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/students/:id', requireAuth, (req, res) => {
  try {
    const { first_name, last_name, email } = req.body;
    db.updateStudent(req.params.id, first_name, last_name, email);
    res.json({ success: true });
  } catch (err) {
    console.error('Failed to update student:', err);
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/students/:id', requireAuth, (req, res) => {
  try {
    db.deleteStudent(req.params.id);
    res.json({ success: true });
  } catch (err) {
    console.error('Failed to delete student:', err);
    res.status(500).json({ error: err.message });
  }
});

// --- Enrollments ---
app.get('/api/courses/:courseId/enrollments', requireAuth, (req, res) => {
  try {
    const enrollments = db.getEnrollmentsByCourse(req.params.courseId);
    res.json(enrollments);
  } catch (err) {
    console.error('Failed to get enrollments:', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/courses/:courseId/enrollments', requireAuth, (req, res) => {
  try {
    const courseId = req.params.courseId;
    const { student_id } = req.body;

    // Check if course exists
    const course = db.getCourse(courseId);
    if (!course) {
      return res.status(404).json({ error: 'Course not found' });
    }

    // Check if student exists
    const student = db.getStudent(student_id);
    if (!student) {
      return res.status(404).json({ error: 'Student not found' });
    }

    // Check if already enrolled
    const existing = db.getEnrollmentByStudentAndCourse(student_id, courseId);
    if (existing) {
      return res.status(400).json({ error: 'Student is already enrolled in this course' });
    }

    // Create enrollment with access token
    const accessToken = uuidv4();
    const id = db.createEnrollment(student_id, courseId, accessToken);

    res.json({
      id,
      student_id,
      course_id: courseId,
      access_token: accessToken,
      access_url: '/access/' + accessToken
    });
  } catch (err) {
    console.error('Failed to create enrollment:', err);
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/courses/:courseId/enrollments/:enrollmentId', requireAuth, async (req, res) => {
  try {
    const enrollment = db.getEnrollment(req.params.enrollmentId);
    if (!enrollment) {
      return res.status(404).json({ error: 'Enrollment not found' });
    }

    // Stop and remove container if exists
    if (enrollment.container_id) {
      try {
        const container = docker.getContainer(enrollment.container_id);
        await container.stop();
        await container.remove();
      } catch (containerErr) {
        console.log('Container cleanup:', containerErr.message);
      }
    }

    db.deleteEnrollment(req.params.enrollmentId);
    res.json({ success: true });
  } catch (err) {
    console.error('Failed to delete enrollment:', err);
    res.status(500).json({ error: err.message });
  }
});

// --- Restriction Templates ---
app.get('/api/templates', requireAuth, (req, res) => {
  try {
    const templates = db.getTemplates();
    res.json(templates);
  } catch (err) {
    console.error('Failed to get templates:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/templates/:id', requireAuth, (req, res) => {
  try {
    const template = db.getTemplate(req.params.id);
    if (!template) {
      return res.status(404).json({ error: 'Template not found' });
    }
    res.json(template);
  } catch (err) {
    console.error('Failed to get template:', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/templates', requireAuth, (req, res) => {
  try {
    const { name, clipboard_enabled, website_allowlist, is_exam_mode } = req.body;
    if (!name) {
      return res.status(400).json({ error: 'Name is required' });
    }
    const id = db.createTemplate(name, clipboard_enabled, website_allowlist, is_exam_mode);
    res.json({ id, name, clipboard_enabled, website_allowlist, is_exam_mode });
  } catch (err) {
    console.error('Failed to create template:', err);
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/templates/:id', requireAuth, (req, res) => {
  try {
    const { name, clipboard_enabled, website_allowlist, is_exam_mode } = req.body;
    db.updateTemplate(req.params.id, name, clipboard_enabled, website_allowlist, is_exam_mode);
    res.json({ success: true });
  } catch (err) {
    console.error('Failed to update template:', err);
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/templates/:id', requireAuth, (req, res) => {
  try {
    db.deleteTemplate(req.params.id);
    res.json({ success: true });
  } catch (err) {
    console.error('Failed to delete template:', err);
    res.status(500).json({ error: err.message });
  }
});

// --- Assignments ---
app.get('/api/courses/:courseId/assignments', requireAuth, (req, res) => {
  try {
    const assignments = db.getAssignmentsByCourse(req.params.courseId);
    res.json(assignments);
  } catch (err) {
    console.error('Failed to get assignments:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/assignments/:id', requireAuth, (req, res) => {
  try {
    const assignment = db.getAssignment(req.params.id);
    if (!assignment) {
      return res.status(404).json({ error: 'Assignment not found' });
    }
    res.json(assignment);
  } catch (err) {
    console.error('Failed to get assignment:', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/courses/:courseId/assignments', requireAuth, (req, res) => {
  try {
    const courseId = req.params.courseId;
    const { title, folder_name, instructions_md, restriction_template_id, is_exam, start_time, end_time, due_date } = req.body;

    // Check if course exists
    const course = db.getCourse(courseId);
    if (!course) {
      return res.status(404).json({ error: 'Course not found' });
    }

    if (!title || !folder_name) {
      return res.status(400).json({ error: 'Title and folder name are required' });
    }

    const id = db.createAssignment(
      courseId,
      title,
      folder_name,
      instructions_md || '',
      restriction_template_id || null,
      is_exam || false,
      start_time || null,
      end_time || null,
      due_date || null
    );

    res.json({
      id,
      course_id: courseId,
      title,
      folder_name,
      instructions_md,
      restriction_template_id,
      is_exam,
      start_time,
      end_time,
      due_date
    });
  } catch (err) {
    console.error('Failed to create assignment:', err);
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/assignments/:id', requireAuth, (req, res) => {
  try {
    const { title, folder_name, instructions_md, restriction_template_id, is_exam, start_time, end_time, due_date } = req.body;
    db.updateAssignment(
      req.params.id,
      title,
      folder_name,
      instructions_md,
      restriction_template_id || null,
      is_exam || false,
      start_time || null,
      end_time || null,
      due_date || null
    );
    res.json({ success: true });
  } catch (err) {
    console.error('Failed to update assignment:', err);
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/assignments/:id', requireAuth, (req, res) => {
  try {
    db.deleteAssignment(req.params.id);
    res.json({ success: true });
  } catch (err) {
    console.error('Failed to delete assignment:', err);
    res.status(500).json({ error: err.message });
  }
});

// --- Submissions ---
// List submissions for an assignment (reads from workspace/submissions folder)
app.get('/api/assignments/:assignmentId/submissions', requireAuth, (req, res) => {
  try {
    const assignment = db.getAssignment(req.params.assignmentId);
    if (!assignment) {
      return res.status(404).json({ error: 'Assignment not found' });
    }

    // Get all enrollments for this course to find submission files
    const enrollments = db.getEnrollmentsByCourse(assignment.course_id);
    const submissions = [];

    for (const enrollment of enrollments) {
      const submissionsDir = path.join(
        db.DATA_DIR,
        'courses',
        String(assignment.course_id),
        String(enrollment.student_id),
        'submissions'
      );

      if (!fs.existsSync(submissionsDir)) continue;

      // Look for zip files matching this assignment
      const files = fs.readdirSync(submissionsDir);
      const assignmentZips = files.filter(f =>
        f.startsWith(assignment.folder_name + '_') && f.endsWith('.zip')
      );

      for (const zipFile of assignmentZips) {
        const filePath = path.join(submissionsDir, zipFile);
        const stats = fs.statSync(filePath);
        submissions.push({
          student_id: enrollment.student_id,
          student_name: enrollment.first_name + ' ' + enrollment.last_name,
          student_email: enrollment.email,
          filename: zipFile,
          size: stats.size,
          submitted_at: stats.mtime.toISOString(),
          download_url: '/api/submissions/download/' + assignment.course_id + '/' + enrollment.student_id + '/' + encodeURIComponent(zipFile)
        });
      }
    }

    // Sort by submission time, newest first
    submissions.sort((a, b) => new Date(b.submitted_at) - new Date(a.submitted_at));
    res.json(submissions);
  } catch (err) {
    console.error('Failed to get submissions:', err);
    res.status(500).json({ error: err.message });
  }
});

// Download a submission file
app.get('/api/submissions/download/:courseId/:studentId/:filename', requireAuth, (req, res) => {
  try {
    const { courseId, studentId, filename } = req.params;
    const filePath = path.join(
      db.DATA_DIR,
      'courses',
      courseId,
      studentId,
      'submissions',
      filename
    );

    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: 'File not found' });
    }

    // Security check - ensure filename doesn't contain path traversal
    if (filename.includes('..') || filename.includes('/')) {
      return res.status(400).json({ error: 'Invalid filename' });
    }

    res.download(filePath, filename);
  } catch (err) {
    console.error('Failed to download submission:', err);
    res.status(500).json({ error: err.message });
  }
});

// --- Exam Sessions ---
// List exam sessions for an assignment
app.get('/api/assignments/:assignmentId/exam-sessions', requireAuth, (req, res) => {
  try {
    const sessions = db.getExamSessionsByAssignment(req.params.assignmentId);
    res.json(sessions);
  } catch (err) {
    console.error('Failed to get exam sessions:', err);
    res.status(500).json({ error: err.message });
  }
});

// Get all active exam sessions (for monitoring)
app.get('/api/exam-sessions/active', requireAuth, (req, res) => {
  try {
    const sessions = db.getActiveExamSessions();
    res.json(sessions);
  } catch (err) {
    console.error('Failed to get active exam sessions:', err);
    res.status(500).json({ error: err.message });
  }
});

// End an exam session (professor action)
app.post('/api/exam-sessions/:id/end', requireAuth, async (req, res) => {
  try {
    const session = db.getExamSession(req.params.id);
    if (!session) {
      return res.status(404).json({ error: 'Exam session not found' });
    }

    // Stop and remove the exam container
    if (session.container_id) {
      try {
        const container = docker.getContainer(session.container_id);
        await container.stop();
        await container.remove();
        console.log('Ended exam container:', session.container_id);
      } catch (containerErr) {
        console.log('Container cleanup:', containerErr.message);
      }
    }

    // Update session status
    db.endExamSession(session.id);

    // Remove from in-memory sessions
    const containerName = 'exam-' + session.assignment_id + '-' + session.student_id;
    sessions.delete(containerName);

    res.json({ success: true });
  } catch (err) {
    console.error('Failed to end exam session:', err);
    res.status(500).json({ error: err.message });
  }
});

// Check and terminate expired exam sessions (called periodically)
app.post('/api/exam-sessions/check-expired', requireAuth, async (req, res) => {
  try {
    const activeSessions = db.getActiveExamSessions();
    const now = new Date();
    let terminated = 0;

    for (const session of activeSessions) {
      if (session.end_time && new Date(session.end_time) < now) {
        // Exam time has ended, terminate
        if (session.container_id) {
          try {
            const container = docker.getContainer(session.container_id);
            await container.stop();
            await container.remove();
          } catch (e) {
            console.log('Container already stopped');
          }
        }
        db.endExamSession(session.id);
        const containerName = 'exam-' + session.assignment_id + '-' + session.student_id;
        sessions.delete(containerName);
        terminated++;
        console.log('Auto-terminated expired exam session:', session.id);
      }
    }

    res.json({ terminated, checked: activeSessions.length });
  } catch (err) {
    console.error('Failed to check expired sessions:', err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// Student Access & Container Management
// ============================================================

// Helper to ensure directory exists
function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

// Helper to sync assignments to student workspace
function syncAssignmentsToWorkspace(courseId, workspacePath) {
  const assignments = db.getAssignmentsByCourse(courseId);
  const assignmentsDir = path.join(workspacePath, 'assignments');
  ensureDir(assignmentsDir);

  for (const assignment of assignments) {
    const folderPath = path.join(assignmentsDir, assignment.folder_name);
    ensureDir(folderPath);

    // Write README.md with instructions
    const readmePath = path.join(folderPath, 'README.md');
    let content = `# ${assignment.title}\n\n`;

    if (assignment.due_date) {
      content += `**Due:** ${new Date(assignment.due_date).toLocaleString()}\n\n`;
    }

    if (assignment.instructions_md) {
      content += assignment.instructions_md;
    } else {
      content += '*No instructions provided.*';
    }

    fs.writeFileSync(readmePath, content, 'utf8');
    console.log('Synced assignment:', assignment.folder_name, 'to', folderPath);
  }

  return assignments.length;
}

// Helper to get container name from enrollment
function getContainerName(enrollment) {
  return 'lms-' + enrollment.course_id + '-' + enrollment.student_id;
}

// Student access endpoint - entry point for students via email link
app.get('/access/:token', async (req, res) => {
  const { token } = req.params;

  try {
    // Look up enrollment by token
    const enrollment = db.getEnrollmentByToken(token);
    if (!enrollment) {
      return res.status(404).send('Invalid or expired access link');
    }

    const containerName = getContainerName(enrollment);

    // Check if container already exists and is running
    let container;
    let needsStart = false;

    try {
      container = docker.getContainer(containerName);
      const info = await container.inspect();

      if (!info.State.Running) {
        needsStart = true;
      }
    } catch (err) {
      // Container doesn't exist, need to create it
      container = null;
    }

    if (!container) {
      // Create workspace directory for this student's course work (using container path)
      const workspacePath = path.join(db.DATA_DIR, 'courses', String(enrollment.course_id), String(enrollment.student_id));
      ensureDir(workspacePath);

      // Use HOST_DATA_DIR for Docker bind mount (actual host filesystem path)
      const hostWorkspacePath = path.join(HOST_DATA_DIR, 'courses', String(enrollment.course_id), String(enrollment.student_id));

      // Create container with volume mount
      console.log('Creating container:', containerName);
      console.log('Mounting workspace:', hostWorkspacePath, '-> /home/student/workspace');

      container = await docker.createContainer({
        Image: enrollment.environment_image || 'exam-desktop-vscode-python',
        name: containerName,
        Env: [
          'SESSION_NAME=' + containerName,
          'STUDENT_NAME=' + enrollment.first_name + ' ' + enrollment.last_name,
          'STUDENT_EMAIL=' + enrollment.email,
          'COURSE_NAME=' + enrollment.course_name
        ],
        HostConfig: {
          NetworkMode: DOCKER_NETWORK,
          CapAdd: ['NET_ADMIN'],
          Dns: ['127.0.0.1'],
          Binds: [
            hostWorkspacePath + ':/home/student/workspace'
          ]
        }
      });

      needsStart = true;

      // Update enrollment with container info
      db.updateEnrollmentContainer(enrollment.id, container.id, 'created');
    }

    if (needsStart) {
      // Sync assignments to workspace before starting
      const workspacePath = path.join(db.DATA_DIR, 'courses', String(enrollment.course_id), String(enrollment.student_id));
      ensureDir(workspacePath);
      const assignmentCount = syncAssignmentsToWorkspace(enrollment.course_id, workspacePath);
      console.log('Synced', assignmentCount, 'assignments to workspace');

      console.log('Starting container:', containerName);
      await container.start();
      db.updateEnrollmentContainer(enrollment.id, container.id, 'running');
    }

    // Add to in-memory sessions for VNC proxy compatibility
    sessions.set(containerName, {
      containerId: container.id,
      enrollmentId: enrollment.id,
      imageId: enrollment.environment_image,
      imageName: enrollment.course_name,
      created: new Date().toISOString()
    });

    // Redirect to student portal with session info
    res.redirect('/student.html?session=' + encodeURIComponent(containerName) + '&course=' + encodeURIComponent(enrollment.course_name));

  } catch (err) {
    console.error('Failed to access session:', err);
    res.status(500).send('Failed to start your session. Please try again or contact your instructor.');
  }
});

// Exam access endpoint - entry point for students taking exams
app.get('/exam/:assignmentId/:token', async (req, res) => {
  const { assignmentId, token } = req.params;

  try {
    // Look up enrollment by token
    const enrollment = db.getEnrollmentByToken(token);
    if (!enrollment) {
      return res.status(404).send('Invalid or expired access link');
    }

    // Get the exam assignment
    const exam = db.getExamAssignment(assignmentId);
    if (!exam) {
      return res.status(404).send('Exam not found or is not an exam assignment');
    }

    // Verify the exam belongs to the student's course
    if (exam.course_id !== enrollment.course_id) {
      return res.status(403).send('You are not enrolled in this course');
    }

    // Check time window
    const now = new Date();
    if (exam.start_time && new Date(exam.start_time) > now) {
      const startDate = new Date(exam.start_time).toLocaleString();
      return res.status(403).send('Exam has not started yet. Start time: ' + startDate);
    }
    if (exam.end_time && new Date(exam.end_time) < now) {
      return res.status(403).send('Exam has ended. The submission window is closed.');
    }

    // Check for existing exam session
    let examSession = db.getExamSessionByStudentAndAssignment(enrollment.student_id, assignmentId);

    // Container name for exam (different from regular course container)
    const containerName = 'exam-' + assignmentId + '-' + enrollment.student_id;

    if (examSession && examSession.status === 'completed') {
      return res.status(403).send('You have already completed this exam.');
    }

    // Create exam work directory
    const examWorkPath = path.join(db.DATA_DIR, 'exams', String(assignmentId), String(enrollment.student_id));
    ensureDir(examWorkPath);
    const hostExamWorkPath = path.join(HOST_DATA_DIR, 'exams', String(assignmentId), String(enrollment.student_id));

    let container;
    let needsStart = false;

    // Check if we need to create a new session or resume existing one
    if (!examSession) {
      // Create new exam session
      const sessionId = db.createExamSession(assignmentId, enrollment.student_id, examWorkPath);
      examSession = db.getExamSession(sessionId);
      console.log('Created new exam session:', sessionId);
    }

    // Check for existing container
    try {
      container = docker.getContainer(containerName);
      const info = await container.inspect();
      if (!info.State.Running) {
        needsStart = true;
      }
    } catch (err) {
      // Container doesn't exist, need to create it
      container = null;
    }

    if (!container) {
      // Prepare exam workspace with assignment instructions
      const assignmentDir = path.join(examWorkPath, exam.folder_name);
      ensureDir(assignmentDir);

      // Write instructions
      let instructions = '# ' + exam.title + '\n\n';
      if (exam.end_time) {
        instructions += '**Exam ends:** ' + new Date(exam.end_time).toLocaleString() + '\n\n';
      }
      if (exam.instructions_md) {
        instructions += exam.instructions_md;
      }
      fs.writeFileSync(path.join(assignmentDir, 'README.md'), instructions, 'utf8');

      console.log('Creating exam container:', containerName);
      container = await docker.createContainer({
        Image: exam.environment_image || 'exam-desktop-vscode-python',
        name: containerName,
        Env: [
          'SESSION_NAME=' + containerName,
          'STUDENT_NAME=' + enrollment.first_name + ' ' + enrollment.last_name,
          'STUDENT_EMAIL=' + enrollment.email,
          'COURSE_NAME=' + exam.course_name,
          'EXAM_MODE=true',
          'EXAM_TITLE=' + exam.title,
          'EXAM_END_TIME=' + (exam.end_time || '')
        ],
        HostConfig: {
          NetworkMode: DOCKER_NETWORK,
          CapAdd: ['NET_ADMIN'],
          Dns: ['127.0.0.1'],
          Binds: [
            hostExamWorkPath + ':/home/student/workspace'
          ]
        }
      });

      needsStart = true;
      db.updateExamSessionContainer(examSession.id, container.id);
    }

    if (needsStart) {
      console.log('Starting exam container:', containerName);
      await container.start();
    }

    // Add to in-memory sessions for VNC proxy
    sessions.set(containerName, {
      containerId: container.id,
      examSessionId: examSession.id,
      imageId: exam.environment_image,
      imageName: exam.title,
      isExam: true,
      created: new Date().toISOString()
    });

    // Redirect to exam portal
    res.redirect('/exam.html?session=' + encodeURIComponent(containerName) +
      '&exam=' + encodeURIComponent(exam.title) +
      '&end=' + encodeURIComponent(exam.end_time || ''));

  } catch (err) {
    console.error('Failed to access exam:', err);
    res.status(500).send('Failed to start your exam. Please try again or contact your instructor.');
  }
});

// Get enrollment container status
app.get('/api/enrollments/:id/status', async (req, res) => {
  try {
    const enrollment = db.getEnrollment(req.params.id);
    if (!enrollment) {
      return res.status(404).json({ error: 'Enrollment not found' });
    }

    if (!enrollment.container_id) {
      return res.json({ status: 'not_created' });
    }

    try {
      const container = docker.getContainer(enrollment.container_id);
      const info = await container.inspect();
      res.json({
        status: info.State.Running ? 'running' : 'stopped',
        containerId: enrollment.container_id
      });
    } catch (err) {
      res.json({ status: 'not_found' });
    }
  } catch (err) {
    console.error('Failed to get enrollment status:', err);
    res.status(500).json({ error: err.message });
  }
});

// Start enrollment container
app.post('/api/enrollments/:id/start', async (req, res) => {
  try {
    const enrollment = db.getEnrollment(req.params.id);
    if (!enrollment) {
      return res.status(404).json({ error: 'Enrollment not found' });
    }

    const containerName = 'lms-' + enrollment.course_id + '-' + enrollment.student_id;

    // Check if container exists
    let container;
    try {
      container = docker.getContainer(containerName);
      await container.inspect();
    } catch (err) {
      return res.status(400).json({ error: 'Container not created yet. Student must access via their link first.' });
    }

    // Sync assignments before starting
    const workspacePath = path.join(db.DATA_DIR, 'courses', String(enrollment.course_id), String(enrollment.student_id));
    ensureDir(workspacePath);
    const assignmentCount = syncAssignmentsToWorkspace(enrollment.course_id, workspacePath);
    console.log('Synced', assignmentCount, 'assignments before starting container');

    await container.start();
    db.updateEnrollmentContainer(enrollment.id, container.id, 'running');

    // Add to sessions
    sessions.set(containerName, {
      containerId: container.id,
      enrollmentId: enrollment.id,
      created: new Date().toISOString()
    });

    res.json({ success: true, status: 'running' });
  } catch (err) {
    console.error('Failed to start container:', err);
    res.status(500).json({ error: err.message });
  }
});

// Stop enrollment container
app.post('/api/enrollments/:id/stop', async (req, res) => {
  try {
    const enrollment = db.getEnrollment(req.params.id);
    if (!enrollment) {
      return res.status(404).json({ error: 'Enrollment not found' });
    }

    const containerName = 'lms-' + enrollment.course_id + '-' + enrollment.student_id;

    try {
      const container = docker.getContainer(containerName);
      await container.stop();
      db.updateEnrollmentContainer(enrollment.id, enrollment.container_id, 'stopped');

      // Remove from sessions
      sessions.delete(containerName);
    } catch (err) {
      console.log('Container stop:', err.message);
    }

    res.json({ success: true, status: 'stopped' });
  } catch (err) {
    console.error('Failed to stop container:', err);
    res.status(500).json({ error: err.message });
  }
});

// Sync assignments to running container's workspace
app.post('/api/enrollments/:id/sync', async (req, res) => {
  console.log('Sync endpoint called for enrollment:', req.params.id);
  try {
    const enrollment = db.getEnrollment(req.params.id);
    if (!enrollment) {
      console.log('Enrollment not found:', req.params.id);
      return res.status(404).json({ error: 'Enrollment not found' });
    }

    console.log('Syncing for course:', enrollment.course_id, 'student:', enrollment.student_id);

    // Sync assignments to the workspace
    const workspacePath = path.join(db.DATA_DIR, 'courses', String(enrollment.course_id), String(enrollment.student_id));
    ensureDir(workspacePath);
    const count = syncAssignmentsToWorkspace(enrollment.course_id, workspacePath);

    console.log('Sync complete:', count, 'assignments');
    res.json({ success: true, count });
  } catch (err) {
    console.error('Failed to sync assignments:', err);
    res.status(500).json({ error: err.message });
  }
});

// Check if student container is ready (VNC accepting connections)
app.get('/api/enrollments/:id/ready', async (req, res) => {
  try {
    const enrollment = db.getEnrollment(req.params.id);
    if (!enrollment) {
      return res.status(404).json({ error: 'Enrollment not found' });
    }

    const containerName = 'lms-' + enrollment.course_id + '-' + enrollment.student_id;
    const net = require('net');

    const checkReady = new Promise((resolve) => {
      const socket = new net.Socket();
      socket.setTimeout(1000);

      socket.on('connect', () => {
        socket.destroy();
        resolve(true);
      });
      socket.on('error', () => resolve(false));
      socket.on('timeout', () => {
        socket.destroy();
        resolve(false);
      });

      socket.connect(6080, containerName);
    });

    const ready = await checkReady;
    res.json({ ready });
  } catch (err) {
    console.error('Failed to check readiness:', err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// VNC Proxy Routes
// ============================================================

// VNC HTTP Proxy - proxy requests to container's noVNC
app.use('/vnc/:sessionId', (req, res) => {
  const { sessionId } = req.params;
  const session = sessions.get(sessionId);

  if (!session) {
    return res.status(404).send('Session not found');
  }

  // LMS sessions use the session ID directly as container name
  // Legacy sessions use 'exam-' + id format
  const containerName = sessionId.startsWith('lms-') ? sessionId : ('exam-' + sessionId);
  const target = 'http://' + containerName + ':6080';

  // Remove /vnc/sessionId prefix from URL
  req.url = req.url || '/';

  proxy.web(req, res, { target });
});

// ============================================================
// Frontend Routes
// ============================================================

// Landing page (public)
app.get('/', (req, res) => {
  res.sendFile('/frontend/landing.html');
});

// Login page (public)
app.get('/login', (req, res) => {
  // If already logged in, redirect to professor dashboard
  if (req.session && req.session.professorId) {
    return res.redirect('/professor.html');
  }
  res.sendFile('/frontend/login.html');
});

// Signup page (public)
app.get('/signup', (req, res) => {
  // If already logged in, redirect to professor dashboard
  if (req.session && req.session.professorId) {
    return res.redirect('/professor.html');
  }
  res.sendFile('/frontend/signup.html');
});

// Professor dashboard (protected)
app.get('/professor.html', requireAuth, (req, res) => {
  res.sendFile('/frontend/professor.html');
});

// Settings page (admin only)
app.get('/settings.html', requireAuth, requireAdmin, (req, res) => {
  res.sendFile('/frontend/settings.html');
});

// Serve frontend static files (must be after API and VNC routes)
app.use(express.static('/frontend'));

// WebSocket handling for VNC
server.on('upgrade', (req, socket, head) => {
  // Parse URL to extract session ID
  // Expected: /vnc/{sessionId}/websockify
  const match = req.url.match(/^\/vnc\/([^/]+)\/websockify/);

  if (!match) {
    socket.destroy();
    return;
  }

  const sessionId = match[1];
  const session = sessions.get(sessionId);

  if (!session) {
    socket.destroy();
    return;
  }

  // LMS sessions use the session ID directly as container name
  // Legacy sessions use 'exam-' + id format
  const containerName = sessionId.startsWith('lms-') ? sessionId : ('exam-' + sessionId);
  const targetUrl = 'ws://' + containerName + ':6080/websockify';

  console.log('WebSocket upgrade for session:', sessionId);

  // Create connection to target VNC
  const targetWs = new WebSocket(targetUrl);

  targetWs.on('open', () => {
    console.log('Connected to VNC for session:', sessionId);

    // Create WebSocket server for this connection
    const wss = new WebSocket.Server({ noServer: true });

    wss.handleUpgrade(req, socket, head, (clientWs) => {
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
        console.log('Client disconnected from session:', sessionId);
        targetWs.close();
      });

      targetWs.on('close', () => {
        console.log('VNC disconnected for session:', sessionId);
        clientWs.close();
      });

      clientWs.on('error', (err) => {
        console.error('Client WebSocket error:', err.message);
      });

      targetWs.on('error', (err) => {
        console.error('Target WebSocket error:', err.message);
      });
    });
  });

  targetWs.on('error', (err) => {
    console.error('Failed to connect to VNC:', err.message);
    socket.destroy();
  });
});

server.listen(PORT, () => {
  console.log('Gateway running on port ' + PORT);
  console.log('Using Docker network: ' + DOCKER_NETWORK);

  // Auto-terminate expired exam sessions every minute
  setInterval(async () => {
    try {
      const activeSessions = db.getActiveExamSessions();
      const now = new Date();

      for (const session of activeSessions) {
        if (session.end_time && new Date(session.end_time) < now) {
          console.log('Auto-terminating expired exam session:', session.id);
          if (session.container_id) {
            try {
              const container = docker.getContainer(session.container_id);
              await container.stop();
              await container.remove();
            } catch (e) {
              // Container may already be stopped
            }
          }
          db.endExamSession(session.id);
          const containerName = 'exam-' + session.assignment_id + '-' + session.student_id;
          sessions.delete(containerName);
        }
      }
    } catch (err) {
      console.error('Error checking expired exams:', err);
    }
  }, 60000); // Check every minute
});
