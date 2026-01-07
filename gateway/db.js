const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');

// Ensure data directory exists
const DATA_DIR = process.env.DATA_DIR || '/data';
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const DB_PATH = path.join(DATA_DIR, 'lms.db');
const db = new Database(DB_PATH);

// Enable foreign keys
db.pragma('foreign_keys = ON');

// Create tables using better-sqlite3's exec method (SQL execution, not shell)
const schema = `
  -- Courses taught by professor
  CREATE TABLE IF NOT EXISTS courses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    professor_id INTEGER REFERENCES professors(id) ON DELETE SET NULL,
    name TEXT NOT NULL,
    description TEXT,
    language TEXT DEFAULT 'python',
    environment_image TEXT DEFAULT 'exam-desktop-vscode-python',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  -- Students (global, can be in multiple courses)
  CREATE TABLE IF NOT EXISTS students (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    first_name TEXT NOT NULL,
    last_name TEXT NOT NULL,
    email TEXT UNIQUE NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  -- Links students to courses with their container
  CREATE TABLE IF NOT EXISTS enrollments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
    course_id INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
    container_id TEXT,
    container_status TEXT DEFAULT 'stopped',
    access_token TEXT UNIQUE NOT NULL,
    enrolled_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(student_id, course_id)
  );

  -- Restriction profiles (clipboard, websites, etc.)
  CREATE TABLE IF NOT EXISTS restriction_templates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    clipboard_enabled INTEGER DEFAULT 1,
    website_allowlist TEXT,
    is_exam_mode INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  -- Assignments/Exams within a course
  CREATE TABLE IF NOT EXISTS assignments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    course_id INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    folder_name TEXT NOT NULL,
    instructions_md TEXT,
    restriction_template_id INTEGER REFERENCES restriction_templates(id),
    is_exam INTEGER DEFAULT 0,
    start_time DATETIME,
    end_time DATETIME,
    due_date DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  -- Starter files for assignments
  CREATE TABLE IF NOT EXISTS assignment_files (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    assignment_id INTEGER NOT NULL REFERENCES assignments(id) ON DELETE CASCADE,
    filename TEXT NOT NULL,
    file_path TEXT NOT NULL,
    uploaded_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  -- Student submissions
  CREATE TABLE IF NOT EXISTS submissions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    assignment_id INTEGER NOT NULL REFERENCES assignments(id) ON DELETE CASCADE,
    student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
    zip_path TEXT NOT NULL,
    submitted_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  -- Exam sessions (separate containers)
  CREATE TABLE IF NOT EXISTS exam_sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    assignment_id INTEGER NOT NULL REFERENCES assignments(id) ON DELETE CASCADE,
    student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
    container_id TEXT,
    work_volume_path TEXT,
    status TEXT DEFAULT 'pending',
    started_at DATETIME,
    ended_at DATETIME
  );

  -- Professors (for authentication)
  CREATE TABLE IF NOT EXISTS professors (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    name TEXT,
    role TEXT DEFAULT 'professor',
    status TEXT DEFAULT 'active',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  -- System settings (key-value store)
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  -- Create indexes for common queries
  CREATE INDEX IF NOT EXISTS idx_enrollments_token ON enrollments(access_token);
  CREATE INDEX IF NOT EXISTS idx_enrollments_container ON enrollments(container_id);
  CREATE INDEX IF NOT EXISTS idx_assignments_course ON assignments(course_id);
  CREATE INDEX IF NOT EXISTS idx_submissions_assignment ON submissions(assignment_id);
  CREATE INDEX IF NOT EXISTS idx_professors_email ON professors(email);
`;

db.exec(schema);

// ============================================================
// Migrations for existing databases
// ============================================================

// Check if professors table has role column, add if missing
try {
  db.prepare('SELECT role FROM professors LIMIT 1').get();
} catch (e) {
  console.log('Migrating professors table: adding role column');
  db.prepare('ALTER TABLE professors ADD COLUMN role TEXT DEFAULT \'professor\'').run();
}

// Check if professors table has status column, add if missing
try {
  db.prepare('SELECT status FROM professors LIMIT 1').get();
} catch (e) {
  console.log('Migrating professors table: adding status column');
  db.prepare('ALTER TABLE professors ADD COLUMN status TEXT DEFAULT \'active\'').run();
}

