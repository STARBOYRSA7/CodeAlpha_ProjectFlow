# ProjectFlow — Full Stack Project Management Tool
### CodeAlpha Full Stack Internship — Task 3

A complete full-stack collaborative project management tool built with Node.js, Express.js, WebSockets, and SQLite. Similar to Trello/Asana. Deployable to Render.com for free.

---

## Features

- **Group Projects** — Create projects, set colours and descriptions
- **Kanban Board** — Four columns: To Do, In Progress, In Review, Done
- **Task Cards** — Title, description, priority, assignee, due date
- **Task Assignment** — Assign tasks to any project member; assignee gets notified
- **Comments** — Comment on any task; all stakeholders get notified
- **Team Members** — Add/remove members by name or email search
- **Real-Time Updates** — WebSockets push task changes and comments live to all project members
- **Notifications** — In-app notification panel with unread badge
- **Auth System** — Register/login with bcrypt + JWT

---

## Tech Stack

| Layer | Technology |
|---|---|
| Backend | Node.js + Express.js |
| Real-Time | WebSockets (ws library) |
| Database | SQLite (sql.js — pure JS, no native build) |
| Auth | bcryptjs + JSON Web Tokens + HTTP-only cookies |
| Frontend | HTML, CSS, Vanilla JavaScript |
| Deploy | Render.com (free tier) |

---

## Local Setup

```bash
git clone https://github.com/STARBOYRSA7/CodeAlpha_ProjectFlow
cd CodeAlpha_ProjectFlow
npm install
npm start
# Visit http://localhost:3000
```

---

## Deploy to Render.com

1. Push this repo to GitHub as `CodeAlpha_ProjectFlow`
2. Go to [render.com](https://render.com) → **New → Web Service**
3. Connect your GitHub repo
4. Render reads `render.yaml` — confirm:
   - **Build:** `npm install`
   - **Start:** `node server.js`
5. Add env var: `JWT_SECRET` → click **Generate**
6. Deploy ✅

---

## API Endpoints

| Method | Route | Auth | Description |
|---|---|---|---|
| POST | `/api/auth/register` | No | Register |
| POST | `/api/auth/login` | No | Login |
| POST | `/api/auth/logout` | No | Logout |
| GET | `/api/auth/me` | Yes | Current user |
| GET | `/api/users/search?q=` | Yes | Search users |
| GET | `/api/projects` | Yes | My projects |
| POST | `/api/projects` | Yes | Create project |
| GET | `/api/projects/:id` | Member | Project + members |
| DELETE | `/api/projects/:id` | Owner | Delete project |
| POST | `/api/projects/:id/members` | Owner | Add member |
| DELETE | `/api/projects/:id/members/:uid` | Owner | Remove member |
| GET | `/api/projects/:id/tasks` | Member | All tasks |
| POST | `/api/projects/:id/tasks` | Member | Create task |
| PUT | `/api/projects/:id/tasks/:tid` | Member | Update task |
| DELETE | `/api/projects/:id/tasks/:tid` | Member | Delete task |
| GET | `/api/tasks/:id/comments` | Yes | Task comments |
| POST | `/api/tasks/:id/comments` | Yes | Add comment |
| GET | `/api/notifications` | Yes | My notifications |
| PUT | `/api/notifications/read` | Yes | Mark all read |

---

## Project Structure

```
CodeAlpha_ProjectFlow/
├── server.js          # Express + WebSocket server + all API routes
├── public/
│   └── index.html     # Full frontend (HTML/CSS/JS — Kanban board)
├── package.json
├── render.yaml
├── .gitignore
└── README.md
```

---

*Built by Sizwe Sigubudu for the CodeAlpha Full Stack Development Internship.*
