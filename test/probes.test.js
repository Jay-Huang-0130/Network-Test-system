const test = require('node:test');
const assert = require('node:assert/strict');
const { parsePingLatency } = require('../src/probes');

test('parses Linux ping RTT', () => {
  assert.equal(parsePingLatency('64 bytes from 192.168.1.2: icmp_seq=1 ttl=64 time=0.823 ms'), 0.823);
});

test('parses localized Windows ping RTT', () => {
  assert.equal(parsePingLatency('回覆自 192.168.1.2: 位元組=32 時間<1ms TTL=64'), 0.5);
  assert.equal(parsePingLatency('Reply from 1.1.1.1: bytes=32 time=12ms TTL=57'), 12);
});

test('returns null when ping output has no RTT', () => {
  assert.equal(parsePingLatency('Request timed out.'), null);
});
