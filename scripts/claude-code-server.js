#!/usr/bin/env node
/**
 * claude-code-server.js
 * HTTP wrapper around the `claude` CLI — port 20200
 * POST /run  { task, cwd?, agent_token }
 */

const http = require('http');
const { spawn } = require('child_process');
const fs   = require('fs');

const PORT    = 20200;
const LOG     = '/tmp/claude-code-server.log';
const TIMEOUT = 5 * 60 * 1000; // 5 minutes

const TOKEN   = process.env.CLAUDE_CODE_SERVER_TOKEN;
const API_KEY = process.env.ANTHROPIC_API_KEY;

const CLAUDE  = '/home/dev-user/.npm-global/bin/claude';

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  process.stdout.write(line);
  fs.appendFileSync(LOG, line);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => { data += chunk; });
    req.on('end', () => {
      try { resolve(JSON.parse(data)); }
      catch (e) { reject(new Error('Invalid JSON body')); }
    });
    req.on('error', reject);
  });
}

function runClaude(task, cwd) {
  return new Promise((resolve) => {
    const args = [
      '--print', task,
      '--allowedTools', 'Edit,Write,Read,Bash,Glob,Grep,LS',
      '--max-turns', '20',
      '--output-format', 'text',
    ];

    log(`Running claude in cwd=${cwd || process.cwd()} task="${task.slice(0, 80)}..."`);

    const proc = spawn(CLAUDE, args, {
      cwd: cwd || process.cwd(),
      env: { ...process.env, ANTHROPIC_API_KEY: API_KEY },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill('SIGTERM');
      log('Claude process timed out after 5 minutes');
    }, TIMEOUT);

    proc.stdout.on('data', d => { stdout += d.toString(); });
    proc.stderr.on('data', d => { stderr += d.toString(); });

    proc.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) {
        resolve({ success: false, output: stdout, error: 'Timed out after 5 minutes' });
      } else if (code === 0) {
        resolve({ success: true, output: stdout, error: null });
      } else {
        resolve({ success: false, output: stdout, error: stderr || `Exit code ${code}` });
      }
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      resolve({ success: false, output: '', error: err.message });
    });
  });
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', pid: process.pid }));
    return;
  }

  if (req.method !== 'POST' || req.url !== '/run') {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: false, error: 'Not found' }));
    return;
  }

  let body;
  try {
    body = await readBody(req);
  } catch (e) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: false, error: e.message }));
    return;
  }

  const { task, cwd, agent_token } = body;

  // Auth
  if (!TOKEN || agent_token !== TOKEN) {
    log(`Auth failed — token mismatch`);
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: false, error: 'Unauthorized' }));
    return;
  }

  if (!task || typeof task !== 'string') {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: false, error: '`task` is required' }));
    return;
  }

  // Validate cwd if provided
  if (cwd) {
    try {
      const stat = fs.statSync(cwd);
      if (!stat.isDirectory()) throw new Error('Not a directory');
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: `Invalid cwd: ${e.message}` }));
      return;
    }
  }

  const result = await runClaude(task, cwd);

  log(`Task complete — success=${result.success} output_len=${result.output.length}`);

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(result));
});

server.listen(PORT, '0.0.0.0', () => {
  log(`claude-code-server listening on port ${PORT}`);
});

server.on('error', (err) => {
  log(`Server error: ${err.message}`);
  process.exit(1);
});
