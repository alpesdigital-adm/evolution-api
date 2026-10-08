import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ReadMessageDto } from '../src/api/dto/chat.dto';
import {
  chatReadStateUpdates,
  fillRemoteJidAlt,
  ReadStateValidationError,
  readRequestToChatAddressing,
  resolveReadStateLids,
  toChatAddressingJid,
  syncMessageReadState,
} from '../src/api/integrations/channel/whatsapp/read-state';
import { readMessageSchema } from '../src/validate/chat.schema';
import { Validator } from 'jsonschema';

const jid = '5511999999999@s.whatsapp.net';
const otherJid = '5511888888888@s.whatsapp.net';
const lastMessage = { key: { remoteJid: jid, fromMe: true, id: 'outbound-1' }, messageTimestamp: 1_790_000_000 };
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

test('lastMessage synchronizes linked-device read state and sends inbound receipts', async () => {
  const { client, calls } = mockClient();
  await syncMessageReadState(client, { readMessages: [receipt], lastMessage });
  assert.deepEqual(calls, [
    { command: 'chatModify', payload: { markRead: true, lastMessages: [lastMessage] }, jid },
    { command: 'readMessages', payload: [receipt] },
  ]);
});

test('outbound lastMessage can clear a manually unread chat without inbound receipts', async () => {
  const { client, calls } = mockClient();
  await syncMessageReadState(client, { readMessages: [], lastMessage });
  assert.deepEqual(calls, [{ command: 'chatModify', payload: { markRead: true, lastMessages: [lastMessage] }, jid }]);
});

test('mixed chats and missing timestamps fail before SDK effects', async () => {
  const { client, calls } = mockClient();
  await assert.rejects(
    syncMessageReadState(client, { readMessages: [{ ...receipt, remoteJid: otherJid }], lastMessage }),
    ReadStateValidationError,
  );
  await assert.rejects(
    syncMessageReadState(client, { readMessages: [receipt], lastMessage: { key: lastMessage.key } } as ReadMessageDto),
    ReadStateValidationError,
  );
  assert.deepEqual(calls, []);
});

test('request schema requires an epoch-seconds timestamp and allows empty receipts only with lastMessage', () => {
  const validator = new Validator();
  const valid = (value: unknown) => validator.validate(value, readMessageSchema).valid;
  assert.equal(valid({ readMessages: [receipt] }), true);
  assert.equal(valid({ readMessages: [], lastMessage }), true);
  assert.equal(valid({ readMessages: [] }), false);
  assert.equal(valid({ readMessages: [receipt], lastMessage: { key: lastMessage.key } }), false);
  assert.equal(valid({ readMessages: [receipt], lastMessage: { ...lastMessage, messageTimestamp: 0 } }), false);
});

test('LID chats are accepted by the same JID suffix contract', async () => {
  const lid = '123456789@lid';
  const { client, calls } = mockClient();
  await syncMessageReadState(client, {
    readMessages: [{ remoteJid: lid, fromMe: false, id: 'lid-inbound' }],
    lastMessage: { key: { remoteJid: lid, fromMe: false, id: 'lid-inbound' }, messageTimestamp: 1_790_000_001 },
  });
  assert.equal(calls[0].command, 'chatModify');
  assert.equal(calls[0].jid, lid);
  assert.equal(calls[1].command, 'readMessages');
});

