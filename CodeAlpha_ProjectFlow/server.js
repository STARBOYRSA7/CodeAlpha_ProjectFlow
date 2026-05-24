const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const cors = require('cors');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const JWT_SECRET = process.env.JWT_SECRET || 'projectflow_secret_key_production';
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static('public')); // Serve frontend assets seamlessly

// ── IN-MEMORY DATABASE CLUSTERS (REPLACE WITH SQL / RAILWAY ATTACHMENTS) ──
let users = [];
let projects = [];
let tasks = [];
let comments = [];
let notifications = [];
let projectMembers = []; // Structure: { project_id, user_id, role }

// ── WEBSOCKET LIVE SOCKET REGISTRY MAP ──
const clients = new Map(); // Map user_id -> ws client instance

// ── BACKEND AUTHENTICATION INTERCEPTOR MIDDLEWARE ──
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

// ── WEBSOCKET CONNECTION HANDLING PIPELINE ──
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
      ws.send(JSON.stringify({ type: 'error', message: 'Auth pipeline crash.' }));
    }
  });

  ws.on('close', () => {
    if (authenticatedUserId) clients.delete(authenticatedUserId);
  });
});

// Broadcast live synchronization updates to verified team members
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

// Push notification object into tracking engine storage array and fire live trigger
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

// ── AUTHENTICATION CONTROLLER ENDPOINTS ──
app.post('/api/auth/register', async (req, res) => {
  const { name, email, password } = req.body;
  if (!name || !email || !password) return res.status(400).json({ error: 'Missing configuration layout data.' });

  if (users.find(u => u.email === email)) return res.status(400).json({ error: 'Identity already registered.' });

  const hashedPassword = await bcrypt.hash(password, 10);
  const avatarLetters = name.split(' ').map(n => n[0]).join('').toUpperCase().substring(0, 2);

  const newUser = {
    id: users.length + 1,
    name,
    email,
    password: hashedPassword,
    avatar: avatarLetters || '👤'
  };
  users.push(newUser);

  const token = jwt.sign({ id: newUser.id, email: newUser.email }, JWT_SECRET);
  res.status(201).json({ token, user: { name: newUser.name, email: newUser.email, avatar: newUser.avatar } });
});

app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;
  const user = users.find(u => u.email === email);
  if (!user) return res.status(400).json({ error: 'User workspace identity not found.' });

  const validPass = await bcrypt.compare(password, user.password);
  if (!validPass) return res.status(400).json({ error: 'Security credential rejection.' });

  const token = jwt.sign({ id: user.id, email: user.email }, JWT_SECRET);
  res.json({ token, user: { name: user.name, email: user.email, avatar: user.avatar } });
});

// ── PROJECT WORKSPACE API ENDPOINTS ──
app.get('/api/projects', authenticateToken, (req, res) => {
  const userProjects = projectMembers
    .filter(m => m.user_id == req.user.id)
    .map(m => {
      const proj = projects.find(p => p.id == m.project_id);
      if (!proj) return null;
      
      const tCount = tasks.filter(t => t.project_id == proj.id).length;
      const mCount = projectMembers.filter(pm => pm.project_id == proj.id).length;
      
      return { ...proj, task_count: tCount, member_count: mCount };
    })
    .filter(Boolean);

  res.json({ projects: userProjects });
});

app.post('/api/projects', authenticateToken, (req, res) => {
  const { name, description, color } = req.body;
  if (!name) return res.status(400).json({ error: 'Module workspace context title mandatory.' });

  const newProject = {
    id: projects.length + 1,
    name,
    description,
    color: color || '#5b6af0'
  };
  projects.push(newProject);

  projectMembers.push({ project_id: newProject.id, user_id: req.user.id, role: 'owner' });
  res.status(201).json({ project: newProject });
});

