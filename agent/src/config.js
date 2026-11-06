'use strict';
const path = require('path');
const fs = require('fs');

function req(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required environment variable ${name}`);
  return v;
}

const DATA_DIR = path.resolve(req('DATA_DIR'));

const config = {
  port: parseInt(process.env.AGENT_PORT || '9000', 10),
  DATA_DIR,
  SITES_DIR: path.join(DATA_DIR, 'sites'),
  TRASH_DIR: path.join(DATA_DIR, 'trash'),
  RUNTIME_DIR: path.join(DATA_DIR, 'runtime'),
  PROXY_CONF_DIR: path.join(DATA_DIR, 'runtime', 'proxy', 'conf.d'),
  ACME_DIR: path.join(DATA_DIR, 'runtime', 'acme'),
  CERTBOT_WORK: path.join(DATA_DIR, 'runtime', 'certbot-work'),
  CERTBOT_LOGS: path.join(DATA_DIR, 'runtime', 'certbot-logs'),
  LE_DIR: path.join(DATA_DIR, 'letsencrypt'),
  TEMPLATES_DIR: process.env.TEMPLATES_DIR || '/opt/wm/templates',
  RUNTIME_CTX_DIR: process.env.RUNTIME_CTX_DIR || '/opt/wm/runtimes',
  AUDIT_LOG: process.env.AUDIT_LOG || '/var/log/wm/agent-audit.log',
  tokens: {
    dashboard: req('AGENT_TOKEN_DASHBOARD'),
    worker: req('AGENT_TOKEN_WORKER'),
  },
  proxyContainer: process.env.PROXY_CONTAINER || 'wm-proxy',
  dashboardUpstream: process.env.DASHBOARD_UPSTREAM || 'webmanager:8080',
  agentUpstream: process.env.AGENT_UPSTREAM || 'agent:9000',
  envDashboardDomain: (process.env.DASHBOARD_DOMAIN || '').toLowerCase(),
  publicIps: (process.env.PUBLIC_IPS || '').split(',').map((s) => s.trim()).filter(Boolean),
  acmeStaging: process.env.ACME_STAGING === 'true',
  trustedProxies: process.env.TRUSTED_PROXIES || '',
  // web console (interactive shell in website containers); CONSOLE=off removes it completely
  consoleEnabled: String(process.env.CONSOLE || 'on').toLowerCase() !== 'off',
  // who may ask for a console ticket: only the worker (default: the dashboard token cannot open shells) or also the dashboard (CONSOLE_TICKETS=dashboard)
  consoleTicketsByWorker: String(process.env.CONSOLE_TICKETS || 'worker').toLowerCase() !== 'dashboard',
  uidBase: 20000,
  version: process.env.WM_VERSION || 'dev',
};

config.runtimesFile = process.env.RUNTIMES_FILE || path.join(config.TEMPLATES_DIR, 'runtimes.json');

function loadRuntimes() {
  return JSON.parse(fs.readFileSync(config.runtimesFile, 'utf8'));
}

module.exports = { config, loadRuntimes };
