const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const JWT_SECRET = process.env.JWT_SECRET || 'projectflow_secret_key_production';
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static('public'));

// ── IN-MEMORY DATABASE ──
let users = [];
let projects = [];
let tasks = [];
let comments = [];
let notifications = [];
let projectMembers = [];

// ── WEBSOCKET REGISTRY ──
const clients = new Map();

// ── AUTH MIDDLEWARE ──
function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Access token missing.' });
  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ error: 'Token expired or invalid.' });
    req.user = user;
    next();
  });
}

// ── HEALTH CHECK (required for Railway) ──
app.get('/health', (req, res) => res.json({ status: 'ok' }));

// ── WEBSOCKET HANDLING ──
wss.on('connection', (ws) => {
  let authenticatedUserId = null;

  ws.on('message', async (message) => {
    try {
      const data = JSON.parse(message);
      if (data.type === 'auth') {
        const decoded = jwt.verify(data.token, JWT_SECRET);
        authenticatedUserId = decoded.id;
        clients.set(authenticatedUserId, ws);
      }
    } catch (err) {
      ws.send(JSON.stringify({ type: 'error', message: 'Auth failed.' }));
    }
  });

  ws.on('close', () => {
    if (authenticatedUserId) clients.delete(authenticatedUserId);
  });
});

function broadcastToProject(projectId, payload) {
  const targetMembers = projectMembers
    .filter(m => m.project_id == projectId)
    .map(m => m.user_id);

  targetMembers.forEach(userId => {
    const client = clients.get(userId);
    if (client && client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify(payload));
    }
  });
}

function createNotification(userId, message, linkId = null) {
  const notif = {
    id: Date.now() + Math.random(),
    user_id: userId,
    message,
    is_read: false,
    link_id: linkId,
    created_at: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  };
  notifications.push(notif);

  const client = clients.get(userId);
  if (client && client.readyState === WebSocket.OPEN) {
    client.send(JSON.stringify({ type: 'notification', message }));
  }
}

// ── AUTH ENDPOINTS ──
app.post('/api/auth/register', async (req, res) => {
  const { name, email, password } = req.body;
  if (!name || !email || !password) return res.status(400).json({ error: 'All fields required.' });
  if (users.find(u => u.email === email)) return res.status(400).json({ error: 'Email already registered.' });

  const hashedPassword = await bcrypt.hash(password, 10);
  const avatarLetters = name.split(' ').map(n => n[0]).join('').toUpperCase().substring(0, 2);

  const newUser = {
    id: Date.now(),
    name,
    email,
    password: hashedPassword,
    avatar: avatarLetters || 'U'
  };
  users.push(newUser);

  const token = jwt.sign({ id: newUser.id, email: newUser.email }, JWT_SECRET);
  res.status(201).json({ token, user: { id: newUser.id, name: newUser.name, email: newUser.email, avatar: newUser.avatar } });
});

app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;
  const user = users.find(u => u.email === email);
  if (!user) return res.status(400).json({ error: 'User not found.' });

  const validPass = await bcrypt.compare(password, user.password);
  if (!validPass) return res.status(400).json({ error: 'Invalid password.' });

  const token = jwt.sign({ id: user.id, email: user.email }, JWT_SECRET);
  res.json({ token, user: { id: user.id, name: user.name, email: user.email, avatar: user.avatar } });
});

app.get('/api/auth/me', authenticateToken, (req, res) => {
  const user = users.find(u => u.id == req.user.id);
  if (!user) return res.status(404).json({ error: 'User not found.' });
  res.json({ user: { id: user.id, name: user.name, email: user.email, avatar: user.avatar } });
});

// ── PROJECTS ──
app.get('/api/projects', authenticateToken, (req, res) => {
  const userProjects = projectMembers
    .filter(m => m.user_id == req.user.id)
    .map(m => {
      const proj = projects.find(p => p.id == m.project_id);
      if (!proj) return null;
      return {
        ...proj,
        task_count: tasks.filter(t => t.project_id == proj.id).length,
        member_count: projectMembers.filter(pm => pm.project_id == proj.id).length
      };
    })
    .filter(Boolean);

  res.json({ projects: userProjects });
});

app.post('/api/projects', authenticateToken, (req, res) => {
  const { name, description, color } = req.body;
  if (!name) return res.status(400).json({ error: 'Project name required.' });

  const newProject = { id: Date.now(), name, description, color: color || '#6366f1' };
  projects.push(newProject);
  projectMembers.push({ project_id: newProject.id, user_id: req.user.id, role: 'owner' });
  res.status(201).json({ project: newProject });
});

