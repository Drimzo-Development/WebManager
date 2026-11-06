import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PROVIDERS, buildCommand, shellQuote, validate } from './backupTarget.ts';

test('Hetzner: required field, format and command with default folder', () => {
  const p = PROVIDERS.hetzner;
  assert.deepEqual(Object.keys(validate(p, {})), ['user']);
  assert.deepEqual(Object.keys(validate(p, { user: 'root' })), ['user']);
  assert.deepEqual(validate(p, { user: 'u123456-sub1' }), {});
  assert.equal(buildCommand(p, { user: 'u123456' }), 'sudo /opt/webmanager/scripts/backup-remote.sh setup --provider hetzner --user u123456 --path webmanager-backups --name hetzner');
});

test('SFTP: port range, key file and empty fields stay out of the command', () => {
  const p = PROVIDERS.sftp;
  assert.deepEqual(Object.keys(validate(p, { host: 'h.example.com', user: 'bk', port: '99999' })), ['port']);
  const cmd = buildCommand(p, { host: 'h.example.com', user: 'bk', keyFile: '/root/.ssh/id', port: '' });
  assert.match(cmd, /--host h\.example\.com --user bk --key-file \/root\/\.ssh\/id --path webmanager-backups --name wmsftp$/);
  assert.doesNotMatch(cmd, /--port/);
});

test('S3 and B2: bucket rules, endpoint, no secret in the command', () => {
  assert.ok(validate(PROVIDERS.s3, { bucket: 'a b', accessKey: 'K' }).bucket);
  assert.ok(validate(PROVIDERS.s3, { bucket: 'bkt-1', accessKey: 'K', endpoint: 'ftp://x' }).endpoint);
  const cmd = buildCommand(PROVIDERS.s3, { bucket: 'bkt-1', accessKey: 'AKIA1', endpoint: 'https://s3.example.com', region: 'eu-1' });
  assert.match(cmd, /--provider s3 --bucket bkt-1 --access-key AKIA1 --endpoint https:\/\/s3\.example\.com --region eu-1 --name wms3$/);
  assert.doesNotMatch(cmd, /secret/i);
  assert.match(buildCommand(PROVIDERS.b2, { bucket: 'bkt-1', account: '0012345abc', path: 'wm' }), /--provider b2 --bucket bkt-1 --account 0012345abc --path wm --name wmb2$/);
});

test('shellQuote protects special characters', () => {
  assert.equal(shellQuote('abc/def-1.x'), 'abc/def-1.x');
  assert.equal(shellQuote('a b'), "'a b'");
  assert.equal(shellQuote("it's"), "'it'\\''s'");
  assert.equal(shellQuote('a;rm -rf /'), "'a;rm -rf /'");
});