test('partial SDK failure never reports success', async () => {
  const modify = mockClient({ failModify: true });
  await assert.rejects(syncMessageReadState(modify.client, { readMessages: [receipt], lastMessage }), /modify failed/);
  assert.deepEqual(modify.calls.map((call) => call.command), ['chatModify']);

  const receipts = mockClient({ failReceipts: true });
  await assert.rejects(syncMessageReadState(receipts.client, { readMessages: [receipt], lastMessage }), /receipts failed/);
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

test('chats.update keyed by LID is re-keyed to the phone JID, keeping the LID', async () => {
  const observedAt = '2026-10-08T12:00:00.000Z';
  const resolved = await resolveReadStateLids(
    chatReadStateUpdates(
      [
        { id: '123456789012345@lid', unreadCount: 0 },
        { id: '999999999999999@lid', unreadCount: -1 },
        { id: '888888888888888@lid', unreadCount: 0 },
        { id: jid, unreadCount: 0 },
      ],
      'instance-1',
      observedAt,
    ),
    async (lid) => {
      if (lid === '123456789012345@lid') return '5548991554955:12@s.whatsapp.net';
      if (lid === '888888888888888@lid') throw new Error('mapping store down');
      return null;
    },
  );
  assert.deepEqual(resolved, [
    {
      remoteJid: '5548991554955@s.whatsapp.net',
      lid: '123456789012345@lid',
      instanceId: 'instance-1',
      readStateObservedAt: observedAt,
      unreadCount: 0,
    },
    { remoteJid: '999999999999999@lid', instanceId: 'instance-1', readStateObservedAt: observedAt, unreadCount: -1 },
    { remoteJid: '888888888888888@lid', instanceId: 'instance-1', readStateObservedAt: observedAt, unreadCount: 0 },
    { remoteJid: jid, instanceId: 'instance-1', readStateObservedAt: observedAt, unreadCount: 0 },
  ]);
});

test('commands from webhook consumers are re-addressed to the LID the phone uses', async () => {
  const resolveLid = async (pn: string) => (pn === jid ? '55761694654630:3@lid' : null);
  assert.equal(await toChatAddressingJid(jid, resolveLid), '55761694654630@lid');
  assert.equal(await toChatAddressingJid(otherJid, resolveLid), otherJid);
  assert.equal(await toChatAddressingJid('123@g.us', resolveLid), '123@g.us');
  assert.equal(await toChatAddressingJid(jid, async () => { throw new Error('down'); }), jid);

  const addressed = await readRequestToChatAddressing(
    { readMessages: [receipt], lastMessage } as unknown as ReadMessageDto,
    resolveLid,
  );
  assert.equal(addressed.readMessages[0].remoteJid, '55761694654630@lid');
  assert.equal(addressed.lastMessage?.key.remoteJid, '55761694654630@lid');
  assert.equal(addressed.lastMessage?.key.id, 'outbound-1');
  const { client, calls } = mockClient();
  await syncMessageReadState(client, addressed);
  assert.equal(calls[0].jid, '55761694654630@lid');
});

test('LID-only message keys get the phone JID from the LID mapping', async () => {
  const resolve = async (lid: string) => (lid === '202860566425607@lid' ? '5511964242104:0@s.whatsapp.net' : null);
  const known = { remoteJid: '202860566425607@lid' } as { remoteJid: string; remoteJidAlt?: string };
  await fillRemoteJidAlt(known, resolve);
  assert.equal(known.remoteJidAlt, '5511964242104@s.whatsapp.net');

  const unknown = { remoteJid: '999999999999999@lid' } as { remoteJid: string; remoteJidAlt?: string };
  await fillRemoteJidAlt(unknown, resolve);
  assert.equal(unknown.remoteJidAlt, undefined);

  const already = { remoteJid: '202860566425607@lid', remoteJidAlt: '5500000000000@s.whatsapp.net' };
  await fillRemoteJidAlt(already, resolve);
  assert.equal(already.remoteJidAlt, '5500000000000@s.whatsapp.net');

  const phone = { remoteJid: jid } as { remoteJid: string; remoteJidAlt?: string };
  await fillRemoteJidAlt(phone, resolve);
  assert.equal(phone.remoteJidAlt, undefined);

  const failing = { remoteJid: '202860566425607@lid' } as { remoteJid: string; remoteJidAlt?: string };
  await fillRemoteJidAlt(failing, async () => { throw new Error('down'); });
  assert.equal(failing.remoteJidAlt, undefined);
});