app.get('/api/projects/:id', authenticateToken, (req, res) => {
  const proj = projects.find(p => p.id == req.params.id);
  if (!proj) return res.status(404).json({ error: 'Project not found.' });

  const isMember = projectMembers.some(m => m.project_id == proj.id && m.user_id == req.user.id);
  if (!isMember) return res.status(403).json({ error: 'Access denied.' });

  const membersList = projectMembers
    .filter(m => m.project_id == proj.id)
    .map(m => {
      const u = users.find(user => user.id == m.user_id);
      return u ? { id: u.id, name: u.name, email: u.email, avatar: u.avatar, role: m.role } : null;
    })
    .filter(Boolean);

  res.json({ project: proj, members: membersList });
});

app.delete('/api/projects/:id', authenticateToken, (req, res) => {
  const pId = req.params.id;
  const membership = projectMembers.find(m => m.project_id == pId && m.user_id == req.user.id);
  if (!membership || membership.role !== 'owner') return res.status(403).json({ error: 'Only owners can delete projects.' });

  projects = projects.filter(p => p.id != pId);
  tasks = tasks.filter(t => t.project_id != pId);
  projectMembers = projectMembers.filter(m => m.project_id != pId);
  res.json({ success: true });
});

// ── MEMBERS ──
app.post('/api/projects/:id/members', authenticateToken, (req, res) => {
  const pId = req.params.id;
  const { email } = req.body;  // Accept email instead of user_id

  const project = projects.find(p => p.id == pId);
  if (!project) return res.status(404).json({ error: 'Project not found.' });

  const membership = projectMembers.find(m => m.project_id == pId && m.user_id == req.user.id);
  if (!membership || membership.role !== 'owner') return res.status(403).json({ error: 'Only owners can add members.' });

  const targetUser = users.find(u => u.email === email);
  if (!targetUser) return res.status(404).json({ error: 'No user found with that email. They must register first.' });

  if (projectMembers.some(m => m.project_id == pId && m.user_id == targetUser.id)) {
    return res.status(400).json({ error: 'User is already a member.' });
  }

  projectMembers.push({ project_id: pId, user_id: targetUser.id, role: 'collaborator' });
  createNotification(targetUser.id, `You've been added to project: [${project.name}].`);
  res.status(201).json({ success: true, user: { id: targetUser.id, name: targetUser.name, email: targetUser.email } });
});

app.delete('/api/projects/:id/members/:userId', authenticateToken, (req, res) => {
  const { id: pId, userId } = req.params;
  projectMembers = projectMembers.filter(m => !(m.project_id == pId && m.user_id == userId));
  res.json({ success: true });
});

// ── TASKS ──
app.get('/api/projects/:id/tasks', authenticateToken, (req, res) => {
  const pId = req.params.id;
  const projectTasks = tasks.filter(t => t.project_id == pId).map(t => {
    const assignee = users.find(u => u.id == t.assignee_id);
    return { ...t, assignee_name: assignee ? assignee.name : null };
  });
  res.json({ tasks: projectTasks });
});

app.post('/api/projects/:id/tasks', authenticateToken, (req, res) => {
  const pId = req.params.id;
  const { title, description, status, priority, due_date, assignee_id } = req.body;
  if (!title) return res.status(400).json({ error: 'Task title required.' });

  const newTask = {
    id: Date.now(),
    project_id: pId,
    title,
    description,
    status: status || 'todo',
    priority: priority || 'medium',
    due_date: due_date || null,
    assignee_id: assignee_id || null
  };
  tasks.push(newTask);

  const creator = users.find(u => u.id == req.user.id);
  const assignee = assignee_id ? users.find(u => u.id == assignee_id) : null;
  const broadcastPayload = { type: 'task_created', task: { ...newTask, assignee_name: assignee ? assignee.name : null } };

  if (assignee && assignee_id != req.user.id) {
    createNotification(assignee.id, `${creator.name} assigned task [${title}] to you.`, newTask.id);
  }

  broadcastToProject(pId, broadcastPayload);
  res.status(201).json({ task: newTask });
});

