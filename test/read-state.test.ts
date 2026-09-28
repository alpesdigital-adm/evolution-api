import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ReadMessageDto } from '../src/api/dto/chat.dto';
import {
  chatReadStateUpdates,
  readStateMessageRange,
  ReadStateValidationError,
  syncMessageReadState,
} from '../src/api/integrations/channel/whatsapp/read-state';
import { markChatUnreadSchema, readMessageSchema } from '../src/validate/chat.schema';
import { Validator } from 'jsonschema';

const jid = '5511999999999@s.whatsapp.net';
const otherJid = '5511888888888@s.whatsapp.net';
const lastMessage = { key: { remoteJid: jid, fromMe: true, id: 'outbound-1' }, messageTimestamp: 1_790_000_000 };
const inboundMessage = { key: { remoteJid: jid, fromMe: false, id: 'inbound-1' }, messageTimestamp: 1_789_999_999 };
const lastMessages = [lastMessage, inboundMessage];
const receipt = { remoteJid: jid, fromMe: false, id: 'inbound-1' };

function mockClient(options: { failModify?: boolean; failReceipts?: boolean } = {}) {
  const calls: Array<{ command: string; payload: unknown; jid?: string }> = [];
  const client = {
    async chatModify(payload: unknown, chatJid: string) {
      calls.push({ command: 'chatModify', payload, jid: chatJid });
      if (options.failModify) throw new Error('modify failed');
    },
    async readMessages(keys: unknown) {
      calls.push({ command: 'readMessages', payload: keys });
      if (options.failReceipts) throw new Error('receipts failed');
    },
  } as Parameters<typeof syncMessageReadState>[0];
  return { client, calls };
}

test('legacy readMessages sends receipts without modifying chat state', async () => {
  const { client, calls } = mockClient();
  const result = await syncMessageReadState(client, { readMessages: [receipt] });
  assert.deepEqual(result, { message: 'Read messages', read: 'success' });
  assert.deepEqual(calls, [{ command: 'readMessages', payload: [receipt] }]);
});

test('lastMessages synchronizes the complete reverse-chronological range and sends inbound receipts', async () => {
  const { client, calls } = mockClient();
  await syncMessageReadState(client, { readMessages: [receipt], lastMessages });
  assert.deepEqual(calls, [
    { command: 'chatModify', payload: { markRead: true, lastMessages }, jid },
    { command: 'readMessages', payload: [receipt] },
  ]);
});

test('outbound cursor can clear a manually unread chat with a complete range but no receipts', async () => {
  const { client, calls } = mockClient();
  await syncMessageReadState(client, { readMessages: [], lastMessages });
  assert.deepEqual(calls, [{ command: 'chatModify', payload: { markRead: true, lastMessages }, jid }]);
});

test('mixed chats and missing timestamps fail before SDK effects', async () => {
  const { client, calls } = mockClient();
  await assert.rejects(
    syncMessageReadState(client, { readMessages: [{ ...receipt, remoteJid: otherJid }], lastMessages }),
    ReadStateValidationError,
  );
  await assert.rejects(
    syncMessageReadState(client, { readMessages: [receipt], lastMessages: [{ key: lastMessage.key }] } as ReadMessageDto),
    ReadStateValidationError,
  );
  await assert.rejects(syncMessageReadState(client, { readMessages: [receipt], lastMessage }), ReadStateValidationError);
  await assert.rejects(syncMessageReadState(client, { readMessages: [receipt], lastMessages: [lastMessage] }), ReadStateValidationError);
  await assert.rejects(syncMessageReadState(client, { readMessages: [receipt], lastMessages: [inboundMessage, lastMessage] }), ReadStateValidationError);
  await assert.rejects(syncMessageReadState(client, { readMessages: [receipt], lastMessages: [lastMessage, { ...inboundMessage, messageTimestamp: 1_790_000_001 }] }), ReadStateValidationError);
  await assert.rejects(syncMessageReadState(client, { readMessages: [receipt], lastMessages: [lastMessage, { ...inboundMessage, key: { ...inboundMessage.key, id: lastMessage.key.id } }] }), ReadStateValidationError);
  assert.deepEqual(calls, []);
});

