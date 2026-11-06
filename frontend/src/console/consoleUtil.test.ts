import assert from 'node:assert/strict';
import { test } from 'node:test';
import { binaryBytes, exitText, failureText, protocolFor, wsUrl } from './consoleUtil.ts';

test('wsUrl: wss on HTTPS, ws otherwise, same host, no ticket in the address', () => {
  assert.equal(wsUrl({ protocol: 'https:', host: 'panel.example.com' }), 'wss://panel.example.com/__console');
  assert.equal(wsUrl({ protocol: 'http:', host: '10.0.0.5:8080' }), 'ws://10.0.0.5:8080/__console');
});

test('protocolFor: the ticket is sent as subprotocol', () => {
  assert.equal(protocolFor('ab12'), 'wm-console.ab12');
});

test('exitText: reasons and exit code', () => {
  assert.equal(exitText({ reason: 'shell-exited', code: 0 }), 'The shell ended (exit code 0)');
  assert.equal(exitText({ reason: 'shell-exited', code: null }), 'The shell ended');
  assert.match(exitText({ reason: 'idle' }), /15 minutes/);
  assert.match(exitText({ reason: 'killed' }), /signed out/);
  assert.equal(exitText({ reason: 'something-new' }), 'Session ended');
  assert.equal(exitText({}), 'Session ended');
});

test('failureText: the server\'s own message wins, sensible fallbacks otherwise', () => {
  assert.match(failureText(401, 'whatever'), /signed out/);
  assert.equal(failureText(403, 'The console needs two-factor authentication: set up …'), 'The console needs two-factor authentication: set up …');
  assert.match(failureText(403, ''), /administrators/);
  assert.equal(failureText(409, 'The website is not running.'), 'The website is not running.');
  assert.match(failureText(429, ''), /Too many/);
  assert.match(failureText(500, ''), /could not be started/);
});

test('binaryBytes: one byte per character', () => {
  assert.deepEqual([...binaryBytes('\x1b[M \x7f\xff')], [0x1b, 0x5b, 0x4d, 0x20, 0x7f, 0xff]);
});