app.put('/api/projects/:id/tasks/:taskId', authenticateToken, (req, res) => {
  const { id: pId, taskId } = req.params;
  const { title, description, status, priority, due_date, assignee_id } = req.body;

  const taskIndex = tasks.findIndex(t => t.id == taskId);
  if (taskIndex === -1) return res.status(404).json({ error: 'Task not found.' });

  const oldTask = tasks[taskIndex];
  const updater = users.find(u => u.id == req.user.id);

  const updatedTask = {
    ...oldTask,
    title: title !== undefined ? title : oldTask.title,
    description: description !== undefined ? description : oldTask.description,
    status: status !== undefined ? status : oldTask.status,
    priority: priority !== undefined ? priority : oldTask.priority,
    due_date: due_date !== undefined ? due_date : oldTask.due_date,
    assignee_id: assignee_id !== undefined ? (assignee_id || null) : oldTask.assignee_id
  };

  tasks[taskIndex] = updatedTask;

  const assignee = updatedTask.assignee_id ? users.find(u => u.id == updatedTask.assignee_id) : null;

  if (assignee_id && assignee_id != oldTask.assignee_id && assignee_id != req.user.id) {
    createNotification(assignee_id, `${updater.name} assigned task [${updatedTask.title}] to you.`, taskId);
  }

  broadcastToProject(pId, { type: 'task_updated', task: { ...updatedTask, assignee_name: assignee ? assignee.name : null } });
  res.json({ task: { ...updatedTask, assignee_name: assignee ? assignee.name : null } });
});

app.delete('/api/projects/:id/tasks/:taskId', authenticateToken, (req, res) => {
  const { id: pId, taskId } = req.params;
  tasks = tasks.filter(t => t.id != taskId);
  broadcastToProject(pId, { type: 'task_deleted', taskId, project_id: pId });
  res.json({ success: true });
});

// ── COMMENTS ──
app.get('/api/tasks/:taskId/comments', authenticateToken, (req, res) => {
  const taskComments = comments.filter(c => c.task_id == req.params.taskId).map(c => {
    const commenter = users.find(u => u.id == c.user_id);
    return { ...c, user_name: commenter ? commenter.name : 'Unknown', user_avatar: commenter ? commenter.avatar : 'U' };
  });
  res.json({ comments: taskComments });
});

app.post('/api/tasks/:taskId/comments', authenticateToken, (req, res) => {
  const tId = req.params.taskId;
  const { content } = req.body;
  if (!content) return res.status(400).json({ error: 'Comment cannot be empty.' });

  const task = tasks.find(t => t.id == tId);
  const author = users.find(u => u.id == req.user.id);

  const newComment = {
    id: Date.now(),
    task_id: tId,
    user_id: req.user.id,
    content,
    created_at: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  };
  comments.push(newComment);

  if (task && task.assignee_id && task.assignee_id != req.user.id) {
    createNotification(task.assignee_id, `${author.name} commented on [${task.title}]: "${content.substring(0, 30)}..."`, tId);
  }

  if (task) {
    broadcastToProject(task.project_id, { type: 'new_comment', taskId: tId, task: { project_id: task.project_id } });
  }

  res.status(201).json({ comment: { ...newComment, user_name: author.name, user_avatar: author.avatar } });
});

// ── USER SEARCH ──
app.get('/api/users/search', authenticateToken, (req, res) => {
  const query = (req.query.q || '').toLowerCase();
  if (query.length < 2) return res.json({ users: [] });

  const matches = users
    .filter(u => u.name.toLowerCase().includes(query) || u.email.toLowerCase().includes(query))
    .map(u => ({ id: u.id, name: u.name, email: u.email, avatar: u.avatar }));

  res.json({ users: matches });
});

// ── NOTIFICATIONS ──
app.get('/api/notifications', authenticateToken, (req, res) => {
  const userNotifs = notifications.filter(n => n.user_id == req.user.id);
  res.json({ notifications: userNotifs });
});

app.put('/api/notifications/read', authenticateToken, (req, res) => {
  notifications = notifications.map(n => n.user_id == req.user.id ? { ...n, is_read: true } : n);
  res.json({ success: true });
});

// ── SEED DATA ──
(async () => {
  const rootPass = await bcrypt.hash('password123', 10);
  users.push({ id: 1, name: 'Demo User', email: 'demo@projectflow.app', password: rootPass, avatar: 'DU' });
  users.push({ id: 2, name: 'Demo Collaborator', email: 'collab@projectflow.app', password: rootPass, avatar: 'DC' });

  projects.push({ id: 101, name: 'CodeAlpha FullStack Management', description: 'Restaurant management, URL shorteners, and event registers.', color: '#7c3aed' });
  projectMembers.push({ project_id: 101, user_id: 1, role: 'owner' });
  projectMembers.push({ project_id: 101, user_id: 2, role: 'collaborator' });

  tasks.push({ id: 501, project_id: 101, title: 'Deploy to Railway platform', description: 'Configure node runtime parameters.', status: 'inprogress', priority: 'high', due_date: '2026-05-28', assignee_id: 1 });
  tasks.push({ id: 502, project_id: 101, title: 'Validate routing architecture', description: 'Check all WebSocket payloads match frontend keys.', status: 'todo', priority: 'medium', due_date: null, assignee_id: null });
})();

server.listen(PORT, () => {
  console.log(`[ProjectFlow] Running on port ${PORT}`);
});