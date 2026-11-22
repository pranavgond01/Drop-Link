import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  sanitizeFileName,
  formatBytes,
  formatDuration,
  isControlMessage,
} from '../src/protocol.ts';

test('sanitizeFileName handles path traversal and illegal characters', () => {
  assert.equal(sanitizeFileName('../../../secret.txt'), '_._._secret.txt');
  assert.equal(sanitizeFileName('..\\..\\passwords.txt'), '_._passwords.txt');
  assert.equal(sanitizeFileName('/etc/shadow'), '_etc_shadow');
  assert.equal(sanitizeFileName('C:\\Windows\\System32\\cmd.exe'), 'C_Windows_System32_cmd.exe');
  assert.equal(sanitizeFileName('evil\x00file.png'), 'evilfile.png');
  assert.equal(sanitizeFileName('test<>:"/\\|?*name.pdf'), 'test_name.pdf');
});

test('sanitizeFileName protects against Windows reserved device names', () => {
  assert.equal(sanitizeFileName('CON'), 'file_CON');
  assert.equal(sanitizeFileName('prn.txt'), 'file_prn.txt');
  assert.equal(sanitizeFileName('aux'), 'file_aux');
  assert.equal(sanitizeFileName('nul.dat'), 'file_nul.dat');
  assert.equal(sanitizeFileName('COM1'), 'file_COM1');
  assert.equal(sanitizeFileName('LPT9.log'), 'file_LPT9.log');
});

test('sanitizeFileName provides fallback for empty or whitespace names', () => {
  assert.equal(sanitizeFileName(''), 'received_file.bin');
  assert.equal(sanitizeFileName('   '), 'received_file.bin');
  assert.equal(sanitizeFileName('...'), 'received_file.bin');
});

test('sanitizeFileName limits length to 180 characters while preserving extension', () => {
  const longName = 'a'.repeat(200) + '.tar.gz';
  const sanitized = sanitizeFileName(longName);
  assert.ok(sanitized.length <= 180);
  assert.ok(sanitized.endsWith('.gz'));
});

test('formatBytes formats file sizes correctly', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(500), '500 B');
  assert.equal(formatBytes(1024), '1.0 KB');
  assert.equal(formatBytes(1024 * 1024 * 5), '5.0 MB');
  assert.equal(formatBytes(1024 * 1024 * 1024 * 2.5), '2.5 GB');
});

test('formatDuration formats seconds into readable time', () => {
  assert.equal(formatDuration(0), '—');
  assert.equal(formatDuration(45), '45s');
  assert.equal(formatDuration(65), '1m 05s');
  assert.equal(formatDuration(125), '2m 05s');
});

test('isControlMessage validates supported control messages', () => {
  assert.equal(isControlMessage({ kind: 'file-start', id: '123' }), true);
  assert.equal(isControlMessage({ kind: 'file-end', id: '123' }), true);
  assert.equal(isControlMessage({ kind: 'chunk-ack', id: '123', chunkIndex: 0 }), true);
  assert.equal(isControlMessage({ kind: 'cancel' }), true);
  assert.equal(isControlMessage({ kind: 'unknown-hack' }), false);
  assert.equal(isControlMessage(null), false);
  assert.equal(isControlMessage('string'), false);
});
