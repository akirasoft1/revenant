'use strict';
const FloorControl = require('../../../services/voice/FloorControl');

test('first grant wins; a second speaker cannot take the floor and is recorded waiting', () => {
  const fc = new FloorControl();
  expect(fc.grant('alice')).toBe(true);
  expect(fc.holder()).toBe('alice');
  expect(fc.grant('bob')).toBe(false);       // alice holds it
  expect(fc.isHolder('alice')).toBe(true);
  expect(fc.isHolder('bob')).toBe(false);
  expect(fc.waiting()).toEqual(['bob']);      // bob wanted the floor
});

test('re-grant to the same holder is a no-op success and does not add them to waiting', () => {
  const fc = new FloorControl();
  fc.grant('alice');
  expect(fc.grant('alice')).toBe(true);
  expect(fc.waiting()).toEqual([]);
});

test('noteWaiting dedups; release clears holder and waiting', () => {
  const fc = new FloorControl();
  fc.grant('alice');
  fc.noteWaiting('bob'); fc.noteWaiting('bob'); fc.noteWaiting('carol');
  expect(fc.waiting().sort()).toEqual(['bob', 'carol']);
  fc.release();
  expect(fc.holder()).toBe(null);
  expect(fc.waiting()).toEqual([]);
  expect(fc.grant('bob')).toBe(true);         // floor free again
});
