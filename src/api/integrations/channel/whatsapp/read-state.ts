import type { ReadMessageDto } from '@api/dto/chat.dto';
import type { proto, WASocket } from 'baileys';

export class ReadStateValidationError extends Error {}

type ReadStateClient = Pick<WASocket, 'readMessages' | 'chatModify'>;

function isChatJid(jid: string): boolean {
  // Baileys' isPnUser/isJidGroup/isLidUser check these suffixes. Keep this
  // predicate local so focused tests need not load the full Baileys runtime.
  return typeof jid === 'string' && /[^@\s]+@(s\.whatsapp\.net|g\.us|lid)$/.test(jid);
}

/** The legacy request still sends receipts alone. A lastMessage also syncs chat state to linked devices. */
export async function syncMessageReadState(client: ReadStateClient, data: ReadMessageDto) {
  if (!Array.isArray(data.readMessages)) {
    throw new ReadStateValidationError('readMessages must be an array');
  }

  const lastMessage = data.lastMessage;
  if (lastMessage) {
    const { key, messageTimestamp } = lastMessage;
    if (
      !key ||
      typeof key.remoteJid !== 'string' ||
      !isChatJid(key.remoteJid) ||
      typeof key.id !== 'string' ||
      !key.id.trim() ||
      typeof key.fromMe !== 'boolean' ||
      !Number.isSafeInteger(messageTimestamp) ||
      messageTimestamp <= 0
    ) {
      throw new ReadStateValidationError('lastMessage requires a valid chat key and epoch-seconds messageTimestamp');
    }
    if (
      data.readMessages.some(
        (read) =>
          !read ||
          !isChatJid(read.remoteJid) ||
          read.remoteJid !== key.remoteJid ||
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
  if (lastMessage) {
    await client.chatModify({ markRead: true, lastMessages: [lastMessage] }, lastMessage.key.remoteJid);
  }
  if (keys.length > 0 || !lastMessage) {
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

type ChatReadStateUpdate = ReturnType<typeof chatReadStateUpdates>[number];

/**
 * Chats are keyed by LID on recent accounts, but inbound messages are already
 * normalized to the phone JID (key.remoteJidAlt). Emit the phone JID too so
 * webhook consumers can match the read state to the same conversation.
 * The original LID is kept in `lid`; unresolved LIDs pass through unchanged.
 */
export async function resolveReadStateLids(
  updates: ChatReadStateUpdate[],
  resolvePn: (lid: string) => Promise<string | null | undefined>,
) {
  return Promise.all(
    updates.map(async (update) => {
      if (typeof update.remoteJid !== 'string' || !update.remoteJid.endsWith('@lid')) return update;
      let pn: string | null | undefined;
      try {
        pn = await resolvePn(update.remoteJid);
      } catch {
        pn = null;
      }
      const user = typeof pn === 'string' ? pn.split('@')[0].split(':')[0] : '';
      if (!/^\d{8,15}$/.test(user)) return update;
      return { ...update, remoteJid: `${user}@s.whatsapp.net`, lid: update.remoteJid };
    }),
  );
}
