const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cookieParser = require('cookie-parser');
const path = require('path');
const fs = require('fs');
const http = require('http');
const { WebSocketServer } = require('ws');
const initSqlJs = require('sql.js');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'projectflow_secret_change_in_prod';

// Railway ephemeral storage fix: Write to /tmp if no persistent volume disk is bound
const DB_PATH = process.env.DB_PATH || path.join('/tmp', 'projectflow.db');

// ── Database ─────────────────────────────────────────────────────────────────
let db;

async function initDB() {
  const SQL = await initSqlJs();
  
  console.log(`Targeting database path: ${DB_PATH}`);
  db = fs.existsSync(DB_PATH)
    ? new SQL.Database(fs.readFileSync(DB_PATH))
    : new SQL.Database();

  db.run(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    avatar TEXT DEFAULT '👤',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS projects (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    description TEXT,
    color TEXT DEFAULT '#6366f1',
    owner_id INTEGER NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (owner_id) REFERENCES users(id)
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS project_members (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    role TEXT DEFAULT 'member',
    joined_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(project_id, user_id),
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL,
    title TEXT NOT NULL,
    description TEXT,
    status TEXT DEFAULT 'todo',
    priority TEXT DEFAULT 'medium',
    assignee_id INTEGER,
    due_date TEXT,
    created_by INTEGER NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
    FOREIGN KEY (assignee_id) REFERENCES users(id),
    FOREIGN KEY (created_by) REFERENCES users(id)
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS comments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    content TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id)
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS notifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    type TEXT NOT NULL,
    message TEXT NOT NULL,
    link_id INTEGER,
    is_read INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  )`);

  saveDB();
  console.log('Database initialization verification complete.');
}

function saveDB() {
  try {
    const data = db.export();
    fs.writeFileSync(DB_PATH, Buffer.from(data));
  } catch (err) {
    console.error('Failed to commit database state changes to storage cluster:', err);
  }
}

function dbGet(sql, params = []) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const row = stmt.step() ? stmt.getAsObject() : null;
  stmt.free();
  return row;
}

function dbAll(sql, params = []) {
  const result = db.exec(sql, params);
  if (!result.length) return [];
  const { columns, values } = result[0];
  return values.map(row => Object.fromEntries(columns.map((c, i) => [c, row[i]])));
}

function dbRun(sql, params = []) {
  db.run(sql, params);
  const lastId = db.exec('SELECT last_insert_rowid()')[0]?.values[0][0];
  saveDB();
  return { lastInsertRowid: lastId };
}

// ── WebSocket ─────────────────────────────────────────────────────────────────
const clients = new Map();

wss.on('connection', (ws) => {
  let userId = null;

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw);
      if (msg.type === 'auth') {
        try {
          const user = jwt.verify(msg.token, JWT_SECRET);
          userId = user.id;
          if (!clients.has(userId)) clients.set(userId, new Set());
          clients.get(userId).add(ws);
          ws.send(JSON.stringify({ type: 'auth_ok' }));
        } catch {
          ws.send(JSON.stringify({ type: 'auth_error' }));
        }
      }
    } catch {}
  });

  ws.on('close', () => {
    if (userId && clients.has(userId)) {
      clients.get(userId).delete(ws);
      if (clients.get(userId).size === 0) clients.delete(userId);
    }
  });
});

function pushToUser(userId, data) {
  if (!clients.has(userId)) return;
  const payload = JSON.stringify(data);
  clients.get(userId).forEach(ws => {
    if (ws.readyState === 1) ws.send(payload);
  });
}

function createNotification(userId, type, message, linkId = null) {
  dbRun('INSERT INTO notifications (user_id, type, message, link_id) VALUES (?, ?, ?, ?)',
    [userId, type, message, linkId]);
  pushToUser(userId, { type: 'notification', message, notifType: type, linkId });
}

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// Serve static assets from project root context safely if no public directory wrapper exists
app.use(express.static(path.join(__dirname)));
app.use(express.static(path.join(__dirname, 'public')));

function requireAuth(req, res, next) {
  const token = req.cookies.token || (req.headers.authorization || '').split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Not authenticated' });
  try { req.user = jwt.verify(token, JWT_SECRET); next(); }
  catch { res.status(401).json({ error: 'Invalid or expired session' }); }
}

function requireProjectMember(req, res, next) {
  const projectId = req.params.projectId || req.body.project_id;
  const member = dbGet('SELECT * FROM project_members WHERE project_id=? AND user_id=?', [projectId, req.user.id]);
  if (!member) return res.status(403).json({ error: 'Not a member of this project' });
  req.member = member;
  next();
}

// ── Auth API Routes ───────────────────────────────────────────────────────────
app.post('/api/auth/register', (req, res) => {
  try {
    const { name, email, password } = req.body;
    if (!name || !email || !password) return res.status(400).json({ error: 'All fields required.' });
    if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters.' });
    
    if (dbGet('SELECT id FROM users WHERE email=?', [email])) {
      return res.status(409).json({ error: 'Account already exists.' });
    }

    const hashed = bcrypt.hashSync(password, 10);
    const avatars = ['🧑','👩','👨','🧔','👩‍💻','👨‍💻','🧑‍💼','👩‍🎨'];
    const avatar = avatars[Math.floor(Math.random() * avatars.length)];
    const result = dbRun('INSERT INTO users (name,email,password,avatar) VALUES (?,?,?,?)', [name, email, hashed, avatar]);
    
    const user = { id: result.lastInsertRowid, name, email, avatar };
    const token = jwt.sign(user, JWT_SECRET, { expiresIn: '7d' });
    
    res.cookie('token', token, { httpOnly: true, maxAge: 7*24*60*60*1000, sameSite: 'lax' });
    return res.json({ user, token });
  } catch (err) {
    console.error('CRITICAL SIGNUP LOG ERROR:', err.message);
    return res.status(500).json({ error: 'Internal system deployment error during profile provisioning.' });
  }
});

app.post('/api/auth/login', (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password required.' });
    
    const user = dbGet('SELECT * FROM users WHERE email=?', [email]);
    if (!user || !bcrypt.compareSync(password, user.password)) {
      return res.status(401).json({ error: 'Invalid email or password.' });
    }
    
    const payload = { id: user.id, name: user.name, email: user.email, avatar: user.avatar };
    const token = jwt.sign(payload, JWT_SECRET, { expiresIn: '7d' });
    
    res.cookie('token', token, { httpOnly: true, maxAge: 7*24*60*60*1000, sameSite: 'lax' });
    return res.json({ user: payload, token });
  } catch (err) {
    console.error('CRITICAL LOGIN LOG ERROR:', err.message);
    return res.status(500).json({ error: 'Internal system validation processing failure.' });
  }
});

app.post('/api/auth/logout', (req, res) => { res.clearCookie('token'); res.json({ message: 'Logged out' }); });

app.get('/api/auth/me', requireAuth, (req, res) => {
  const user = dbGet('SELECT id,name,email,avatar,created_at FROM users WHERE id=?', [req.user.id]);
  res.json({ user });
});

app.get('/api/users/search', requireAuth, (req, res) => {
  const { q } = req.query;
  if (!q || q.length < 2) return res.json({ users: [] });
  const users = dbAll('SELECT id,name,email,avatar FROM users WHERE (name LIKE ? OR email LIKE ?) AND id != ? LIMIT 8',
    [`%${q}%`, `%${q}%`, req.user.id]);
  res.json({ users });
});

// ── Projects ──────────────────────────────────────────────────────────────────
app.get('/api/projects', requireAuth, (req, res) => {
  const projects = dbAll(`
    SELECT p.*, u.name as owner_name,
      (SELECT COUNT(*) FROM tasks t WHERE t.project_id=p.id) as task_count,
      (SELECT COUNT(*) FROM project_members pm2 WHERE pm2.project_id=p.id) as member_count
    FROM projects p
    JOIN project_members pm ON pm.project_id=p.id AND pm.user_id=?
    JOIN users u ON u.id=p.owner_id
    ORDER BY p.created_at DESC
  `, [req.user.id]);
  res.json({ projects });
});

app.post('/api/projects', requireAuth, (req, res) => {
  const { name, description, color } = req.body;
  if (!name) return res.status(400).json({ error: 'Project name required.' });
  const result = dbRun('INSERT INTO projects (name,description,color,owner_id) VALUES (?,?,?,?)',
    [name, description || '', color || '#6366f1', req.user.id]);
  dbRun('INSERT INTO project_members (project_id,user_id,role) VALUES (?,?,?)',
    [result.lastInsertRowid, req.user.id, 'owner']);
  const project = dbGet('SELECT * FROM projects WHERE id=?', [result.lastInsertRowid]);
  res.json({ project });
});

app.get('/api/projects/:projectId', requireAuth, requireProjectMember, (req, res) => {
  const project = dbGet('SELECT p.*, u.name as owner_name FROM projects p JOIN users u ON u.id=p.owner_id WHERE p.id=?', [req.params.projectId]);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  const members = dbAll('SELECT u.id,u.name,u.email,u.avatar,pm.role FROM project_members pm JOIN users u ON u.id=pm.user_id WHERE pm.project_id=?', [req.params.projectId]);
  res.json({ project, members });
});

app.delete('/api/projects/:projectId', requireAuth, (req, res) => {
  const project = dbGet('SELECT * FROM projects WHERE id=? AND owner_id=?', [req.params.projectId, req.user.id]);
  if (!project) return res.status(403).json({ error: 'Only the owner can delete this project.' });
  dbRun('DELETE FROM projects WHERE id=?', [req.params.projectId]);
  res.json({ message: 'Project deleted' });
});

// ── Project Members ───────────────────────────────────────────────────────────
app.post('/api/projects/:projectId/members', requireAuth, requireProjectMember, (req, res) => {
  const { user_id } = req.body;
  if (req.member.role !== 'owner') return res.status(403).json({ error: 'Only owners can add members.' });
  const user = dbGet('SELECT id,name FROM users WHERE id=?', [user_id]);
  if (!user) return res.status(404).json({ error: 'User not found.' });
  if (dbGet('SELECT id FROM project_members WHERE project_id=? AND user_id=?', [req.params.projectId, user_id]))
    return res.status(409).json({ error: 'User is already a member.' });

  dbRun('INSERT INTO project_members (project_id,user_id,role) VALUES (?,?,?)', [req.params.projectId, user_id, 'member']);
  const project = dbGet('SELECT name FROM projects WHERE id=?', [req.params.projectId]);
  createNotification(user_id, 'invite', `You were added to project "${project.name}"`, req.params.projectId);
  res.json({ message: 'Member added' });
});

app.delete('/api/projects/:projectId/members/:userId', requireAuth, (req, res) => {
  const project = dbGet('SELECT * FROM projects WHERE id=? AND owner_id=?', [req.params.projectId, req.user.id]);
  if (!project) return res.status(403).json({ error: 'Only owners can remove members.' });
  dbRun('DELETE FROM project_members WHERE project_id=? AND user_id=?', [req.params.projectId, req.params.userId]);
  res.json({ message: 'Member removed' });
});

// ── Tasks ─────────────────────────────────────────────────────────────────────
app.get('/api/projects/:projectId/tasks', requireAuth, requireProjectMember, (req, res) => {
  const tasks = dbAll(`
    SELECT t.*, u.name as assignee_name, u.avatar as assignee_avatar,
           c.name as creator_name
    FROM tasks t
    LEFT JOIN users u ON u.id=t.assignee_id
    LEFT JOIN users c ON c.id=t.created_by
    WHERE t.project_id=?
    ORDER BY t.created_at ASC
  `, [req.params.projectId]);
  res.json({ tasks });
});

app.post('/api/projects/:projectId/tasks', requireAuth, requireProjectMember, (req, res) => {
  const { title, description, status, priority, assignee_id, due_date } = req.body;
  if (!title) return res.status(400).json({ error: 'Task title required.' });
  const validStatus = ['todo','inprogress','review','done'];
  const validPriority = ['low','medium','high'];
  const result = dbRun(`
    INSERT INTO tasks (project_id,title,description,status,priority,assignee_id,due_date,created_by)
    VALUES (?,?,?,?,?,?,?,?)`,
    [req.params.projectId, title, description || '', validStatus.includes(status)?status:'todo',
     validPriority.includes(priority)?priority:'medium', assignee_id||null, due_date||null, req.user.id]);

  const task = dbGet('SELECT * FROM tasks WHERE id=?', [result.lastInsertRowid]);

  if (assignee_id && assignee_id !== req.user.id) {
    const project = dbGet('SELECT name FROM projects WHERE id=?', [req.params.projectId]);
    createNotification(assignee_id, 'task_assigned', `You were assigned "${title}" in ${project.name}`, result.lastInsertRowid);
  }

  const members = dbAll('SELECT user_id FROM project_members WHERE project_id=?', [req.params.projectId]);
  members.forEach(m => pushToUser(m.user_id, { type: 'task_created', task }));

  res.json({ task });
});

app.put('/api/projects/:projectId/tasks/:taskId', requireAuth, requireProjectMember, (req, res) => {
  const task = dbGet('SELECT * FROM tasks WHERE id=? AND project_id=?', [req.params.taskId, req.params.projectId]);
  if (!task) return res.status(404).json({ error: 'Task not found' });

  const { title, description, status, priority, assignee_id, due_date } = req.body;
  dbRun(`UPDATE tasks SET title=?,description=?,status=?,priority=?,assignee_id=?,due_date=? WHERE id=?`,
    [title??task.title, description??task.description, status??task.status,
     priority??task.priority, assignee_id!==undefined?assignee_id:task.assignee_id,
     due_date!==undefined?due_date:task.due_date, req.params.taskId]);

  const updated = dbGet(`SELECT t.*,u.name as assignee_name,u.avatar as assignee_avatar FROM tasks t LEFT JOIN users u ON u.id=t.assignee_id WHERE t.id=?`, [req.params.taskId]);

  if (assignee_id && assignee_id !== task.assignee_id && assignee_id !== req.user.id) {
    const project = dbGet('SELECT name FROM projects WHERE id=?', [req.params.projectId]);
    createNotification(assignee_id, 'task_assigned', `You were assigned "${updated.title}" in ${project.name}`, req.params.taskId);
  }

  const members = dbAll('SELECT user_id FROM project_members WHERE project_id=?', [req.params.projectId]);
  members.forEach(m => pushToUser(m.user_id, { type: 'task_updated', task: updated }));

  res.json({ task: updated });
});

app.delete('/api/projects/:projectId/tasks/:taskId', requireAuth, requireProjectMember, (req, res) => {
  dbRun('DELETE FROM tasks WHERE id=? AND project_id=?', [req.params.taskId, req.params.projectId]);
  const members = dbAll('SELECT user_id FROM project_members WHERE project_id=?', [req.params.projectId]);
  members.forEach(m => pushToUser(m.user_id, { type: 'task_deleted', taskId: Number(req.params.taskId) }));
  res.json({ message: 'Task deleted' });
});

// ── Comments ──────────────────────────────────────────────────────────────────
app.get('/api/tasks/:taskId/comments', requireAuth, (req, res) => {
  const comments = dbAll(`
    SELECT c.*,u.name as user_name,u.avatar as user_avatar
    FROM comments c JOIN users u ON u.id=c.user_id
    WHERE c.task_id=? ORDER BY c.created_at ASC
  `, [req.params.taskId]);
  res.json({ comments });
});

app.post('/api/tasks/:taskId/comments', requireAuth, (req, res) => {
  const { content } = req.body;
  if (!content || !content.trim()) return res.status(400).json({ error: 'Comment cannot be empty.' });
  const task = dbGet('SELECT * FROM tasks WHERE id=?', [req.params.taskId]);
  if (!task) return res.status(404).json({ error: 'Task not found' });

  const result = dbRun('INSERT INTO comments (task_id,user_id,content) VALUES (?,?,?)',
    [req.params.taskId, req.user.id, content.trim()]);
  const comment = dbGet('SELECT c.*,u.name as user_name,u.avatar as user_avatar FROM comments c JOIN users u ON u.id=c.user_id WHERE c.id=?', [result.lastInsertRowid]);

  const notifyIds = new Set([task.assignee_id, task.created_by].filter(id => id && id !== req.user.id));
  notifyIds.forEach(uid => {
    createNotification(uid, 'comment', `${req.user.name} commented on "${task.title}"`, task.id);
  });

  const members = dbAll('SELECT user_id FROM project_members WHERE project_id=?', [task.project_id]);
  members.forEach(m => pushToUser(m.user_id, { type: 'new_comment', taskId: task.id, comment }));

  res.json({ comment });
});

// ── Notifications ─────────────────────────────────────────────────────────────
app.get('/api/notifications', requireAuth, (req, res) => {
  const notifications = dbAll('SELECT * FROM notifications WHERE user_id=? ORDER BY created_at DESC LIMIT 30', [req.user.id]);
  res.json({ notifications });
});

app.put('/api/notifications/read', requireAuth, (req, res) => {
  dbRun('UPDATE notifications SET is_read=1 WHERE user_id=?', [req.user.id]);
  res.json({ message: 'Marked as read' });
});

// ── Catch-all ──────────────────────────────────────────────────────────────────
app.get('/health', (req, res) => res.json({ status: 'ok' }));

// Fix: Fallback check both paths if the build environment shifts layout locations
app.get('*', (req, res) => {
  const rootPath = path.join(__dirname, 'index.html');
  if (fs.existsSync(rootPath)) {
    return res.sendFile(rootPath);
  }
  return res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── Start ─────────────────────────────────────────────────────────────────────
initDB().then(() => {
  server.listen(PORT, () => console.log(`ProjectFlow active on configuration target port: ${PORT}`));
}).catch(err => { console.error('DB init failed:', err); process.exit(1); });