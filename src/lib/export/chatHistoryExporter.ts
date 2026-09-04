import type {MyMessage} from '../appManagers/appMessagesManager';
import {HistoryType} from '../appManagers/appMessagesManager';
import getPeerTitle from '../../components/wrappers/getPeerTitle';
import rootScope from '../rootScope';
import appDownloadManager from '../appManagers/appDownloadManager';
import getMediaFromMessage from '../appManagers/utils/messages/getMediaFromMessage';
import {Document, DocumentAttribute, Photo} from '../../layer';

export type ChatExportFormat = 'html' | 'json';
export type ChatExportMediaType = 'photos' | 'videos' | 'voice' | 'video_notes' | 'stickers' | 'animated_gif' | 'files';

export type ExportDirectoryHandle = {
  readonly name?: string;
  getDirectoryHandle: (name: string, options?: {create?: boolean}) => Promise<ExportDirectoryHandle>;
  getFileHandle: (name: string, options?: {create?: boolean}) => Promise<{
    createWritable: () => Promise<{
    write: (data: Blob | string) => Promise<void>;
      close: () => Promise<void>;
    }>
  }>;
};

export type ChatExportOptions = {
  peerId: PeerId;
  threadId?: number;
  title: string;
  directory: ExportDirectoryHandle;
  formats: ChatExportFormat[];
  mediaTypes: ChatExportMediaType[];
  maxMediaBytes: number;
  fromDate?: Date;
  toDate?: Date;
  onProgress?: (details: ChatExportProgress) => void;
  signal?: AbortSignal;
};

export type ChatExportProgress = {
  loaded: number;
  total?: number;
  phase: 'history' | 'writing' | 'completed' | 'cancelled' | 'failed';
};

type ExportedMessage = {
  id: number;
  date: string;
  senderId?: PeerId;
  senderName?: string;
  text: string;
  service?: string;
  replyTo?: number;
  media?: {
    type: string;
    fileName?: string;
  };
};

type DirectoryPickerWindow = Window & {
  showDirectoryPicker?: () => Promise<ExportDirectoryHandle>;
};

const PAGE_SIZE = 100;

