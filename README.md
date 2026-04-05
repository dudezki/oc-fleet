<div align="center">

<!-- Banner -->
<img src="https://capsule-render.vercel.app/api?type=waving&color=0:0f0c29,50:302b63,100:24243e&height=200&section=header&text=OpenClaw%20Fleet&fontSize=70&fontColor=ffffff&fontAlignY=38&desc=AI%20Agent%20Fleet%20Orchestration%20Platform&descAlignY=58&descSize=18&animation=fadeIn" width="100%"/>

<br/>

<!-- Logo / Icon -->
<img src="https://img.shields.io/badge/🚀-Fleet%20AI-blueviolet?style=for-the-badge&labelColor=0f0c29" height="40"/>

<br/><br/>

<!-- Badges -->
[![Node.js](https://img.shields.io/badge/Node.js-24.x-339933?style=flat-square&logo=node.js&logoColor=white)](https://nodejs.org)
[![OpenClaw](https://img.shields.io/badge/OpenClaw-Powered-6366f1?style=flat-square&logo=anthropic&logoColor=white)](https://openclaw.ai)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-pgvector-4169e1?style=flat-square&logo=postgresql&logoColor=white)](https://github.com/pgvector/pgvector)
[![Docker](https://img.shields.io/badge/Docker-Ready-2496ed?style=flat-square&logo=docker&logoColor=white)](https://docker.com)
[![Telegram](https://img.shields.io/badge/Telegram-Integrated-26a5e4?style=flat-square&logo=telegram&logoColor=white)](https://telegram.org)
[![Claude](https://img.shields.io/badge/Claude-Sonnet%204.6-d97706?style=flat-square&logo=anthropic&logoColor=white)](https://anthropic.com)

[![License](https://img.shields.io/badge/License-Private-red?style=flat-square)](/)
[![Status](https://img.shields.io/badge/Status-Production-22c55e?style=flat-square)]()
[![Version](https://img.shields.io/badge/Version-2.0-8b5cf6?style=flat-square)]()

<br/>

> **oc-fleet** is a multi-agent AI orchestration platform built on [OpenClaw](https://openclaw.ai).  
> Deploy a fleet of specialized AI agents — Sales, Support, Manager, Dev, IT — each with RAG memory,  
> Telegram integration, skill routing, and a real-time dashboard. All from a single repo.

<br/>

</div>

---

## ✨ Features

| Feature | Description |
|---|---|
| 🤖 **Multi-Agent Fleet** | 5 specialized agents (Sales, Support, Manager, Dev, IT) running as isolated OpenClaw instances |
| 🧠 **RAG Memory** | pgvector-powered semantic search — agents retrieve relevant knowledge before every reply |
| 💬 **Telegram Native** | Each agent has its own bot token, DM + group support, streaming replies |
| 🔐 **OTP Pairing** | Email-based OTP to bind Telegram users to org accounts |
| 📋 **Task System** | Create, assign, and track tasks across agents and departments |
| 🔄 **Handoff Protocol** | Agents intelligently hand off conversations to the right specialist |
| 📊 **Nexus Dashboard** | Real-time Vue 3 dashboard — fleet status, conversations, memories, knowledge base |
| 🗂️ **Knowledge Base** | Upload and index org content for semantic retrieval by all agents |
| 🔌 **Google Workspace** | OAuth proxy for Gmail, Calendar, Drive integrations |
| 📡 **Session Sync** | Automatic background sync of agent sessions to PostgreSQL |
| 🚀 **One-Command Deploy** | Full Proxmox VM deploy from a single script |

---

## 🏗️ Architecture

```
                          ┌─────────────────────────────────────┐
                          │           Nexus Dashboard            │
                          │         Vue 3 + WebSocket            │
                          │            :20099                    │
                          └──────────────┬──────────────────────┘
                                         │
              ┌──────────────────────────▼──────────────────────────┐
              │                  Fleet API Proxy                     │
              │              Node.js + PostgreSQL                    │
              │                     :20000                           │
              └──┬──────────┬──────────┬──────────┬─────────────────┘
                 │          │          │          │
         ┌───────▼──┐ ┌─────▼────┐ ┌──▼──────┐ ┌▼────────┐ ┌──────────┐
         │  Sales   │ │ Support  │ │ Manager │ │   Dev   │ │    IT    │
         │ :20010   │ │ :20020   │ │ :20030  │ │ :20040  │ │  :20050  │
         │ Claude   │ │ Claude   │ │ Claude  │ │ Claude  │ │  Haiku   │
         └──────────┘ └──────────┘ └─────────┘ └─────────┘ └──────────┘
                 │          │          │          │               │
                 └──────────┴──────────┴──────────┴───────────────┘
                                      │
                            ┌─────────▼─────────┐
                            │   PostgreSQL 16    │
                            │    + pgvector      │
                            │      :5433         │
                            └───────────────────┘
```

---

## 🚀 Quick Deploy (Proxmox VM)

### Prerequisites
- Ubuntu 22.04+ VM on Proxmox
- Internet access from the VM
- GitHub PAT or SSH key with repo access

### 1. Clone
```bash
git clone https://github.com/dudezki/oc-fleet.git
cd oc-fleet
```

### 2. Configure
```bash
cp .env.example .env
nano .env   # fill in your API keys and tokens
```

### 3. Deploy
```bash
bash scripts/deploy-proxmox.sh
```

That's it. The script handles everything — Node.js, Docker, OpenClaw, DB migration, agent setup, and startup.

---

## ⚙️ Environment Variables

Copy `.env.example` to `.env` and fill in the required values:

| Variable | Required | Description |
|---|---|---|
| `ANTHROPIC_API_KEY` | ✅ | Claude API key |
| `GEMINI_API_KEY` | ✅ | Gemini API key (primary embeddings) |
| `GATEWAY_TOKEN_SALES` | ✅ | OpenClaw gateway token for Sales agent |
| `GATEWAY_TOKEN_SUPPORT` | ✅ | OpenClaw gateway token for Support agent |
| `GATEWAY_TOKEN_MANAGER` | ✅ | OpenClaw gateway token for Manager agent |
| `GATEWAY_TOKEN_DEV` | ✅ | OpenClaw gateway token for Dev agent |
| `GATEWAY_TOKEN_IT` | ✅ | OpenClaw gateway token for IT agent |
| `BOT_TOKEN_SALES` | ✅ | Telegram bot token for Fleet-Sales |
| `BOT_TOKEN_SUPPORT` | ✅ | Telegram bot token for Fleet-Support |
| `BOT_TOKEN_MANAGER` | ✅ | Telegram bot token for Fleet-Manager |
| `BOT_TOKEN_DEV` | ✅ | Telegram bot token for Fleet-Dev |
| `BOT_TOKEN_IT` | ✅ | Telegram bot token for Fleet-IT |
| `GOOGLE_CLIENT_ID` | ⚡ | Google OAuth client ID |
| `GOOGLE_CLIENT_SECRET` | ⚡ | Google OAuth client secret |
| `RESEND_API_KEY` | ⚡ | Resend API key (email OTP) |

> Generate gateway tokens with: `openssl rand -hex 32`

---

## 🛠️ Fleet Management

After deploy, use the `fleet` command from anywhere:

```bash
# Status check
fleet status

# Start / Stop / Restart
fleet start all
fleet stop all
fleet restart all

# Individual agents
fleet start sales
fleet restart support
fleet stop manager

# Services only
fleet proxy
fleet dashboard
```

---

## 📦 Project Structure

```
oc-fleet/
├── proxy/                  # Fleet API Proxy (Node.js + pg)
│   ├── server.js           # API endpoints + RAG logic
│   └── chunker.js          # Text chunking + embedding
├── schema/
│   └── fleet-rag-schema-migration.sql   # Full DB schema
├── google-auth-proxy/      # Google OAuth proxy service
├── instances/              # Agent identity files
│   ├── sales/SOUL.md
│   ├── support/SOUL.md
│   ├── manager/SOUL.md
│   ├── dev/SOUL.md
│   ├── it/SOUL.md
│   ├── SOUL.base.md        # Shared protocol (all agents)
│   └── SOUL_TEMPLATE.md    # Template for new agents
├── scripts/
│   ├── deploy-proxmox.sh   # 🚀 One-command Proxmox deploy
│   ├── fleet.sh            # Fleet management CLI
│   ├── sync-sessions.js    # Session sync cron worker
│   └── build-souls.sh      # Rebuild agent SOUL.md files
├── .env.example            # Environment template
└── README.md
```

---

## 🤖 Agent Roster

| Agent | Bot | Port | Model | Role |
|---|---|---|---|---|
| 🟢 **Fleet-Sales** | @CBFleetSales_bot | 20010 | Claude Sonnet 4.6 | Lead qualification, proposals, CRM |
| 🔵 **Fleet-Support** | @CBFleetSupport_bot | 20020 | Claude Sonnet 4.6 | Technical support, troubleshooting |
| 🟣 **Fleet-Manager** | @CBFleetManager_bot | 20030 | Claude Sonnet 4.6 | Escalations, admin, oversight |
| 🟠 **Fleet-Dev** | @CBFleetDev_bot | 20040 | Claude Sonnet 4.6 | Engineering, integrations, builds |
| ⚫ **Fleet-IT** | @CBFleetIT_bot | 20050 | Claude Haiku 4.5 | Infrastructure, access, IT ops |

---

## 🔄 Agent Protocol

Every agent follows a strict 6-step protocol on each message:

```
1. Pairing Check     → Verify Telegram user is bound to org account
2. Log Inbound       → Record message to conversation history
3. RAG Lookup        → Semantic search across org knowledge base
4. Respond           → Generate reply using retrieved context
5. Log Outbound      → Record reply to conversation history
6. Store Memory      → Save meaningful context for future sessions
```

Handoffs between agents are automatic — if a user's question belongs to another specialist, the agent creates a handoff and the receiving agent picks up with full context.

---

## 📡 API Endpoints (Proxy :20000)

| Endpoint | Method | Description |
|---|---|---|
| `/fleet-api/pairing/check` | POST | Check + log inbound, verify pairing |
| `/fleet-api/pairing/otp/send` | POST | Send OTP to user email |
| `/fleet-api/pairing/otp/verify` | POST | Verify OTP and bind Telegram |
| `/fleet-api/search/embed` | POST | Semantic RAG search |
| `/fleet-api/knowledge/upsert` | POST | Index org content |
| `/fleet-api/conversation/log` | POST | Log messages |
| `/fleet-api/handoff` | POST | Create / list / accept handoffs |
| `/fleet-api/store` | POST | Store episodic memory |
| `/fleet-api/agent/config` | POST | Fetch agent config + skill map |
| `/fleet-api/skills/list` | POST | List assigned skills for agent |
| `/fleet-api/tasks/*` | POST | Task CRUD operations |

---

## 🗄️ Database Schema

PostgreSQL 16 + pgvector on Docker (`cbfleet-rag-db`, port `5433`).

**Core tables** (all under `fleet` schema):

```
organizations → departments → agents
                           ↘ users → telegram_bindings
memories (pgvector)
conversations → messages → conversation_summaries
handoffs
tasks → task_assignments
accounts → otp_verifications
skills → agent_skill_assignments
callbacks
```

---

## 🧩 Adding a New Agent

1. Add a new `instances/<name>/SOUL.md` with agent identity
2. Add the agent to `fleet.agents` table in the DB
3. Create a new Telegram bot via @BotFather
4. Add tokens to `.env`
5. Run `deploy-proxmox.sh` or manually create the instance dir

---

<div align="center">

<img src="https://capsule-render.vercel.app/api?type=waving&color=0:24243e,50:302b63,100:0f0c29&height=100&section=footer" width="100%"/>

**Built with ❤️ by [OrbAI.app](https://orbai.app) · Powered by [OpenClaw](https://openclaw.ai) + [Anthropic Claude](https://anthropic.com)**

</div>