// Check if courses table has professor_id column, add if missing
try {
  db.prepare('SELECT professor_id FROM courses LIMIT 1').get();
} catch (e) {
  console.log('Migrating courses table: adding professor_id column');
  db.prepare('ALTER TABLE courses ADD COLUMN professor_id INTEGER REFERENCES professors(id) ON DELETE SET NULL').run();
}

// Update existing demo account to admin if it has default role
db.prepare(`
  UPDATE professors SET role = 'admin', status = 'active'
  WHERE email = 'demo@example.com' AND (role IS NULL OR role = 'professor')
`).run();

// Seed default restriction templates
const seedTemplates = db.prepare(`
  INSERT OR IGNORE INTO restriction_templates (name, clipboard_enabled, website_allowlist, is_exam_mode)
  VALUES (?, ?, ?, ?)
`);

const defaultTemplates = [
  {
    name: 'Open Homework',
    clipboard_enabled: 1,
    website_allowlist: `docs.python.org
python.org
developer.mozilla.org
mdn.mozilla.org
stackoverflow.com
stackexchange.com
pypi.org
readthedocs.io
readthedocs.org
github.com
microsoft.com
google.com`,
    is_exam_mode: 0
  },
  {
    name: 'Restricted Lab',
    clipboard_enabled: 1,
    website_allowlist: `docs.python.org
python.org
developer.mozilla.org
mdn.mozilla.org
stackoverflow.com
pypi.org
readthedocs.io`,
    is_exam_mode: 0
  },
  {
    name: 'Closed Exam',
    clipboard_enabled: 0,
    website_allowlist: `docs.python.org
python.org`,
    is_exam_mode: 1
  }
];

for (const template of defaultTemplates) {
  seedTemplates.run(
    template.name,
    template.clipboard_enabled,
    template.website_allowlist,
    template.is_exam_mode
  );
}

// Seed demo professor account (as admin)
const seedProfessor = db.prepare(`
  INSERT OR IGNORE INTO professors (email, password_hash, name, role, status)
  VALUES (?, ?, ?, ?, ?)
`);
const demoPasswordHash = bcrypt.hashSync('demo123', 10);
seedProfessor.run('demo@example.com', demoPasswordHash, 'Demo Professor', 'admin', 'active');

// Seed default settings
const seedSetting = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
seedSetting.run('waitlist_enabled', 'false');
seedSetting.run('session_timeout_hours', '24');
seedSetting.run('default_template_id', '1');

// Migrate existing courses to demo admin if professor_id is null
const migrateCoursesStmt = db.prepare(`
  UPDATE courses SET professor_id = (SELECT id FROM professors WHERE email = 'demo@example.com')
  WHERE professor_id IS NULL
`);
migrateCoursesStmt.run();

// ============================================================
// Prepared statements
// ============================================================

// Courses
const getCourses = db.prepare('SELECT c.*, p.name as professor_name FROM courses c LEFT JOIN professors p ON c.professor_id = p.id ORDER BY c.created_at DESC');
const getCoursesByProfessor = db.prepare('SELECT * FROM courses WHERE professor_id = ? ORDER BY created_at DESC');
const getCourse = db.prepare('SELECT * FROM courses WHERE id = ?');
const createCourse = db.prepare(
  'INSERT INTO courses (professor_id, name, description, language, environment_image) VALUES (?, ?, ?, ?, ?)'
);
const updateCourse = db.prepare(
  'UPDATE courses SET name = ?, description = ?, language = ?, environment_image = ? WHERE id = ?'
);
const deleteCourse = db.prepare('DELETE FROM courses WHERE id = ?');

// Students
const getStudents = db.prepare('SELECT * FROM students ORDER BY last_name, first_name');
const getStudent = db.prepare('SELECT * FROM students WHERE id = ?');
const getStudentByEmail = db.prepare('SELECT * FROM students WHERE email = ?');
const createStudent = db.prepare(
  'INSERT INTO students (first_name, last_name, email) VALUES (?, ?, ?)'
);
const updateStudent = db.prepare(
  'UPDATE students SET first_name = ?, last_name = ?, email = ? WHERE id = ?'
);
const deleteStudent = db.prepare('DELETE FROM students WHERE id = ?');

