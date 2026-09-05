import type {AppManagers} from '../../managers';
import getServerMessageId from '../messageId/getServerMessageId';
import {Message} from '../../../layer';

export default async function getMessageLink(
  managers: AppManagers,
  peerId: PeerId,
  mid: number,
  threadId?: number,
  discussion = false
) {
  if(peerId.isUser()) return;

  let threadMessage: Message.message;
  if(discussion && threadId) {
    threadMessage = await managers.appMessagesManager.getMessageByPeer(peerId, threadId) as typeof threadMessage;
  }

  const username = await managers.appPeersManager.getPeerUsername(threadMessage ? threadMessage.fromId : peerId);
  const msgId = getServerMessageId(mid);
  let url = 'https://t.me/';
  if(username) {
    url += username;
    if(threadMessage) url += `/${getServerMessageId(threadMessage.fwd_from.channel_post)}?comment=${msgId}`;
    else if(threadId) url += `/${getServerMessageId(threadId)}/${msgId}`;
    else url += '/' + msgId;
  } else {
    url += 'c/' + peerId.toChatId();
    if(threadMessage) url += `/${msgId}?thread=${getServerMessageId(threadMessage.mid)}`;
    else if(threadId) url += `/${getServerMessageId(threadId)}/${msgId}`;
    else url += '/' + msgId;
  }

  return {url, isPrivate: !username};
}