test('request schema requires an epoch-seconds timestamp and allows empty receipts only with a range', () => {
  const validator = new Validator();
  const valid = (value: unknown) => validator.validate(value, readMessageSchema).valid;
  assert.equal(valid({ readMessages: [receipt] }), true);
  assert.equal(valid({ readMessages: [], lastMessages }), true);
  assert.equal(valid({ readMessages: [] }), false);
  assert.equal(valid({ readMessages: [receipt], lastMessages: [{ key: lastMessage.key }] }), false);
  assert.equal(valid({ readMessages: [receipt], lastMessages: [{ ...lastMessage, messageTimestamp: 0 }] }), false);
  assert.equal(valid({ readMessages: [receipt], lastMessages: null }), false);
});

test('unread accepts a complete range and rejects an outbound-only legacy cursor before SDK use', () => {
  const validator = new Validator();
  assert.equal(validator.validate({ chat: jid, lastMessages }, markChatUnreadSchema).valid, true);
  assert.deepEqual(readStateMessageRange({ lastMessages }), lastMessages);
  assert.throws(() => readStateMessageRange({ lastMessage }), ReadStateValidationError);
  assert.throws(() => readStateMessageRange({ lastMessages: [lastMessage, { ...inboundMessage, key: { ...inboundMessage.key, remoteJid: otherJid } }] }), ReadStateValidationError);
  assert.equal(validator.validate({ chat: jid, lastMessages: [{ key: inboundMessage.key }] }, markChatUnreadSchema).valid, false);
});

test('LID chats are accepted by the same JID suffix contract', async () => {
  const lid = '123456789@lid';
  const { client, calls } = mockClient();
  await syncMessageReadState(client, {
    readMessages: [{ remoteJid: lid, fromMe: false, id: 'lid-inbound' }],
    lastMessages: [{ key: { remoteJid: lid, fromMe: false, id: 'lid-inbound' }, messageTimestamp: 1_790_000_001 }],
  });
  assert.equal(calls[0].command, 'chatModify');
  assert.equal(calls[0].jid, lid);
  assert.equal(calls[1].command, 'readMessages');
});

test('partial SDK failure never reports success', async () => {
  const modify = mockClient({ failModify: true });
  await assert.rejects(syncMessageReadState(modify.client, { readMessages: [receipt], lastMessages }), /modify failed/);
  assert.deepEqual(modify.calls.map((call) => call.command), ['chatModify']);

  const receipts = mockClient({ failReceipts: true });
  await assert.rejects(syncMessageReadState(receipts.client, { readMessages: [receipt], lastMessages }), /receipts failed/);
  assert.deepEqual(receipts.calls.map((call) => call.command), ['chatModify', 'readMessages']);
});

test('chats.update retains zero, manual-unread marker, and positive delta with observation time', () => {
  const observedAt = '2026-09-28T12:34:56.000Z';
  const updates = chatReadStateUpdates(
    [
      { id: jid, unreadCount: 0 },
      { id: otherJid, unreadCount: -1 },
      { id: '123@g.us', unreadCount: 3 },
      { id: '456@g.us', unreadCount: 1.5 },
    ],
    'instance-1',
    observedAt,
  );
  assert.deepEqual(updates, [
    { remoteJid: jid, instanceId: 'instance-1', readStateObservedAt: observedAt, unreadCount: 0 },
    { remoteJid: otherJid, instanceId: 'instance-1', readStateObservedAt: observedAt, unreadCount: -1 },
    { remoteJid: '123@g.us', instanceId: 'instance-1', readStateObservedAt: observedAt, unreadCount: 3 },
    { remoteJid: '456@g.us', instanceId: 'instance-1', readStateObservedAt: observedAt },
  ]);
});