// Enrollments
const getEnrollmentsByCourse = db.prepare(`
  SELECT e.*, s.first_name, s.last_name, s.email
  FROM enrollments e
  JOIN students s ON e.student_id = s.id
  WHERE e.course_id = ?
  ORDER BY s.last_name, s.first_name
`);
const getEnrollment = db.prepare('SELECT * FROM enrollments WHERE id = ?');
const getEnrollmentByToken = db.prepare(`
  SELECT e.*, c.name as course_name, c.environment_image, c.language,
         s.first_name, s.last_name, s.email
  FROM enrollments e
  JOIN courses c ON e.course_id = c.id
  JOIN students s ON e.student_id = s.id
  WHERE e.access_token = ?
`);
const getEnrollmentByStudentAndCourse = db.prepare(
  'SELECT * FROM enrollments WHERE student_id = ? AND course_id = ?'
);
const createEnrollment = db.prepare(
  'INSERT INTO enrollments (student_id, course_id, access_token) VALUES (?, ?, ?)'
);
const updateEnrollmentContainer = db.prepare(
  'UPDATE enrollments SET container_id = ?, container_status = ? WHERE id = ?'
);
const deleteEnrollment = db.prepare('DELETE FROM enrollments WHERE id = ?');

// Restriction Templates
const getTemplates = db.prepare('SELECT * FROM restriction_templates ORDER BY name');
const getTemplate = db.prepare('SELECT * FROM restriction_templates WHERE id = ?');
const createTemplate = db.prepare(
  'INSERT INTO restriction_templates (name, clipboard_enabled, website_allowlist, is_exam_mode) VALUES (?, ?, ?, ?)'
);
const updateTemplate = db.prepare(
  'UPDATE restriction_templates SET name = ?, clipboard_enabled = ?, website_allowlist = ?, is_exam_mode = ? WHERE id = ?'
);
const deleteTemplate = db.prepare('DELETE FROM restriction_templates WHERE id = ?');

