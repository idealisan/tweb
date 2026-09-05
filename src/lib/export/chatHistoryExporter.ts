import type {MyMessage} from '../appManagers/appMessagesManager';
import {HistoryType} from '../appManagers/appMessagesManager';
import getPeerTitle from '../../components/wrappers/getPeerTitle';
import {downloadMediaParts} from './chatMediaPartDownloader';
import rootScope from '../rootScope';
import appDownloadManager from '../appManagers/appDownloadManager';
import getMediaFromMessage from '../appManagers/utils/messages/getMediaFromMessage';
import {Document, DocumentAttribute, Message, Photo} from '../../layer';

export type ChatExportFormat = 'html' | 'json';
export type ChatExportMediaType = 'photos' | 'videos' | 'voice' | 'video_notes' | 'stickers' | 'animated_gif' | 'files';

export type ExportDirectoryHandle = {
  readonly name?: string;
  values?: () => AsyncIterableIterator<{kind: string, name: string}>;
  removeEntry?: (name: string) => Promise<void>;
  getDirectoryHandle: (name: string, options?: {create?: boolean}) => Promise<ExportDirectoryHandle>;
  getFileHandle: (name: string, options?: {create?: boolean}) => Promise<{
    getFile?: () => Promise<{text: () => Promise<string>, size?: number}>;
    createWritable: (options?: {keepExistingData?: boolean}) => Promise<{
    write: (data: Blob | string | ArrayBuffer | Uint8Array) => Promise<void>;
      seek?: (position: number) => Promise<void>;
    truncate?: (size: number) => Promise<void>;
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
  current?: string;
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

type ExportWritable = {
  write: (data: Blob | string | ArrayBuffer | Uint8Array) => Promise<void>;
  seek?: (position: number) => Promise<void>;
  close: () => Promise<void>;
};

const getLocalTimestamp = () => {
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;
};

const formatExportDate = (timestamp: number) => {
  const date = new Date(timestamp * 1000);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}_${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`;
};

const PAGE_SIZE = 100;
const MEDIA_DOWNLOAD_TIMEOUT = 120000;
const MEDIA_DOWNLOAD_RETRIES = 2;
const MEDIA_WRITE_COMMIT_BYTES = 4 * 1024 * 1024;
const MEDIA_PROGRESS_THRESHOLD = 10 * 1024 * 1024;
const MEDIA_DOWNLOAD_CONCURRENCY = 3;

const escapeHTML = (value: string) => value
.replace(/&/g, '&amp;')
.replace(/</g, '&lt;')
.replace(/>/g, '&gt;')
.replace(/"/g, '&quot;')
.replace(/'/g, '&#39;');

const safeName = (value: string) => value.replace(/[\\/:*?"<>|]/g, '_').trim() || 'Chat';

const isCancelled = (signal?: AbortSignal) => signal?.aborted === true;

const waitForRetry = (seconds: number, signal?: AbortSignal, onTick?: (remaining: number) => void) => new Promise<void>((resolve, reject) => {
  if(isCancelled(signal)) {
    reject(new DOMException('Export cancelled', 'AbortError'));
    return;
  }

  let remaining = seconds;
  onTick?.(remaining);
  const interval = window.setInterval(() => onTick?.(--remaining), 1000);
  const timer = window.setTimeout(() => {
    window.clearInterval(interval);
    resolve();
  }, seconds * 1000);
  signal?.addEventListener('abort', () => {
    window.clearTimeout(timer);
    window.clearInterval(interval);
    reject(new DOMException('Export cancelled', 'AbortError'));
  }, {once: true});
});

const getFloodWaitSeconds = (error: unknown) => {
  const type = typeof error === 'object' && error && 'type' in error ? String(error.type) : '';
  const message = error instanceof Error ? error.message : '';
  const match = `${type} ${message}`.match(/FLOOD_WAIT[_ ](\d+)/i);
  return match ? Number(match[1]) : undefined;
};

const requestExportHistory = async(
  options: Parameters<typeof rootScope.managers.appMessagesManager.requestHistory>[0],
  signal?: AbortSignal,
  onRateLimit?: (seconds: number) => void
) => {
  while(true) {
    if(isCancelled(signal)) throw new DOMException('Export cancelled', 'AbortError');
    try {
      return await rootScope.managers.appMessagesManager.requestHistory(options);
    } catch(error) {
      const seconds = getFloodWaitSeconds(error);
      if(seconds === undefined) throw error;
      console.info(`[ChatExport] Telegram rate limit; waiting ${seconds}s before retrying`);
      onRateLimit?.(seconds);
      await waitForRetry(seconds, signal, (remaining) => onRateLimit?.(remaining));
    }
  }
};

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

const getMediaExtension = (media: Photo.photo | Document.document) => {
  if(media._ === 'photo') return 'jpg';
  const document = media as Document.document;
  const filenameAttribute = document.attributes.find((attribute) => attribute._ === 'documentAttributeFilename') as {file_name?: string} | undefined;
  const filename = filenameAttribute?.file_name;
  const filenameExtension = filename?.split('.').pop()?.toLowerCase();
  if(filenameExtension && filenameExtension !== filename?.toLowerCase()) return filenameExtension;
  const mimeExtension = document.mime_type?.split('/').pop()?.toLowerCase();
  return mimeExtension === 'jpeg' ? 'jpg' : mimeExtension || 'bin';
};

const getMediaSize = (media: Photo.photo | Document.document) => {
  if(media._ === 'document') {
    return typeof media.size === 'number' ? media.size : undefined;
  }

  return media.sizes.reduce<number | undefined>((largest, size) => {
    if(size._ === 'photoSize' && typeof size.size === 'number') return Math.max(largest || 0, size.size);
    if(size._ === 'photoSizeProgressive' && size.sizes.length) return Math.max(largest || 0, size.sizes[size.sizes.length - 1]);
    return largest;
  }, undefined);
};

const formatMediaSize = (bytes?: number) => {
  if(bytes === undefined || !Number.isFinite(bytes)) return 'size unknown';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = Math.max(0, bytes);
  let unit = 0;
  while(value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  const precision = unit === 0 ? 0 : value >= 10 ? 1 : 2;
  return `${value.toFixed(precision)} ${units[unit]}`;
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
  let media = '';
  if(message.media?.fileName) {
    const fileName = escapeHTML(message.media.fileName);
    if(message.media.type === 'photos') {
      media = `<div class="media_wrap clearfix"><a href="${fileName}"><img src="${fileName}" class="media_photo"></a></div>`;
    } else if(['videos', 'video_notes', 'animated_gif'].includes(message.media.type)) {
      media = `<div class="media_wrap clearfix"><video controls preload="metadata" src="${fileName}"></video></div>`;
    } else {
      media = `<div class="media_wrap clearfix"><a href="${fileName}">${fileName.split('/').pop()}</a></div>`;
    }
  }
  return `<div class="message default clearfix" id="message${message.id}"><div class="body"><div class="pull_right date details" title="${escapeHTML(message.date)}">${escapeHTML(new Date(message.date).toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'}))}</div>${sender ? `<div class="from_name">${sender}</div>` : ''}${media}<div class="text">${text}</div></div></div>\n`;
};

const downloadMediaToFile = async(
  media: Photo.photo | Document.document,
  directory: ExportDirectoryHandle,
  name: string,
  expectedSize?: number,
  onProgress?: (downloaded: number) => void
) => {
  const fileHandle = await directory.getFileHandle(name, {create: true});
  const existingFile = await fileHandle.getFile?.();
  const existingSize = existingFile?.size || 0;
  if(expectedSize !== undefined && existingSize === expectedSize) {
    onProgress?.(existingSize);
    return;
  }
  const offset = expectedSize !== undefined ?
    Math.floor(Math.min(existingSize, expectedSize) / 524288) * 524288 :
    0;
  let writable = await fileHandle.createWritable({keepExistingData: offset > 0});
  if(offset && writable.seek) await writable.seek(offset);
  if(writable.truncate && offset !== existingSize) await writable.truncate(offset);
  let writtenBytes = offset;
  let uncommittedBytes = 0;
  const thumb = media._ === 'photo' ?
    media.sizes.filter((size) => size._ === 'photoSize' || size._ === 'photoSizeProgressive').at(-1) :
    undefined;

  onProgress?.(offset);
  if(mediaSizeIsSmall(expectedSize, existingSize)) {
    await writable.close();
    const url = await appDownloadManager.downloadMediaURL({media, thumb});
    const response = await fetch(url);
    if(!response.ok) throw new Error(`MEDIA_CACHE_FETCH_FAILED_${response.status}`);
    const blob = await response.blob();
    if(expectedSize !== undefined && blob.size !== expectedSize) {
      throw new Error(`MEDIA_CACHE_SIZE_MISMATCH_${blob.size}_${expectedSize}`);
    }
    const smallWritable = await fileHandle.createWritable();
    await smallWritable.write(blob);
    await smallWritable.close();
    onProgress?.(blob.size);
    return;
  }
  let downloadedBytes: number;
  try {
    downloadedBytes = await downloadMediaParts(media, thumb, async(bytes) => {
      await writable.write(bytes);
      writtenBytes += bytes.byteLength;
      uncommittedBytes += bytes.byteLength;
      if(uncommittedBytes >= MEDIA_WRITE_COMMIT_BYTES) {
        await writable.close();
        writable = await fileHandle.createWritable({keepExistingData: true});
        if(writable.seek) await writable.seek(writtenBytes);
        uncommittedBytes = 0;
      }
    }, onProgress ? (downloaded) => onProgress(downloaded) : undefined, offset);
  } catch(error) {
    await writable.close();
    throw error;
  }
  if(expectedSize !== undefined && downloadedBytes !== expectedSize) {
    await writable.close();
    throw new Error(`MEDIA_DOWNLOAD_SIZE_MISMATCH_${downloadedBytes}_${expectedSize}`);
  }
  await writable.close();
};

const mediaSizeIsSmall = (size: number | undefined, existingSize: number) =>
  size !== undefined && size <= MEDIA_PROGRESS_THRESHOLD && existingSize === 0;

const writeFile = async(directory: ExportDirectoryHandle, name: string, data: string, type: string) => {
  const handle = await directory.getFileHandle(name, {create: true});
  const writable = await handle.createWritable();
  await writable.write(new Blob([data], {type}));
  await writable.close();
};

const createWriter = async(directory: ExportDirectoryHandle, name: string) => {
  const handle = await directory.getFileHandle(name, {create: true});
  return handle.createWritable();
};

type ExportCheckpoint = {
  schema_version: number,
  export_key: string,
  status: 'exporting' | 'completed',
  chat: {peer_id: PeerId, title: string, thread_id: number | null},
  exported_at: string,
  range: {from: string | null, to: string | null},
  formats: ChatExportFormat[],
  media_types: ChatExportMediaType[],
  max_media_bytes: number,
  message_count: number,
  total_count?: number,
  next_offset_id: number | null,
  parts: {path: string, format: ChatExportFormat, message_count: number}[],
  media_files?: {path: string, size?: number}[],
  failed_media?: {path: string, message_id: number, size?: number}[],
  active_files?: ExportActiveFile[],
  last_item?: {type: string, message_id: number, date: string, path?: string, status: 'pending' | 'completed' | 'failed'},
};

type ExportActiveFile = {
  path: string;
  message_id: number;
  size?: number;
  downloaded: number;
  status: 'pending' | 'downloading' | 'downloaded' | 'failed';
};

const getExportKey = (options: ChatExportOptions) => JSON.stringify({
  peerId: options.peerId,
  threadId: options.threadId || null,
  formats: options.formats.slice().sort(),
  mediaTypes: options.mediaTypes.slice().sort(),
  maxMediaBytes: options.maxMediaBytes,
  fromDate: options.fromDate?.toISOString() || null,
  toDate: options.toDate?.toISOString() || null
});

const readCheckpoint = async(directory: ExportDirectoryHandle) => {
  try {
    const handle = await directory.getFileHandle('export_metadata.json');
    const file = await handle.getFile?.();
    if(!file) return undefined;
    return JSON.parse(await file.text()) as ExportCheckpoint;
  } catch(error) {
    if(error instanceof DOMException && error.name === 'NotFoundError') return undefined;
    throw error;
  }
};

const getExportDirectory = async(directory: ExportDirectoryHandle, title: string, exportKey: string) => {
  const prefix = `${safeName(title)}_`;
  if(directory.values) {
    for await (const entry of directory.values()) {
      if(entry.kind !== 'directory' || !entry.name.startsWith(prefix)) continue;
      const candidate = await directory.getDirectoryHandle(entry.name);
      const checkpoint = await readCheckpoint(candidate);
      if(checkpoint?.export_key === exportKey && checkpoint.status !== 'completed') {
        return candidate;
      }
    }
  }

  return directory.getDirectoryHandle(`${prefix}${getLocalTimestamp()}`, {create: true});
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

  const exportKey = getExportKey(options);
  const exportDirectory = await getExportDirectory(directory, options.title, exportKey);
  const checkpoint = await readCheckpoint(exportDirectory);
  const canResume = checkpoint?.export_key === exportKey && checkpoint.status !== 'completed' && checkpoint.next_offset_id !== null;
  let exportedCount = canResume ? checkpoint.message_count : 0;
  let partNumber = canResume ? checkpoint.parts.reduce((max, part) => {
    const match = part.path.match(/-(\d{4})\.(?:json|html)$/);
    return Math.max(max, match ? Number(match[1]) : 0);
  }, 0) : 0;
  const parts: {path: string, format: ChatExportFormat, message_count: number}[] = canResume ? checkpoint.parts.slice() : [];
  let offsetId = canResume ? checkpoint.next_offset_id : 0;
  let total: number | undefined;
  const visitedOffsets = new Set<number>();
  const completedMedia = new Map((canResume ? checkpoint.media_files || [] : []).map((file) => [file.path, file.size]));
  const failedMedia = new Map((canResume ? checkpoint.failed_media || [] : []).map((file) => [file.path, file]));
  const activeFiles = new Map<string, ExportActiveFile>(
    canResume ? (checkpoint.active_files || []).map((file) => [file.path, file]) : []
  );
  let lastItem = canResume ? checkpoint.last_item : undefined;
  const resumeItem = canResume ? checkpoint.last_item : undefined;
  let checkpointWritePromise = Promise.resolve();

  const writeCheckpoint = (
    status: ExportCheckpoint['status'],
    nextOffsetId: number | null,
    messageCount = exportedCount
  ) => {
    const write = checkpointWritePromise.then(() => writeFile(exportDirectory, 'export_metadata.json', JSON.stringify({
      schema_version: 3,
      export_key: exportKey,
      status,
      chat: {peer_id: peerId, title: options.title, thread_id: threadId || null},
      exported_at: new Date().toISOString(),
      range: {from: options.fromDate?.toISOString() || null, to: options.toDate?.toISOString() || null},
      formats,
      media_types: options.mediaTypes,
      max_media_bytes: options.maxMediaBytes,
      message_count: messageCount,
      total_count: total,
      next_offset_id: nextOffsetId,
      parts,
      media_files: Array.from(completedMedia, ([path, size]) => ({path, size})),
      failed_media: Array.from(failedMedia.values()),
      active_files: Array.from(activeFiles.values()),
      last_item: lastItem
    } satisfies ExportCheckpoint, null, 2), 'application/json'));
    checkpointWritePromise = write.catch(() => undefined);
    return write;
  };

  while(true) {
    if(isCancelled(signal)) throw new DOMException('Export cancelled', 'AbortError');

    const result = await requestExportHistory({
      peerId,
      threadId,
      offsetId,
      limit: PAGE_SIZE,
      historyType: threadId ? HistoryType.Thread : HistoryType.Chat
    }, signal, (seconds) => {
      onProgress?.({loaded: exportedCount, total, current: `Telegram 限流，等待 ${seconds} 秒`, phase: 'history'});
    });

    const rawMessages = result.messages || [];
    total = 'count' in result ? result.count || total : total;
    const messageIds = rawMessages
    .filter((message): message is Message.message | Message.messageService => message._ === 'message' || message._ === 'messageService')
    .map((message) => (message as (Message.message | Message.messageService) & {mid?: number}).mid ?? message.id);
    if(!messageIds.length) break;
    const page = (await Promise.all(messageIds.map(async(mid: number) => {
      try {
        return await rootScope.managers.appMessagesManager.getMessageByPeer(peerId, mid);
      } catch(error) {
        console.warn('[ChatExport] skipping unreadable message', {peerId, mid, error});
        return undefined;
      }
    }))).filter(Boolean) as MyMessage[];
    const dates = page
    .filter((message) => {
      const timestamp = message.date * 1000;
      return (!options.fromDate || timestamp >= options.fromDate.getTime()) &&
        (!options.toDate || timestamp <= options.toDate.getTime());
    })
    .map((message) => message.date);
    const dateSource = dates.length ? dates : page.map((message) => message.date);
    const fallbackDate = Math.floor(Date.now() / 1000);
    const firstDate = dateSource.length ? Math.min(...dateSource) : fallbackDate;
    const lastDate = dateSource.length ? Math.max(...dateSource) : fallbackDate;
    const partName = `messages-${formatExportDate(firstDate)}_to_${formatExportDate(lastDate)}-${('0000' + ++partNumber).slice(-4)}`;
    const pageStartExportedCount = exportedCount;
    let pageHadFailures = false;
    const jsonWriter = formats.includes('json') ? await createWriter(exportDirectory, `${partName}.json`) : undefined;
    const htmlWriter = formats.includes('html') ? await createWriter(exportDirectory, `${partName}.html`) : undefined;
    let jsonFirst = true;
    let partCount = 0;
    if(jsonWriter) await jsonWriter.write('[');
    if(htmlWriter) await htmlWriter.write(`<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHTML(options.title)}</title><style>html,body{margin:0;padding:0;background:#fff;color:#222;font:14px Arial,sans-serif}.page_wrap{min-height:100vh}.page_header{padding:18px 24px;background:#517da2;color:#fff}.page_header .text{font-size:20px;font-weight:600}.page_body{max-width:980px;margin:0 auto;padding:24px}.message{position:relative;display:flex;gap:12px;padding:10px 0;border-bottom:1px solid #e6e6e6}.body{min-width:0;flex:1}.date{float:right;color:#999;font-size:12px}.from_name{margin-bottom:5px;color:#517da2;font-weight:600}.text{white-space:normal;overflow-wrap:anywhere;line-height:1.45}.media_wrap{margin:6px 0}.media_photo{display:block;max-width:min(100%,640px);max-height:640px;border-radius:4px}.media_wrap video{display:block;max-width:min(100%,640px);max-height:640px}.media_wrap a{color:#517da2;text-decoration:none}.details{color:#999}</style></head><body><div class="page_wrap"><div class="page_header"><div class="content"><div class="text bold">${escapeHTML(options.title)}</div></div></div><div class="page_body chat_page"><div class="history">`);

    const processed = new Array<{exported: ExportedMessage, itemFailed: boolean, mediaPath?: string}>(page.length);
    let nextMessageIndex = 0;
    const processMessage = async(message: MyMessage, index: number) => {
      const timestamp = message.date * 1000;
      if(options.fromDate && timestamp < options.fromDate.getTime()) return;
      if(options.toDate && timestamp > options.toDate.getTime()) return;
      const exported = normalizeMessage(message);
      const messageTime = new Date(timestamp).toLocaleString();
      onProgress?.({loaded: exportedCount, total, current: messageTime, phase: 'history'});
      const mediaType = getMediaType(message);
      let itemFailed = false;
      let mediaPath: string | undefined;
      if(mediaType && options.mediaTypes.includes(mediaType)) {
        const media = getMediaFromMessage(message, true);
        const mediaSize = media ? getMediaSize(media as Photo.photo | Document.document) : undefined;
        if(media && (!mediaSize || mediaSize <= options.maxMediaBytes)) {
          const mediaDirectoryName = mediaType === 'photos' ? 'photos' : mediaType === 'videos' || mediaType === 'video_notes' || mediaType === 'animated_gif' ? 'video_files' : 'files';
          const mediaDirectory = await exportDirectory.getDirectoryHandle(mediaDirectoryName, {create: true});
          const extension = getMediaExtension(media as Photo.photo | Document.document);
          const fileName = `${message.mid}.${extension}`;
          mediaPath = `${mediaDirectoryName}/${fileName}`;
          onProgress?.({loaded: exportedCount, total, current: `${fileName} (${formatMediaSize(mediaSize)})`, phase: 'history'});
          try {
            const existingHandle = await mediaDirectory.getFileHandle(fileName, {create: true});
            const existingFile = await existingHandle.getFile?.();
            const existingSize = existingFile?.size || 0;
            const isComplete = mediaSize !== undefined && existingSize === mediaSize;
            const isInterruptedResumeItem = resumeItem?.message_id === message.mid && resumeItem.status !== 'completed';
            const reuseMedia = isComplete && !failedMedia.has(mediaPath) && !isInterruptedResumeItem;
            if(!reuseMedia) {
              activeFiles.set(mediaPath, {
                path: mediaPath,
                message_id: message.mid,
                size: mediaSize,
                downloaded: existingSize,
                status: 'pending'
              });
              activeFiles.get(mediaPath)!.status = 'downloading';
              await writeCheckpoint('exporting', offsetId, pageStartExportedCount);
              await downloadMediaToFile(
                media as Photo.photo | Document.document,
                mediaDirectory,
                fileName,
                mediaSize,
                mediaSize !== undefined && mediaSize > MEDIA_PROGRESS_THRESHOLD ?
                  (downloaded) => {
                    const current = activeFiles.get(mediaPath!);
                    if(current) current.downloaded = downloaded;
                    onProgress?.({loaded: exportedCount, total, current: `${fileName} (${formatMediaSize(downloaded)} / ${formatMediaSize(mediaSize)})`, phase: 'history'});
                  } :
                  (downloaded) => {
                    const current = activeFiles.get(mediaPath!);
                    if(current) current.downloaded = downloaded;
                  }
              );
              activeFiles.set(mediaPath, {...activeFiles.get(mediaPath)!, downloaded: mediaSize || existingSize, status: 'downloaded'});
              completedMedia.set(mediaPath, mediaSize);
              failedMedia.delete(mediaPath);
              await writeCheckpoint('exporting', offsetId, pageStartExportedCount);
            } else {
              activeFiles.set(mediaPath, {
                path: mediaPath,
                message_id: message.mid,
                size: mediaSize,
                downloaded: existingSize,
                status: 'downloaded'
              });
            }
            exported.media = {type: mediaType, fileName: mediaPath};
          } catch(error) {
            if(isCancelled(signal)) throw error;
            const failedHandle = await mediaDirectory.getFileHandle(fileName, {create: true});
            const failedFile = await failedHandle.getFile?.();
            if(failedFile?.size === 0 && mediaDirectory.removeEntry) {
              await mediaDirectory.removeEntry(fileName);
            }
            pageHadFailures = true;
            itemFailed = true;
            const current = activeFiles.get(mediaPath) || {path: mediaPath, message_id: message.mid, size: mediaSize, downloaded: 0, status: 'pending' as const};
            activeFiles.set(mediaPath, {...current, status: 'failed'});
            failedMedia.set(mediaPath, {path: mediaPath, message_id: message.mid, size: mediaSize});
            await writeCheckpoint('exporting', offsetId, pageStartExportedCount);
            console.warn('[ChatExport] media download failed; continuing without media file', {peerId, mid: message.mid, mediaType, error});
          }
        } else if(media) {
          console.info('[ChatExport] media skipped because it exceeds the size limit', {peerId, mid: message.mid, mediaType, mediaSize, maxMediaBytes: options.maxMediaBytes});
        }
      }
      processed[index] = {exported, itemFailed, mediaPath};
    };
    const workers = Array.from({length: Math.min(MEDIA_DOWNLOAD_CONCURRENCY, page.length)}, async() => {
      while(nextMessageIndex < page.length) {
        const index = nextMessageIndex++;
        await processMessage(page[index], index);
      }
    });
    await Promise.all(workers);

    for(const result of processed) {
      if(!result) continue;
      const {exported, itemFailed, mediaPath} = result;
      lastItem = {
        type: exported.media?.type || (exported.service || 'message'),
        message_id: exported.id,
        date: exported.date,
        path: mediaPath,
        status: itemFailed ? 'failed' : 'completed'
      };
      if(itemFailed) pageHadFailures = true;
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
      await htmlWriter.write('</div></div></div></body></html>');
      await htmlWriter.close();
      parts.push({path: `${partName}.html`, format: 'html', message_count: partCount});
    }
    if(pageHadFailures) {
      for(let index = parts.length - 1; index >= 0; index--) {
        if(parts[index].path.startsWith(`${partName}.`)) parts.splice(index, 1);
      }
    }
    const lastId = messageIds[messageIds.length - 1];
    if(pageHadFailures) exportedCount = pageStartExportedCount;
    await writeCheckpoint('exporting', pageHadFailures ? offsetId : lastId);
    onProgress?.({loaded: exportedCount, total, phase: 'history'});
    if(!lastId || visitedOffsets.has(lastId)) break;
    visitedOffsets.add(lastId);
    offsetId = lastId;
  }

  onProgress?.({loaded: exportedCount, total, phase: 'writing'});

  await writeCheckpoint('completed', null);

  onProgress?.({loaded: exportedCount, total, phase: 'completed'});
}

export async function getExportTitle(peerId: PeerId) {
  return getPeerTitle({peerId, plainText: true});
}