app.get('/api/projects/:id', authenticateToken, (req, res) => {
  const proj = projects.find(p => p.id == req.params.id);
  if (!proj) return res.status(404).json({ error: 'Workspace target node clean.' });

  const isMember = projectMembers.some(m => m.project_id == proj.id && m.user_id == req.user.id);
  if (!isMember) return res.status(403).json({ error: 'Authorization token permission leak.' });

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
  
  if (!membership || membership.role !== 'owner') return res.status(403).json({ error: 'Ownership verification rejected.' });

  projects = projects.filter(p => p.id != pId);
  tasks = tasks.filter(t => t.project_id != pId);
  projectMembers = projectMembers.filter(m => m.project_id != pId);

  res.json({ success: true });
});

// ── KANBAN TASKS CONTROLLER BLOCK ──
app.get('/api/projects/:id/tasks', authenticateToken, (req, res) => {
  const pId = req.params.id;
  const projectTasks = tasks.filter(t => t.project_id == pId).map(t => {
    const assignee = users.find(u => u.id == t.assignee_id);
    return { ...t, assignee_name: assignee ? assignee.name : 'Unassigned' };
  });
  res.json({ tasks: projectTasks });
});

app.post('/api/projects/:id/tasks', authenticateToken, (req, res) => {
  const pId = req.params.id;
  const { title, description, status, priority, due_date, assignee_id } = req.body;

  if (!title) return res.status(400).json({ error: 'Task payload title block expected.' });

  const newTask = {
    id: tasks.length + 1,
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
  const broadcastPayload = { type: 'task_created', task: { ...newTask, assignee_name: 'Unassigned' } };

  if (assignee_id) {
    const assignee = users.find(u => u.id == assignee_id);
    if (assignee) {
      broadcastPayload.task.assignee_name = assignee.name;
      if (assignee_id != req.user.id) {
        createNotification(assignee.id, `${creator.name} allocated ticket [${title}] to your workflow portfolio.`, newTask.id);
      }
    }
  }

  broadcastToProject(pId, broadcastPayload);
  res.status(201).json({ task: newTask });
});

app.put('/api/projects/:id/tasks/:taskId', authenticateToken, (req, res) => {
  const { id: pId, taskId } = req.params;
  const { title, description, status, priority, due_date, assignee_id } = req.body;

  let taskIndex = tasks.findIndex(t => t.id == taskId);
  if (taskIndex === -1) return res.status(404).json({ error: 'Task structure reference lost.' });

  const oldTask = tasks[taskIndex];
  const updater = users.find(u => u.id == req.user.id);

  const updatedTask = {
    ...oldTask,
    title: title || oldTask.title,
    description: description !== undefined ? description : oldTask.description,
    status: status || oldTask.status,
    priority: priority || oldTask.priority,
    due_date: due_date !== undefined ? due_date : oldTask.due_date,
    assignee_id: assignee_id !== undefined ? assignee_id : oldTask.assignee_id
  };

  tasks[taskIndex] = updatedTask;

  const targetUser = users.find(u => u.id == updatedTask.assignee_id);
  const responsePayload = {
    ...updatedTask,
    assignee_name: targetUser ? targetUser.name : 'Unassigned'
  };

  if (assignee_id && assignee_id != oldTask.assignee_id && assignee_id != req.user.id) {
    createNotification(assignee_id, `${updater.name} assigned task ticket [${updatedTask.title}] to you.`, taskId);
  }

  broadcastToProject(pId, { type: 'task_updated', task: responsePayload });
  res.json({ task: responsePayload });
});

app.delete('/api/projects/:id/tasks/:taskId', authenticateToken, (req, res) => {
  const { id: pId, taskId } = req.params;
  tasks = tasks.filter(t => t.id != taskId);
  
  broadcastToProject(pId, { type: 'task_deleted', taskId, project_id: pId });
  res.json({ success: true });
});

// ── TASK DISCUSSIONS TRACKING ENGINE ──
app.get('/api/tasks/:taskId/comments', authenticateToken, (req, res) => {
  const tId = req.params.taskId;
  const taskComments = comments.filter(c => c.task_id == tId).map(c => {
    const commenter = users.find(u => u.id == c.user_id);
    return {
      ...c,
      user_name: commenter ? commenter.name : 'Unknown User',
      user_avatar: commenter ? commenter.avatar : '👤'
    };
  });
  res.json({ comments: taskComments });
});

app.post('/api/tasks/:taskId/comments', authenticateToken, (req, res) => {
  const tId = req.params.taskId;
  const { content } = req.body;

  if (!content) return res.status(400).json({ error: 'Empty commentary streams blocked.' });

  const task = tasks.find(t => t.id == tId);
  const author = users.find(u => u.id == req.user.id);

  const newComment = {
    id: comments.length + 1,
    task_id: tId,
    user_id: req.user.id,
    content,
    created_at: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  };
  comments.push(newComment);

  if (task && task.assignee_id && task.assignee_id != req.user.id) {
    createNotification(task.assignee_id, `${author.name} commented on [${task.title}]: "${content.substring(0, 20)}..."`, tId);
  }

  if (task) {
    broadcastToProject(task.project_id, { type: 'new_comment', taskId: tId });
  }

  res.status(201).json({ comment: newComment });
});

// ── PROFILE IDENTITY DISCOVERY SEARCH PIPELINE ──
app.get('/api/users/search', authenticateToken, (req, res) => {
  const query = (req.query.q || '').toLowerCase();
  if (query.length < 2) return res.json({ users: [] });

  const matches = users
    .filter(u => u.name.toLowerCase().includes(query) || u.email.toLowerCase().includes(query))
    .map(u => ({ id: u.id, name: u.name, email: u.email, avatar: u.avatar }));

  res.json({ users: matches });
});

app.post('/api/projects/:id/members', authenticateToken, (req, res) => {
  const pId = req.params.id;
  const { user_id } = req.body;

  const project = projects.find(p => p.id == pId);
  if (projectMembers.some(m => m.project_id == pId && m.user_id == user_id)) {
    return res.status(400).json({ error: 'Identity already contains allocation keys.' });
  }

  projectMembers.push({ project_id: pId, user_id, role: 'collaborator' });
  
  createNotification(user_id, `You have been added to the workspace: [${project.name}].`);
  res.status(201).json({ success: true });
});

app.delete('/api/projects/:id/members/:userId', authenticateToken, (req, res) => {
  const { id: pId, userId } = req.params;
  projectMembers = projectMembers.filter(m => !(m.project_id == pId && m.user_id == userId));
  res.json({ success: true });
});

// ── LIVE NOTIFICATION COLLECTION ROUTERS ──
app.get('/api/notifications', authenticateToken, (req, res) => {
  const userNotifs = notifications.filter(n => n.user_id == req.user.id);
  res.json({ notifications: userNotifs });
});

app.put('/api/notifications/read', authenticateToken, (req, res) => {
  notifications = notifications.map(n => n.user_id == req.user.id ? { ...n, is_read: true } : n);
  res.json({ success: true });
});

// ── INJECT DEFAULT ENTRY REGISTRIES FOR VERIFICATION FLOWS ──
(async () => {
  const rootPass = await bcrypt.hash('password123', 10);
  users.push({ id: 1, name: 'Sizwe Sigubudu', email: 'sizuma@rosebankcollege.co.za', password: rootPass, avatar: 'SS' });
  users.push({ id: 2, name: 'Alpha Tester', email: 'tester@codealpha.com', password: rootPass, avatar: 'AT' });
  
  projects.push({ id: 101, name: 'CodeAlpha FullStack Management', description: 'Restaurant management, URL shorteners, and event registers.', color: '#7c3aed' });
  projectMembers.push({ project_id: 101, user_id: 1, role: 'owner' });
  projectMembers.push({ project_id: 101, user_id: 2, role: 'collaborator' });

  tasks.push({ id: 501, project_id: 101, title: 'Deploy core build system directly to Railway platform engine', description: 'Configure node clusters runtime parameters.', status: 'inprogress', priority: 'high', due_date: '2026-05-28', assignee_id: 1 });
  tasks.push({ id: 502, project_id: 101, title: 'Inspect routing architecture alignment with client-side parameters', description: 'Validate all live sockets payloads mappings match front end keys.', status: 'todo', priority: 'medium', due_date: '', assignee_id: null });
})();

// Run the combined server instance
server.listen(PORT, () => {
  console.log(`[ProjectFlow Runtime] Server processing traffic on address port ${PORT}`);
});