// Assignments
const getAssignmentsByCourse = db.prepare(`
  SELECT a.*, rt.name as template_name
  FROM assignments a
  LEFT JOIN restriction_templates rt ON a.restriction_template_id = rt.id
  WHERE a.course_id = ?
  ORDER BY a.created_at DESC
`);
const getAssignment = db.prepare('SELECT * FROM assignments WHERE id = ?');
const createAssignment = db.prepare(`
  INSERT INTO assignments (course_id, title, folder_name, instructions_md, restriction_template_id, is_exam, start_time, end_time, due_date)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
const updateAssignment = db.prepare(`
  UPDATE assignments SET title = ?, folder_name = ?, instructions_md = ?, restriction_template_id = ?, is_exam = ?, start_time = ?, end_time = ?, due_date = ?
  WHERE id = ?
`);
const deleteAssignment = db.prepare('DELETE FROM assignments WHERE id = ?');

// Submissions
const getSubmissionsByAssignment = db.prepare(`
  SELECT sub.*, s.first_name, s.last_name, s.email
  FROM submissions sub
  JOIN students s ON sub.student_id = s.id
  WHERE sub.assignment_id = ?
  ORDER BY sub.submitted_at DESC
`);
const createSubmission = db.prepare(
  'INSERT INTO submissions (assignment_id, student_id, zip_path) VALUES (?, ?, ?)'
);

// Professors
const getProfessors = db.prepare('SELECT id, email, name, role, status, created_at FROM professors ORDER BY created_at DESC');
const getProfessorByEmail = db.prepare('SELECT * FROM professors WHERE email = ?');
const getProfessor = db.prepare('SELECT * FROM professors WHERE id = ?');
const createProfessor = db.prepare(
  'INSERT INTO professors (email, password_hash, name, role, status) VALUES (?, ?, ?, ?, ?)'
);
const updateProfessor = db.prepare(
  'UPDATE professors SET email = ?, name = ?, role = ?, status = ? WHERE id = ?'
);
const updateProfessorPassword = db.prepare(
  'UPDATE professors SET password_hash = ? WHERE id = ?'
);
const deleteProfessor = db.prepare('DELETE FROM professors WHERE id = ?');

// Settings
const getSettings = db.prepare('SELECT * FROM settings');
const getSetting = db.prepare('SELECT value FROM settings WHERE key = ?');
const setSetting = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');

// Container lookup (for VNC proxy routing)
const getEnrollmentByContainerId = db.prepare(`
  SELECT e.*, c.environment_image, rt.clipboard_enabled, rt.website_allowlist
  FROM enrollments e
  JOIN courses c ON e.course_id = c.id
  LEFT JOIN restriction_templates rt ON rt.id = (
    SELECT restriction_template_id FROM assignments WHERE course_id = c.id LIMIT 1
  )
  WHERE e.container_id = ?
`);

// Exam Sessions
const getExamSessionsByAssignment = db.prepare(`
  SELECT es.*, s.first_name, s.last_name, s.email
  FROM exam_sessions es
  JOIN students s ON es.student_id = s.id
  WHERE es.assignment_id = ?
  ORDER BY es.started_at DESC
`);
const getExamSession = db.prepare('SELECT * FROM exam_sessions WHERE id = ?');
const getExamSessionByStudentAndAssignment = db.prepare(
  'SELECT * FROM exam_sessions WHERE student_id = ? AND assignment_id = ?'
);
const getActiveExamSessions = db.prepare(`
  SELECT es.*, a.title as assignment_title, a.end_time, s.first_name, s.last_name
  FROM exam_sessions es
  JOIN assignments a ON es.assignment_id = a.id
  JOIN students s ON es.student_id = s.id
  WHERE es.status = 'active'
`);
const createExamSession = db.prepare(`
  INSERT INTO exam_sessions (assignment_id, student_id, work_volume_path, status, started_at)
  VALUES (?, ?, ?, 'active', datetime('now'))
`);
const updateExamSessionContainer = db.prepare(
  'UPDATE exam_sessions SET container_id = ? WHERE id = ?'
);
const endExamSession = db.prepare(
  "UPDATE exam_sessions SET status = 'completed', ended_at = datetime('now') WHERE id = ?"
);
const getExamAssignment = db.prepare(`
  SELECT a.*, c.name as course_name, c.environment_image, rt.clipboard_enabled, rt.website_allowlist
  FROM assignments a
  JOIN courses c ON a.course_id = c.id
  LEFT JOIN restriction_templates rt ON a.restriction_template_id = rt.id
  WHERE a.id = ? AND a.is_exam = 1
`);

// ============================================================
// Export module
// ============================================================

module.exports = {
  db,
  DATA_DIR,

  // Courses
  getCourses: () => getCourses.all(),
  getCoursesByProfessor: (professorId) => getCoursesByProfessor.all(professorId),
  getCourse: (id) => getCourse.get(id),
  createCourse: (professorId, name, description, language, image) => {
    const result = createCourse.run(professorId, name, description, language || 'python', image || 'exam-desktop-vscode-python');
    return result.lastInsertRowid;
  },
  updateCourse: (id, name, description, language, image) => updateCourse.run(name, description, language, image, id),
  deleteCourse: (id) => deleteCourse.run(id),

  // Students
  getStudents: () => getStudents.all(),
  getStudent: (id) => getStudent.get(id),
  getStudentByEmail: (email) => getStudentByEmail.get(email),
  createStudent: (firstName, lastName, email) => {
    const result = createStudent.run(firstName, lastName, email);
    return result.lastInsertRowid;
  },
  updateStudent: (id, firstName, lastName, email) => updateStudent.run(firstName, lastName, email, id),
  deleteStudent: (id) => deleteStudent.run(id),

  // Enrollments
  getEnrollmentsByCourse: (courseId) => getEnrollmentsByCourse.all(courseId),
  getEnrollment: (id) => getEnrollment.get(id),
  getEnrollmentByToken: (token) => getEnrollmentByToken.get(token),
  getEnrollmentByStudentAndCourse: (studentId, courseId) => getEnrollmentByStudentAndCourse.get(studentId, courseId),
  createEnrollment: (studentId, courseId, token) => {
    const result = createEnrollment.run(studentId, courseId, token);
    return result.lastInsertRowid;
  },
  updateEnrollmentContainer: (id, containerId, status) => updateEnrollmentContainer.run(containerId, status, id),
  deleteEnrollment: (id) => deleteEnrollment.run(id),

  // Templates
  getTemplates: () => getTemplates.all(),
  getTemplate: (id) => getTemplate.get(id),
  createTemplate: (name, clipboardEnabled, websiteAllowlist, isExamMode) => {
    const result = createTemplate.run(name, clipboardEnabled ? 1 : 0, websiteAllowlist, isExamMode ? 1 : 0);
    return result.lastInsertRowid;
  },
  updateTemplate: (id, name, clipboardEnabled, websiteAllowlist, isExamMode) =>
    updateTemplate.run(name, clipboardEnabled ? 1 : 0, websiteAllowlist, isExamMode ? 1 : 0, id),
  deleteTemplate: (id) => deleteTemplate.run(id),

  // Assignments
  getAssignmentsByCourse: (courseId) => getAssignmentsByCourse.all(courseId),
  getAssignment: (id) => getAssignment.get(id),
  createAssignment: (courseId, title, folderName, instructionsMd, templateId, isExam, startTime, endTime, dueDate) => {
    const result = createAssignment.run(courseId, title, folderName, instructionsMd, templateId, isExam ? 1 : 0, startTime, endTime, dueDate);
    return result.lastInsertRowid;
  },
  updateAssignment: (id, title, folderName, instructionsMd, templateId, isExam, startTime, endTime, dueDate) =>
    updateAssignment.run(title, folderName, instructionsMd, templateId, isExam ? 1 : 0, startTime, endTime, dueDate, id),
  deleteAssignment: (id) => deleteAssignment.run(id),

  // Submissions
  getSubmissionsByAssignment: (assignmentId) => getSubmissionsByAssignment.all(assignmentId),
  createSubmission: (assignmentId, studentId, zipPath) => {
    const result = createSubmission.run(assignmentId, studentId, zipPath);
    return result.lastInsertRowid;
  },

  // Container lookup
  getEnrollmentByContainerId: (containerId) => getEnrollmentByContainerId.get(containerId),

  // Professors
  getProfessors: () => getProfessors.all(),
  getProfessorByEmail: (email) => getProfessorByEmail.get(email),
  getProfessor: (id) => getProfessor.get(id),
  createProfessor: (email, password, name, role = 'professor', status = 'active') => {
    const hash = bcrypt.hashSync(password, 10);
    const result = createProfessor.run(email, hash, name, role, status);
    return result.lastInsertRowid;
  },
  updateProfessor: (id, email, name, role, status) => updateProfessor.run(email, name, role, status, id),
  updateProfessorPassword: (id, password) => {
    const hash = bcrypt.hashSync(password, 10);
    return updateProfessorPassword.run(hash, id);
  },
  deleteProfessor: (id) => deleteProfessor.run(id),
  verifyProfessorPassword: (email, password) => {
    const professor = getProfessorByEmail.get(email);
    if (!professor) return null;
    if (bcrypt.compareSync(password, professor.password_hash)) {
      return professor;
    }
    return null;
  },

  // Settings
  getSettings: () => {
    const rows = getSettings.all();
    const settings = {};
    for (const row of rows) {
      settings[row.key] = row.value;
    }
    return settings;
  },
  getSetting: (key) => {
    const row = getSetting.get(key);
    return row ? row.value : null;
  },
  setSetting: (key, value) => setSetting.run(key, String(value)),

  // Exam Sessions
  getExamSessionsByAssignment: (assignmentId) => getExamSessionsByAssignment.all(assignmentId),
  getExamSession: (id) => getExamSession.get(id),
  getExamSessionByStudentAndAssignment: (studentId, assignmentId) =>
    getExamSessionByStudentAndAssignment.get(studentId, assignmentId),
  getActiveExamSessions: () => getActiveExamSessions.all(),
  createExamSession: (assignmentId, studentId, workVolumePath) => {
    const result = createExamSession.run(assignmentId, studentId, workVolumePath);
    return result.lastInsertRowid;
  },
  updateExamSessionContainer: (id, containerId) => updateExamSessionContainer.run(containerId, id),
  endExamSession: (id) => endExamSession.run(id),
  getExamAssignment: (id) => getExamAssignment.get(id)
};