const escapeHTML = (value: string) => value
.replace(/&/g, '&amp;')
.replace(/</g, '&lt;')
.replace(/>/g, '&gt;')
.replace(/"/g, '&quot;')
.replace(/'/g, '&#39;');

const safeName = (value: string) => value.replace(/[\\/:*?"<>|]/g, '_').trim() || 'Chat';

const isCancelled = (signal?: AbortSignal) => signal?.aborted === true;

const normalizeMessage = (message: MyMessage): ExportedMessage => {
  const regularMessage = message as MyMessage & {
    fromId?: PeerId;
    reply_to?: {reply_to_msg_id?: number};
    media?: {_?: string};
  };

  return {
    id: message.mid,
    date: new Date(message.date * 1000).toISOString(),
    senderId: regularMessage.fromId,
    text: 'message' in message ? message.message || '' : '',
    service: 'action' in message ? message.action._ : undefined,
    replyTo: regularMessage.reply_to?.reply_to_msg_id,
    media: regularMessage.media ? {type: regularMessage.media._} : undefined
  };
};

const getMediaType = (message: MyMessage): ChatExportMediaType | undefined => {
  const media = getMediaFromMessage(message);
  if(!media) return;
  if(media._ === 'photo') return 'photos';
  if(media._ !== 'document') return 'files';

  const attributes = (media as Document.document).attributes;
  if(attributes.some((attribute) => attribute._ === 'documentAttributeSticker')) return 'stickers';
  if(attributes.some((attribute) => attribute._ === 'documentAttributeAnimated')) return 'animated_gif';
  const video = attributes.find((attribute) => attribute._ === 'documentAttributeVideo');
  if(video) return (video as DocumentAttribute.documentAttributeVideo).pFlags?.round_message ? 'video_notes' : 'videos';
  if(attributes.some((attribute) => attribute._ === 'documentAttributeAudio')) return 'voice';
  return 'files';
};

const getMessageText = (message: ExportedMessage) => {
  if(message.text) return message.text;
  if(message.service) return `[${message.service}]`;
  if(message.media) return `[${message.media.type}]`;
  return '';
};

const makeHTMLMessage = (message: ExportedMessage) => {
  const text = escapeHTML(getMessageText(message)).replace(/\n/g, '<br>');
  const sender = escapeHTML(message.senderName || (message.senderId ? '' + message.senderId : ''));
  return `<div class="message default clearfix" id="message${message.id}"><div class="body"><div class="date details" title="${escapeHTML(message.date)}">${escapeHTML(new Date(message.date).toLocaleString())}</div>${sender ? `<div class="from_name">${sender}</div>` : ''}<div class="text">${text}</div></div></div>\n`;
};

const writeFile = async(directory: ExportDirectoryHandle, name: string, data: string, type: string) => {
  const handle = await directory.getFileHandle(name, {create: true});
  const writable = await handle.createWritable();
  await writable.write(new Blob([data], {type}));
  await writable.close();
};

const writeBlob = async(directory: ExportDirectoryHandle, name: string, blob: Blob) => {
  const handle = await directory.getFileHandle(name, {create: true});
  const writable = await handle.createWritable();
  await writable.write(blob);
  await writable.close();
};

const createWriter = async(directory: ExportDirectoryHandle, name: string) => {
  const handle = await directory.getFileHandle(name, {create: true});
  return handle.createWritable();
};

export const pickExportDirectory = async() => {
  const picker = window as DirectoryPickerWindow;
  if(!picker.showDirectoryPicker) {
    throw new Error('DIRECTORY_PICKER_UNSUPPORTED');
  }

  return picker.showDirectoryPicker();
};

export async function exportChatHistory(options: ChatExportOptions) {
  const {peerId, threadId, directory, formats, signal, onProgress} = options;
  if(!formats.length) throw new Error('EXPORT_FORMAT_REQUIRED');

  const exportDirectory = await directory.getDirectoryHandle(safeName(options.title), {create: true});
  let exportedCount = 0;
  let partNumber = 0;
  const parts: {path: string, format: ChatExportFormat, message_count: number}[] = [];
  let offsetId = 0;
  let total: number | undefined;

  while(true) {
    if(isCancelled(signal)) throw new DOMException('Export cancelled', 'AbortError');

    const result = await rootScope.managers.appMessagesManager.getHistory({
      peerId,
      threadId,
      offsetId,
      limit: PAGE_SIZE,
      historyType: threadId ? HistoryType.Thread : HistoryType.Chat,
      allowRestricted: true
    });

    total = result.count || total;
    const page = (await Promise.all(result.history.map((mid: number) => {
      return rootScope.managers.appMessagesManager.getMessageByPeer(peerId, mid);
    }))).filter(Boolean) as MyMessage[];
    const partName = `messages-${('0000' + ++partNumber).slice(-4)}`;
    const jsonWriter = formats.includes('json') ? await createWriter(exportDirectory, `${partName}.json`) : undefined;
    const htmlWriter = formats.includes('html') ? await createWriter(exportDirectory, `${partName}.html`) : undefined;
    let jsonFirst = true;
    let partCount = 0;
    if(jsonWriter) await jsonWriter.write('[');
    if(htmlWriter) await htmlWriter.write(`<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Exported Data</title><style>body{font-family:Arial,sans-serif;max-width:980px;margin:0 auto;padding:24px}.message{padding:8px 0;border-bottom:1px solid #eee}.date{float:right;color:#999;font-size:12px}.from_name{font-weight:600;margin-bottom:4px}.text{white-space:normal;overflow-wrap:anywhere}</style></head><body><div class="page_header">${escapeHTML(options.title)}</div><div class="history">`);

    for(const message of page) {
      const timestamp = message.date * 1000;
      if(options.fromDate && timestamp < options.fromDate.getTime()) continue;
      if(options.toDate && timestamp > options.toDate.getTime()) continue;
      const exported = normalizeMessage(message);

      const mediaType = getMediaType(message);
      if(mediaType && options.mediaTypes.includes(mediaType)) {
        const media = getMediaFromMessage(message, true);
        const mediaSize = media?._ === 'document' ? (media as Document.document).size : 0;
        if(media && mediaSize <= options.maxMediaBytes) {
          const mediaDirectoryName = mediaType === 'photos' ? 'photos' : mediaType === 'videos' || mediaType === 'video_notes' || mediaType === 'animated_gif' ? 'video_files' : 'files';
          const mediaDirectory = await exportDirectory.getDirectoryHandle(mediaDirectoryName, {create: true});
          const extension = media._ === 'photo' ? 'jpg' : media._ === 'document' ? 'bin' : 'dat';
          const fileName = `${message.mid}.${extension}`;
          const blob = await appDownloadManager.downloadMedia({media: media as Photo.photo | Document.document});
          await writeBlob(mediaDirectory, fileName, blob);
          exported.media = {type: mediaType, fileName: `${mediaDirectoryName}/${fileName}`};
        }
      }
      if(jsonWriter) {
        await jsonWriter.write(`${jsonFirst ? '' : ','}\n${JSON.stringify(exported)}`);
        jsonFirst = false;
      }
      if(htmlWriter) await htmlWriter.write(makeHTMLMessage(exported));
      ++exportedCount;
      ++partCount;
    }

    if(jsonWriter) {
      await jsonWriter.write(']');
      await jsonWriter.close();
      parts.push({path: `${partName}.json`, format: 'json', message_count: partCount});
    }
    if(htmlWriter) {
      await htmlWriter.write('</div></body></html>');
      await htmlWriter.close();
      parts.push({path: `${partName}.html`, format: 'html', message_count: partCount});
    }
    onProgress?.({loaded: exportedCount, total, phase: 'history'});
    const lastId = page[page.length - 1]?.mid;
    if(!lastId || page.length < PAGE_SIZE || result.isEnd.bottom) break;
    offsetId = lastId;
  }

  onProgress?.({loaded: exportedCount, total, phase: 'writing'});

  const metadata = JSON.stringify({
    schema_version: 1,
    chat: {peer_id: peerId, title: options.title, thread_id: threadId || null},
    exported_at: new Date().toISOString(),
    range: {from: options.fromDate?.toISOString() || null, to: options.toDate?.toISOString() || null},
    formats,
    message_count: exportedCount,
    parts
  }, null, 2);

  await writeFile(exportDirectory, 'export_metadata.json', metadata, 'application/json');

  onProgress?.({loaded: exportedCount, total, phase: 'completed'});
}

export async function getExportTitle(peerId: PeerId) {
  return getPeerTitle({peerId, plainText: true});
}
