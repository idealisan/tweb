import rootScope from '../../../rootScope';

export const forwardMessageToSaved = (fromPeerId: PeerId, mids: number[]) => {
  return rootScope.managers.appMessagesManager.forwardMessages({
    peerId: rootScope.myId,
    fromPeerId,
    mids
  });
};

export const saveMessageLinkToSaved = (url: string) => {
  return rootScope.managers.appMessagesManager.sendText({
    peerId: rootScope.myId,
    text: url
  });
};
