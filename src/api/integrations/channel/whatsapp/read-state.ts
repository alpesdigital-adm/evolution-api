import type { LastMessage, ReadMessageDto } from '@api/dto/chat.dto';
import type { proto, WASocket } from 'baileys';

export class ReadStateValidationError extends Error {}

type ReadStateClient = Pick<WASocket, 'readMessages' | 'chatModify'>;

function isChatJid(jid: string): boolean {
  // Baileys' isPnUser/isJidGroup/isLidUser check these suffixes. Keep this
  // predicate local so focused tests need not load the full Baileys runtime.
  return typeof jid === 'string' && /[^@\s]+@(s\.whatsapp\.net|g\.us|lid)$/.test(jid);
}

/** The first entry is the displayed cursor; the final entry is the latest inbound message. */
export function readStateMessageRange(data: {
  lastMessage?: LastMessage;
  lastMessages?: LastMessage[];
}): LastMessage[] | undefined {
  if (data.lastMessages && data.lastMessage) {
    throw new ReadStateValidationError('Use lastMessages or lastMessage, not both');
  }
  const range = data.lastMessages ?? (data.lastMessage ? [data.lastMessage] : undefined);
  if (!range) return undefined;
  if (!Array.isArray(range) || range.length < 1 || range.length > 500) {
    throw new ReadStateValidationError('lastMessages must contain 1 to 500 messages');
  }
  const jid = range[0]?.key?.remoteJid;
  if (typeof jid !== 'string' || !isChatJid(jid)) {
    throw new ReadStateValidationError('lastMessages requires a valid chat JID');
  }
  const ids = new Set<string>();
  for (let index = 0; index < range.length; index++) {
    const { key, messageTimestamp } = range[index] ?? {};
    if (
      !key ||
      key.remoteJid !== jid ||
      typeof key.id !== 'string' ||
      !key.id.trim() ||
      typeof key.fromMe !== 'boolean' ||
      typeof messageTimestamp !== 'number' ||
      !Number.isSafeInteger(messageTimestamp) ||
      messageTimestamp < 100_000_000 ||
      messageTimestamp >= 100_000_000_000 ||
      (index > 0 && messageTimestamp > range[index - 1].messageTimestamp!) ||
      ids.has(key.id) ||
      (index < range.length - 1 && key.fromMe === false)
    ) {
      throw new ReadStateValidationError(
        'lastMessages must be a complete reverse-chronological range ending at the latest inbound message',
      );
    }
    ids.add(key.id);
  }
  if (range[range.length - 1].key.fromMe !== false) {
    throw new ReadStateValidationError('lastMessages must end at an inbound message');
  }
  return range;
}

/** The legacy request still sends receipts alone. A lastMessage also syncs chat state to linked devices. */
export async function syncMessageReadState(client: ReadStateClient, data: ReadMessageDto) {
  if (!Array.isArray(data.readMessages)) {
    throw new ReadStateValidationError('readMessages must be an array');
  }

  const range = readStateMessageRange(data);
  if (range) {
    if (
      data.readMessages.some(
        (read) =>
          !read ||
          !isChatJid(read.remoteJid) ||
          read.remoteJid !== range[0].key.remoteJid ||
          !read.id ||
          typeof read.fromMe !== 'boolean',
      )
    ) {
      throw new ReadStateValidationError('readMessages and lastMessage must belong to the same chat');
    }
  } else if (data.readMessages.length === 0) {
    throw new ReadStateValidationError('readMessages cannot be empty without lastMessage');
  }

  const keys: proto.IMessageKey[] = data.readMessages
    .filter((read) => isChatJid(read.remoteJid))
    .map((read) => ({ remoteJid: read.remoteJid, fromMe: read.fromMe, id: read.id }));

  // Run validation before either external call. A failure in either call propagates to the HTTP request.
  if (range) {
    await client.chatModify({ markRead: true, lastMessages: range }, range[0].key.remoteJid);
  }
  if (keys.length > 0 || !range) {
    await client.readMessages(keys);
  }
  return { message: 'Read messages', read: 'success' };
}

export function chatReadStateUpdates(
  chats: Array<Partial<proto.IConversation>>,
  instanceId: string,
  readStateObservedAt: string,
) {
  return chats.map((chat) => ({
    remoteJid: chat.id,
    instanceId,
    readStateObservedAt,
    ...(Number.isInteger(chat.unreadCount) ? { unreadCount: chat.unreadCount } : {}),
  }));
}
