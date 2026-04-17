/**
 * claude-code-ssh-server.js
 * Unified Claude Code wrapper — runs locally or via SSH based on target_host
 * Port: 20201 (replaces port 20200)
 *
 * POST /run
 * { "task": "...", "cwd": "/path", "target_host": "192.168.50.34|192.168.50.40", "agent_token": "..." }
 * target_host defaults to local (50.40) if omitted
 */

'use strict';

const http = require('http');
const { execFile, spawn } = require('child_process');
const PORT = 20201;
const TOKEN = process.env.CLAUDE_CODE_SERVER_TOKEN || 'fleet-claude-secret-2026';
const SSH_KEY = process.env.SSH_KEY_PATH || '/home/dev-user/.ssh/id_rsa';
const SSH_USER = process.env.SSH_USER || 'dev-user';
const TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

const server = http.createServer((req, res) => {
  res.setHeader('Content-Type', 'application/json');

  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200);
    return res.end(JSON.stringify({ status: 'ok', pid: process.pid }));
  }

  if (req.method !== 'POST' || req.url !== '/run') {
    res.writeHead(404);
    return res.end(JSON.stringify({ error: 'Not found' }));
  }

  let body = '';
  req.on('data', chunk => body += chunk);
  req.on('end', () => {
    let p = {};
    try { p = JSON.parse(body || '{}'); } catch (e) {
      res.writeHead(400);
      return res.end(JSON.stringify({ error: 'Invalid JSON' }));
    }

    if (p.agent_token !== TOKEN) {
      log('Auth failed — token mismatch');
      res.writeHead(401);
      return res.end(JSON.stringify({ error: 'Unauthorized' }));
    }

    const { task, cwd, target_host } = p;
    if (!task) {
      res.writeHead(400);
      return res.end(JSON.stringify({ error: 'task is required' }));
    }

    const LOCAL_HOST = '192.168.50.40';
    const host = target_host || LOCAL_HOST;
    const isLocal = (host === LOCAL_HOST || host === '127.0.0.1' || host === 'localhost');
    const workdir = cwd || '/home/dev-user';
    const apiKey = process.env.ANTHROPIC_API_KEY || '';

    log(`${isLocal ? 'LOCAL' : 'SSH → ' + host} cwd=${workdir} task="${task.slice(0, 60)}..."`);

    let proc;
    let output = '';
    let errOutput = '';
    let timedOut = false;

    if (isLocal) {
      // Run locally using OAuth credentials (no API key)
      const claudePath = process.env.CLAUDE_BIN || `${process.env.HOME}/.npm-global/bin/claude`;
      const localEnv = { ...process.env, PATH: `${process.env.HOME}/.npm-global/bin:${process.env.PATH}` };
      delete localEnv.ANTHROPIC_API_KEY; // use OAuth from ~/.claude.json
      proc = spawn(claudePath, [
        '--print',
        '--allowedTools', 'Edit,Write,Read,Bash,Glob,Grep,LS',
        '--max-turns', '20',
        task
      ], { cwd: workdir, env: localEnv });
    } else {
      // Run via SSH
      const remoteCmd = [
        `cd ${workdir}`,
        `export PATH="$HOME/.npm-global/bin:$PATH"`,
        `export ANTHROPIC_API_KEY=${JSON.stringify(apiKey)}`,
        `claude --print --allowedTools "Edit,Write,Read,Bash,Glob,Grep,LS" --max-turns 20 ${JSON.stringify(task)}`
      ].join(' && ');
      proc = spawn('ssh', [
        '-o', 'StrictHostKeyChecking=no',
        '-o', 'ConnectTimeout=10',
        '-i', SSH_KEY,
        `${SSH_USER}@${host}`,
        remoteCmd
      ]);
    }

    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill('SIGTERM');
      log(`Task timed out after ${TIMEOUT_MS / 1000}s`);
    }, TIMEOUT_MS);

    proc.stdout.on('data', d => output += d.toString());
    proc.stderr.on('data', d => errOutput += d.toString());

    proc.on('close', (code) => {
      clearTimeout(timer);
      const success = !timedOut && code === 0;
      log(`Task complete — success=${success} output_len=${output.length} exit=${code}`);
      res.writeHead(success ? 200 : 500);
      res.end(JSON.stringify({
        success,
        output: output.trim(),
        error: timedOut ? 'timeout' : (errOutput.trim() || null),
        exit_code: code
      }));
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      log(`SSH error: ${err.message}`);
      res.writeHead(500);
      res.end(JSON.stringify({ success: false, output: '', error: err.message }));
    });
  });
});

server.listen(PORT, '127.0.0.1', () => {
  log(`claude-code-ssh-server listening on port ${PORT}`);
  log(`SSH target: ${SSH_USER}@192.168.50.34 via ${SSH_KEY}`);
});
