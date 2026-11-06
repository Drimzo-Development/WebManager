import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canSee, parseSiteRoute, siteHref, TABS, visibleSubs, visibleTabs, type Caller } from './routes.ts';

test('parseSiteRoute: valid routes', () => {
  assert.deepEqual(parseSiteRoute('/sites/7'), { id: 7, tab: 'overview', sub: null });
  assert.deepEqual(parseSiteRoute('/sites/12/content'), { id: 12, tab: 'content', sub: null });
  assert.deepEqual(parseSiteRoute('/sites/12/content/database'), { id: 12, tab: 'content', sub: 'database' });
  assert.deepEqual(parseSiteRoute('/sites/3/protection/security'), { id: 3, tab: 'protection', sub: 'security' });
  assert.deepEqual(parseSiteRoute('/sites/3/ops/stats'), { id: 3, tab: 'ops', sub: 'stats' });
  assert.deepEqual(parseSiteRoute('/sites/3/deploy/cron'), { id: 3, tab: 'deploy', sub: 'cron' });
  assert.deepEqual(parseSiteRoute('/sites/3/settings'), { id: 3, tab: 'settings', sub: null });
});

test('parseSiteRoute: invalid routes', () => {
  for (const r of [
    '/', '/tokens', '/sites', '/sites/', '/sites/0', '/sites/abc', '/sites/-1', '/sites/007x', '/sites/1234567', '//sites/7', '/sites/7/', '/sites/new',
    '/sites/7/unknown', '/sites/7/logs', '/sites/7/more', '/sites/7/content/unknown', '/sites/7/content/logs', '/sites/7/overview/x', '/sites/7/content/files/x',
  ]) {
    assert.equal(parseSiteRoute(r), null, r);
  }
});

test('siteHref matches parseSiteRoute (all tabs and sections)', () => {
  assert.equal(siteHref(5), '#/sites/5');
  for (const t of TABS) {
    assert.deepEqual(parseSiteRoute(siteHref(5, t.key).slice(1)), { id: 5, tab: t.key, sub: null });
    for (const s of t.subs) assert.deepEqual(parseSiteRoute(siteHref(5, t.key, s.key).slice(1)), { id: 5, tab: t.key, sub: s.key });
  }
});

test('every section has a unique key', () => {
  const keys = TABS.flatMap((t) => t.subs.map((s) => s.key));
  assert.equal(new Set(keys).size, keys.length);
  for (const k of ['files', 'database', 'commands', 'cron', 'env', 'maintenance', 'stats', 'logs', 'jobs']) assert.ok(keys.includes(k), k);
});

const admin: Caller = { role: 'admin' };
const operator: Caller = { role: 'operator' };
const viewer: Caller = { role: 'viewer' };

test('canSee: operators and viewers', () => {
  assert.ok(canSee(admin, 'files') && canSee(admin, 'security') && canSee(admin, 'jobs') && canSee(admin, 'settings') && canSee(admin, 'report'));
  assert.ok(canSee(viewer, 'jobs'));
  assert.ok(canSee(admin, 'console') && !canSee(operator, 'console') && !canSee(viewer, 'console'));
  for (const s of ['files', 'database', 'domains', 'gate', 'rules', 'security', 'logs', 'commands', 'env', 'cron', 'stats', 'report', 'settings']) assert.ok(!canSee(viewer, s), `viewer ${s}`);
});

test('visibleTabs: by role', () => {
  const keys = (c: Caller) => visibleTabs(c).map((t) => t.key);
  assert.deepEqual(keys(admin), ['overview', 'content', 'deploy', 'domains', 'protection', 'ops', 'console', 'settings']);
  assert.deepEqual(keys(operator), ['overview', 'content', 'deploy', 'domains', 'protection', 'ops', 'settings'], 'the console is for administrators only');
  assert.deepEqual(keys(viewer), ['overview', 'ops']);
  assert.deepEqual(visibleSubs(TABS.find((t) => t.key === 'ops')!, viewer).map((s) => s.key), ['jobs']);
});
