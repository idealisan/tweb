import type {MyMessage} from '../appManagers/appMessagesManager';
import getPeerTitle from '../../components/wrappers/getPeerTitle';
import {downloadMediaParts} from './chatMediaPartDownloader';
import rootScope from '../rootScope';
import appDownloadManager from '../appManagers/appDownloadManager';
import getMediaFromMessage from '../appManagers/utils/messages/getMediaFromMessage';
import {Document, DocumentAttribute, Photo, PhotoSize} from '../../layer';

export type ChatExportFormat = 'html' | 'json';
export type ChatExportMediaType = 'photos' | 'videos' | 'voice' | 'video_notes' | 'stickers' | 'animated_gif' | 'files';

export type ExportDirectoryHandle = {
  readonly name?: string;
  values?: () => AsyncIterableIterator<{kind: string, name: string}>;
  removeEntry?: (name: string) => Promise<void>;
  getDirectoryHandle: (name: string, options?: {create?: boolean}) => Promise<ExportDirectoryHandle>;
  getFileHandle: (name: string, options?: {create?: boolean}) => Promise<{
    getFile?: () => Promise<{text: () => Promise<string>, size?: number, lastModified?: number}>;
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
  scheduled?: boolean;
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
  activeFiles?: {
    path: string;
    downloaded: number;
    size?: number;
  }[];
  phase: 'history' | 'writing' | 'completed' | 'cancelled' | 'failed';
};

type ExportedMessage = {
  id: number;
  date: string;
  senderId?: PeerId;
  senderName?: string;
  text: string;
  entities?: unknown[];
  service?: string;
  replyTo?: number;
  editDate?: string;
  groupedId?: string;
  views?: number;
  reactions?: unknown;
  media?: {
    type: string;
    fileName?: string;
    originalFileName?: string;
    mimeType?: string;
    size?: number;
    width?: number;
    height?: number;
    duration?: number;
    error?: string;
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
const MEDIA_WRITE_COMMIT_BYTES = 4 * 1024 * 1024;
const MEDIA_PROGRESS_THRESHOLD = 10 * 1024 * 1024;
const MEDIA_DOWNLOAD_CONCURRENCY = 3;
const MEDIA_PAGE_RETRIES = 3;
const HISTORY_REQUEST_RETRIES = 3;

const escapeHTML = (value: string) => value
.replace(/&/g, '&amp;')
.replace(/</g, '&lt;')
.replace(/>/g, '&gt;')
.replace(/"/g, '&quot;')
.replace(/'/g, '&#39;');

const safeName = (value: string) => value.replace(/[\\/:*?"<>|]/g, '_').trim() || 'Chat';

const isCancelled = (signal?: AbortSignal) => signal?.aborted === true;

const waitForAbortable = <T>(promise: Promise<T>, signal?: AbortSignal) => new Promise<T>((resolve, reject) => {
  if(isCancelled(signal)) {
    reject(new DOMException('Export cancelled', 'AbortError'));
    return;
  }

  let settled = false;
  const onAbort = () => {
    if(settled) return;
    settled = true;
    reject(new DOMException('Export cancelled', 'AbortError'));
  };
  signal?.addEventListener('abort', onAbort, {once: true});
  promise.then((value) => {
    if(settled) return;
    settled = true;
    signal?.removeEventListener('abort', onAbort);
    resolve(value);
  }, (error) => {
    if(settled) return;
    settled = true;
    signal?.removeEventListener('abort', onAbort);
    reject(error);
  });
});

const waitForRetry = (seconds: number, signal?: AbortSignal, onTick?: (remaining: number) => void) => new Promise<void>((resolve, reject) => {
  if(isCancelled(signal)) {
    reject(new DOMException('Export cancelled', 'AbortError'));
    return;
  }

  let remaining = seconds;
  onTick?.(remaining);
  const interval = window.setInterval(() => onTick?.(--remaining), 1000);
  function onAbort() {
    window.clearTimeout(timer);
    window.clearInterval(interval);
    reject(new DOMException('Export cancelled', 'AbortError'));
  }
  const timer = window.setTimeout(() => {
    window.clearInterval(interval);
    signal?.removeEventListener('abort', onAbort);
    resolve();
  }, seconds * 1000);
  signal?.addEventListener('abort', onAbort, {once: true});
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
  let attempts = 0;
  while(true) {
    if(isCancelled(signal)) throw new DOMException('Export cancelled', 'AbortError');
    try {
      return await waitForAbortable(rootScope.managers.appMessagesManager.requestHistory(options), signal);
    } catch(error) {
      if(isCancelled(signal)) throw error;
      const seconds = getFloodWaitSeconds(error);
      if(seconds !== undefined) {
        console.info(`[ChatExport] Telegram rate limit; waiting ${seconds}s before retrying`);
        onRateLimit?.(seconds);
        await waitForRetry(seconds, signal, (remaining) => onRateLimit?.(remaining));
        continue;
      }
      if(++attempts >= HISTORY_REQUEST_RETRIES) throw error;
      const retrySeconds = Math.min(2 ** attempts, 8);
      console.warn(`[ChatExport] history request failed; retrying in ${retrySeconds}s`, error);
      onRateLimit?.(retrySeconds);
      await waitForRetry(retrySeconds, signal, (remaining) => onRateLimit?.(remaining));
    }
  }
};

const normalizeMessage = async(message: MyMessage): Promise<ExportedMessage> => {
  const regularMessage = message as MyMessage & {
    fromId?: PeerId;
    reply_to?: {reply_to_msg_id?: number};
    media?: {_?: string};
    entities?: unknown[];
    edit_date?: number;
    grouped_id?: string;
    views?: number;
    reactions?: unknown;
  };

  const senderName = regularMessage.fromId ?
    await getPeerTitle({peerId: regularMessage.fromId, plainText: true}) :
    undefined;
  const exported: ExportedMessage = {
    id: message.mid,
    date: new Date(message.date * 1000).toISOString(),
    senderId: regularMessage.fromId,
    senderName,
    text: 'message' in message ? message.message || '' : '',
    entities: regularMessage.entities,
    service: 'action' in message ? message.action._ : undefined,
    replyTo: regularMessage.reply_to?.reply_to_msg_id,
    editDate: regularMessage.edit_date ? new Date(regularMessage.edit_date * 1000).toISOString() : undefined,
    groupedId: regularMessage.grouped_id,
    views: regularMessage.views,
    reactions: regularMessage.reactions,
    media: regularMessage.media ? {type: getMediaType(message) || regularMessage.media._} : undefined
  };

  return exported;
};

const getMediaType = (message: MyMessage): ChatExportMediaType | undefined => {
  const media = getMediaFromMessage(message);
  if(!media) return;
  const mediaType = (media as {_?: string})._;
  if(mediaType === 'photo' || mediaType === 'photoEmpty') return 'photos';
  if(mediaType !== 'document' && mediaType !== 'documentEmpty') return;

  const attributes = Array.isArray((media as Document.document).attributes) ?
    (media as Document.document).attributes :
    [];
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
  const filenameExtension = filename?.split('.').pop()?.toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 16);
  if(filenameExtension && filenameExtension !== filename?.toLowerCase()) return filenameExtension;
  const mimeExtension = document.mime_type?.split('/').pop()?.toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 16);
  return mimeExtension === 'jpeg' ? 'jpg' : mimeExtension || 'bin';
};

const getPhotoSizeBytes = (size: PhotoSize) => {
  if(size._ === 'photoSize' && typeof size.size === 'number') return size.size;
  if(size._ === 'photoSizeProgressive' && Array.isArray(size.sizes) && size.sizes.length) return size.sizes[size.sizes.length - 1];
  return 0;
};

const getLargestPhotoSize = (media: Photo.photo) => {
  const sizes = Array.isArray(media.sizes) ?
    media.sizes.filter((size) => size._ === 'photoSize' || size._ === 'photoSizeProgressive') :
    [];
  return sizes
  .reduce<PhotoSize | undefined>((largest, size) => {
    return !largest || getPhotoSizeBytes(size) > getPhotoSizeBytes(largest) ? size : largest;
  }, undefined);
};

const getMediaSize = (media: Photo.photo | Document.document) => {
  if(media._ === 'document') {
    return typeof media.size === 'number' && media.size > 0 ? media.size : undefined;
  }

  const largest = getLargestPhotoSize(media);
  const size = largest ? getPhotoSizeBytes(largest) : 0;
  return size > 0 ? size : undefined;
};

const isExportableMedia = (media: unknown): media is Photo.photo | Document.document => {
  if(!media || typeof media !== 'object') return false;
  const value = media as {_?: string, id?: string | number, sizes?: unknown[], attributes?: unknown[]};
  if(value._ === 'photo') {
    const largest = getLargestPhotoSize(value as Photo.photo);
    return typeof value.id !== 'undefined' &&
      Array.isArray(value.sizes) &&
      value.sizes.length > 0 &&
      !!largest &&
      getPhotoSizeBytes(largest) > 0;
  }
  if(value._ === 'document') return typeof value.id !== 'undefined' && Array.isArray(value.attributes);
  return false;
};

const getMediaIdentity = (media: Photo.photo | Document.document) => {
  const reference = media.file_reference ? Array.from(media.file_reference).join('.') : '';
  return `${media._}:${media.id}:${String(media.access_hash || '')}:${reference}`;
};

const getMediaMetadata = (media: Photo.photo | Document.document) => {
  const value = media as {
    mime_type?: string;
    attributes?: Array<{_: string, file_name?: string, w?: number, h?: number, duration?: number}>;
  };
  const largest = media._ === 'photo' ? getLargestPhotoSize(media) as Partial<PhotoSize> : undefined;
  const filenameAttribute = value.attributes?.find((attribute) => attribute._ === 'documentAttributeFilename');
  const videoAttribute = value.attributes?.find((attribute) => attribute._ === 'documentAttributeVideo');
  const audioAttribute = value.attributes?.find((attribute) => attribute._ === 'documentAttributeAudio');
  return {
    originalFileName: filenameAttribute?.file_name,
    mimeType: value.mime_type,
    size: getMediaSize(media),
    width: largest && 'w' in largest ? largest.w : videoAttribute?.w,
    height: largest && 'h' in largest ? largest.h : videoAttribute?.h,
    duration: videoAttribute?.duration || audioAttribute?.duration
  };
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

const getEntityTag = (entity: Record<string, any>, value: string) => {
  switch(entity._) {
    case 'messageEntityBold':
      return {open: '<strong>', close: '</strong>'};
    case 'messageEntityItalic':
      return {open: '<em>', close: '</em>'};
    case 'messageEntityUnderline':
      return {open: '<u>', close: '</u>'};
    case 'messageEntityStrike':
      return {open: '<s>', close: '</s>'};
    case 'messageEntityCode':
      return {open: '<code>', close: '</code>'};
    case 'messageEntityPre':
      return {open: '<pre><code>', close: '</code></pre>'};
    case 'messageEntityTextUrl':
      return /^https?:\/\/|^tg:\/\/|^mailto:/i.test(entity.url || '') ?
        {open: `<a href="${escapeHTML(entity.url)}" target="_blank" rel="noreferrer noopener">`, close: '</a>'} :
        undefined;
    case 'messageEntityUrl':
      return /^https?:\/\/|^tg:\/\/|^mailto:/i.test(value) ?
        {open: `<a href="${escapeHTML(value)}" target="_blank" rel="noreferrer noopener">`, close: '</a>'} :
        undefined;
    case 'messageEntityEmail':
      return {open: `<a href="mailto:${escapeHTML(value)}">`, close: '</a>'};
    default:
      return undefined;
  }
};

const renderMessageText = (message: ExportedMessage) => {
  const text = getMessageText(message);
  const entities = (message.entities || [])
  .filter((entity): entity is Record<string, any> => !!entity && typeof entity === 'object')
  .map((entity) => {
    const offset = Number(entity.offset);
    const length = Number(entity.length);
    const tag = getEntityTag(entity, text.slice(offset, offset + length));
    return tag && Number.isFinite(offset) && Number.isFinite(length) && length > 0 && offset >= 0 && offset + length <= text.length ?
      {offset, end: offset + length, ...tag} :
      undefined;
  })
  .filter(Boolean) as Array<{offset: number, end: number, open: string, close: string}>;
  if(!entities.length) return escapeHTML(text).replace(/\n/g, '<br>');

  const starts = new Map<number, string[]>();
  const ends = new Map<number, string[]>();
  const boundaries = new Set<number>([0, text.length]);
  entities.forEach((entity) => {
    boundaries.add(entity.offset);
    boundaries.add(entity.end);
    starts.set(entity.offset, [...(starts.get(entity.offset) || []), entity.open]);
    ends.set(entity.end, [entity.close, ...(ends.get(entity.end) || [])]);
  });

  const sortedBoundaries = [...boundaries].sort((a, b) => a - b);
  let html = '';
  for(let i = 0; i < sortedBoundaries.length - 1; i++) {
    const start = sortedBoundaries[i];
    const end = sortedBoundaries[i + 1];
    html += (ends.get(start) || []).join('');
    html += (starts.get(start) || []).join('');
    html += escapeHTML(text.slice(start, end)).replace(/\n/g, '<br>');
  }
  const lastBoundary = sortedBoundaries[sortedBoundaries.length - 1];
  html += (ends.get(lastBoundary) || []).join('');
  html += (starts.get(lastBoundary) || []).join('');
  return html;
};

const formatMessageDate = (date: string) => new Date(date).toLocaleString([], {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false
});

const makeHTMLMessage = (message: ExportedMessage) => {
  const text = renderMessageText(message);
  const sender = escapeHTML(message.senderName || (message.senderId ? '' + message.senderId : ''));
  const messageDate = formatMessageDate(message.date);
  let media = '';
  if(message.media?.fileName) {
    const fileName = escapeHTML(message.media.fileName);
    if(message.media.type === 'photos') {
      media = `<div class="media_wrap clearfix"><a href="${fileName}"><img src="${fileName}" class="media_photo"></a></div>`;
    } else if(['videos', 'video_notes', 'animated_gif'].includes(message.media.type)) {
      media = `<div class="media_wrap clearfix"><video controls preload="metadata" playsinline src="${fileName}"></video></div>`;
    } else if(message.media.type === 'voice') {
      media = `<div class="media_wrap clearfix"><audio controls preload="metadata" src="${fileName}"></audio></div>`;
    } else {
      media = `<div class="media_wrap clearfix"><a href="${fileName}">${escapeHTML(message.media.originalFileName || fileName.split('/').pop() || fileName)}</a></div>`;
    }
  }
  return `<div class="message default clearfix" id="message${message.id}"><div class="body"><div class="pull_right date details" title="${escapeHTML(message.date)}">${escapeHTML(messageDate)}</div>${sender ? `<div class="from_name">${sender}</div>` : ''}${media}<div class="text">${text}</div></div></div>\n`;
};

const downloadMediaToFile = async(
  media: Photo.photo | Document.document,
  directory: ExportDirectoryHandle,
  name: string,
  expectedSize?: number,
  onProgress?: (downloaded: number) => void,
  signal?: AbortSignal,
  maxBytes?: number,
  resumeExisting = false
): Promise<number> => {
  if(isCancelled(signal)) throw new DOMException('Export cancelled', 'AbortError');
  const fileHandle = await directory.getFileHandle(name, {create: true});
  const existingFile = await fileHandle.getFile?.();
  const existingSize = resumeExisting ? existingFile?.size || 0 : 0;
  const offset = expectedSize !== undefined ?
    Math.floor(Math.min(existingSize, expectedSize) / 524288) * 524288 :
    0;
  let writable = await fileHandle.createWritable({keepExistingData: offset > 0});
  const seekWritable = async(position: number) => {
    if(!position) return;
    if(!writable.seek) throw new Error('MEDIA_WRITER_SEEK_UNSUPPORTED');
    await writable.seek(position);
  };
  try {
    await seekWritable(offset);
    if(offset > 0 && offset !== existingSize) {
      if(!writable.truncate) throw new Error('MEDIA_WRITER_TRUNCATE_UNSUPPORTED');
      await writable.truncate(offset);
    }
  } catch(error) {
    try {
      await writable.close();
    } catch(closeError) {
      console.error('[ChatExport] failed to close media writer after setup error', closeError);
    }
    throw error;
  }
  let writtenBytes = offset;
  let uncommittedBytes = 0;
  const thumb = media._ === 'photo' ?
    getLargestPhotoSize(media) :
    undefined;

  onProgress?.(offset);
  if(mediaSizeIsSmall(expectedSize, existingSize)) {
    await writable.close();
    try {
      const url = await appDownloadManager.downloadMediaURL({media, thumb});
      const response = await fetch(url);
      if(!response.ok) throw new Error(`MEDIA_CACHE_FETCH_FAILED_${response.status}`);
      const blob = await response.blob();
      if(blob.size > 0 && expectedSize !== undefined && blob.size === expectedSize) {
        const smallWritable = await fileHandle.createWritable();
        try {
          await smallWritable.write(blob);
          await smallWritable.close();
        } catch(error) {
          try {
            await smallWritable.close();
          } catch(closeError) {
            console.error('[ChatExport] failed to close cached media writer', closeError);
          }
          throw error;
        }
        const cachedFile = await fileHandle.getFile?.();
        if(cachedFile?.size === blob.size) {
          onProgress?.(blob.size);
          return blob.size;
        }
        console.warn('[ChatExport] cached media disk size mismatch; downloading original', {
          actualSize: cachedFile?.size,
          expectedSize: blob.size
        });
      }
      console.warn(`[ChatExport] cached media size mismatch; downloading original`, {
        actualSize: blob.size,
        expectedSize
      });
    } catch(error) {
      console.warn('[ChatExport] cached media unavailable; downloading original', error);
    }
    try {
      writable = await fileHandle.createWritable();
      if(writable.truncate) await writable.truncate(0);
    } catch(error) {
      try {
        await writable.close();
      } catch(closeError) {
        console.error('[ChatExport] failed to close media writer after cache fallback setup error', closeError);
      }
      throw error;
    }
    writtenBytes = 0;
    uncommittedBytes = 0;
  }
  let downloadedBytes: number;
  try {
    downloadedBytes = await downloadMediaParts(media, thumb, async(bytes) => {
      if(isCancelled(signal)) throw new DOMException('Export cancelled', 'AbortError');
      await writable.write(bytes);
      writtenBytes += bytes.byteLength;
      uncommittedBytes += bytes.byteLength;
      if(uncommittedBytes >= MEDIA_WRITE_COMMIT_BYTES) {
        await writable.close();
        writable = await fileHandle.createWritable({keepExistingData: true});
        await seekWritable(writtenBytes);
        uncommittedBytes = 0;
      }
    }, onProgress ? (downloaded) => onProgress(downloaded) : undefined, offset, signal, maxBytes);
  } catch(error) {
    try {
      await writable.close();
    } catch(closeError) {
      console.error('[ChatExport] failed to close media writer after download error', closeError);
    }
    throw error;
  }
  await writable.close();
  if(expectedSize !== undefined && downloadedBytes !== expectedSize) {
    throw new Error(`MEDIA_DOWNLOAD_SIZE_MISMATCH_${downloadedBytes}_${expectedSize}`);
  }
  const completedFile = await fileHandle.getFile?.();
  const completedSize = completedFile?.size;
  if(completedSize === undefined || completedSize <= 0) {
    throw new Error('MEDIA_WRITE_EMPTY_FILE');
  }
  if(expectedSize !== undefined && completedSize !== expectedSize) {
    throw new Error(`MEDIA_WRITE_SIZE_MISMATCH_${completedSize}_${expectedSize}`);
  }
  if(maxBytes !== undefined && completedSize > maxBytes) {
    throw new Error(`MEDIA_WRITE_SIZE_LIMIT_${completedSize}_${maxBytes}`);
  }
  return completedSize;
};

const mediaSizeIsSmall = (size: number | undefined, existingSize: number) =>
  size !== undefined && size > 0 && size <= MEDIA_PROGRESS_THRESHOLD && existingSize === 0;

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
  chat: {peer_id: PeerId, title: string, thread_id: number | null, scheduled?: boolean},
  exported_at: string,
  updated_at?: string,
  range: {from: string | null, to: string | null},
  formats: ChatExportFormat[],
  media_types: ChatExportMediaType[],
  max_media_bytes: number,
  message_count: number,
  total_count?: number,
  history_peer_id?: PeerId,
  next_offset_id: number | null,
  next_scheduled_index?: number | null,
  next_scheduled_mid?: number | null,
  parts: {path: string, format: ChatExportFormat, message_count: number}[],
  media_files?: {path: string, size?: number, identity?: string, modified_at?: number}[],
  failed_media?: {path: string, message_id: number, size?: number, identity?: string}[],
  active_files?: ExportActiveFile[],
  last_item?: {type: string, message_id: number, date: string, path?: string, status: 'pending' | 'completed' | 'failed'},
};

type ExportActiveFile = {
  path: string;
  message_id: number;
  size?: number;
  identity?: string;
  downloaded: number;
  status: 'pending' | 'downloading' | 'downloaded' | 'failed';
};

const getExportKey = (options: ChatExportOptions) => JSON.stringify({
  peerId: options.peerId,
  threadId: options.threadId || null,
  scheduled: !!options.scheduled,
  formats: options.formats.slice().sort(),
  mediaTypes: options.mediaTypes.slice().sort(),
  maxMediaBytes: options.maxMediaBytes,
  fromDate: options.fromDate?.toISOString() || null,
  toDate: options.toDate?.toISOString() || null
});

const readCheckpoint = async(directory: ExportDirectoryHandle) => {
  const names = ['export_metadata.json', 'export_metadata.json.bak', 'export_metadata.json.tmp'];
  const checkpoints: ExportCheckpoint[] = [];
  let lastError: unknown;
  for(const name of names) {
    try {
      const handle = await directory.getFileHandle(name);
      const file = await handle.getFile?.();
      if(!file) continue;
      const parsed = JSON.parse(await file.text());
      if(!parsed || typeof parsed !== 'object') throw new Error('EXPORT_CHECKPOINT_INVALID');
      checkpoints.push(parsed as ExportCheckpoint);
    } catch(error) {
      if(error instanceof DOMException && error.name === 'NotFoundError') continue;
      lastError = error;
    }
  }
  if(!checkpoints.length && lastError) {
    console.warn('[ChatExport] all checkpoint copies are unreadable', lastError);
  }
  checkpoints.sort((left, right) => {
    const leftTime = Date.parse(left.updated_at || left.exported_at);
    const rightTime = Date.parse(right.updated_at || right.exported_at);
    return rightTime - leftTime;
  });
  return checkpoints[0];
};

const checkpointPartsExist = async(directory: ExportDirectoryHandle, checkpoint: ExportCheckpoint) => {
  if(checkpoint.message_count > 0 && !checkpoint.parts?.length) return false;
  for(const part of checkpoint.parts || []) {
    try {
      const file = await (await directory.getFileHandle(part.path)).getFile?.();
      if(!file || file.size === undefined || file.size <= 0) return false;
    } catch(error) {
      if(error instanceof DOMException && error.name === 'NotFoundError') return false;
      throw error;
    }
  }
  return true;
};

const getExportDirectory = async(directory: ExportDirectoryHandle, title: string, exportKey: string) => {
  const prefix = `${safeName(title)}_`;
  const existingNames = new Set<string>();
  const candidates: Array<{directory: ExportDirectoryHandle, checkpoint: ExportCheckpoint}> = [];
  if(directory.values) {
    for await (const entry of directory.values()) {
      existingNames.add(entry.name);
      if(entry.kind !== 'directory' || !entry.name.startsWith(prefix)) continue;
      const candidate = await directory.getDirectoryHandle(entry.name);
      const checkpoint = await readCheckpoint(candidate);
      if(checkpoint?.schema_version === 5 && checkpoint.export_key === exportKey && checkpoint.status !== 'completed') {
        if(await checkpointPartsExist(candidate, checkpoint)) {
          candidates.push({directory: candidate, checkpoint});
        } else {
          console.warn('[ChatExport] skipping resume directory with missing message parts', entry.name);
        }
      }
    }
  }

  candidates.sort((left, right) => {
    const leftTime = Date.parse(left.checkpoint.updated_at || left.checkpoint.exported_at);
    const rightTime = Date.parse(right.checkpoint.updated_at || right.checkpoint.exported_at);
    return rightTime - leftTime;
  });
  if(candidates.length) return candidates[0].directory;
  const baseName = `${prefix}${getLocalTimestamp()}`;
  let name = baseName;
  let suffix = 2;
  while(existingNames.has(name)) {
    name = `${baseName}_${suffix++}`;
  }
  return directory.getDirectoryHandle(name, {create: true});
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
  const scheduled = !!options.scheduled;
  if(isCancelled(signal)) throw new DOMException('Export cancelled', 'AbortError');
  if(!formats.length) throw new Error('EXPORT_FORMAT_REQUIRED');
  if(formats.some((format) => format !== 'html' && format !== 'json')) throw new Error('EXPORT_FORMAT_INVALID');
  if(!Number.isInteger(options.maxMediaBytes) ||
    options.maxMediaBytes < 4 * 1024 ||
    options.maxMediaBytes > 4 * 1024 ** 3) {
    throw new Error('EXPORT_MEDIA_SIZE_INVALID');
  }
  if((options.fromDate && Number.isNaN(options.fromDate.getTime())) ||
    (options.toDate && Number.isNaN(options.toDate.getTime())) ||
    (options.fromDate && options.toDate && options.fromDate.getTime() > options.toDate.getTime())) {
    throw new Error('EXPORT_DATE_RANGE_INVALID');
  }

  const exportKey = getExportKey(options);
  const exportDirectory = await getExportDirectory(directory, options.title, exportKey);
  const checkpoint = await readCheckpoint(exportDirectory);
  if(isCancelled(signal)) throw new DOMException('Export cancelled', 'AbortError');
  const canResume = checkpoint?.schema_version === 5 &&
    checkpoint.export_key === exportKey &&
    checkpoint.status !== 'completed' &&
    (scheduled ? typeof checkpoint.next_scheduled_index === 'number' : typeof checkpoint.next_offset_id === 'number');
  let exportedCount = canResume ? checkpoint.message_count : 0;
  let partNumber = canResume ? (checkpoint.parts || []).reduce((max, part) => {
    const match = part.path.match(/-(\d{4})\.(?:json|html)$/);
    return Math.max(max, match ? Number(match[1]) : 0);
  }, 0) : 0;
  const parts: {path: string, format: ChatExportFormat, message_count: number}[] = canResume ? (checkpoint.parts || []).slice() : [];
  const initialMigration = !scheduled && !threadId ?
    await rootScope.managers.appMessagesManager.getMigration(peerId) :
    undefined;
  const initialHistoryPeerId = initialMigration?.next || peerId;
  let offsetId = !scheduled && canResume ? checkpoint.next_offset_id || 0 : 0;
  let historyPeerId = !scheduled && canResume ? checkpoint.history_peer_id || initialHistoryPeerId : initialHistoryPeerId;
  let scheduledIndex = scheduled && canResume ? checkpoint.next_scheduled_index || 0 : 0;
  let total: number | undefined;
  let hasMigratedHistory = !scheduled && !threadId &&
    !!(await rootScope.managers.appMessagesManager.getMigration(historyPeerId))?.prev;
  const visitedOffsets = new Set<number>();
  const completedMedia = new Map<string, {path: string, size?: number, identity?: string, modified_at?: number}>();
  (canResume ? checkpoint.media_files || [] : []).forEach((file) => {
    if(file?.path) completedMedia.set(file.path, file);
  });
  const failedMedia = new Map<string, {path: string, message_id: number, size?: number, identity?: string}>();
  (canResume ? checkpoint.failed_media || [] : []).forEach((file) => {
    if(file?.path) failedMedia.set(file.path, file);
  });
  const activeFiles = new Map<string, ExportActiveFile>();
  (canResume ? checkpoint.active_files || [] : []).forEach((file) => {
    if(file?.path && (file.status === 'pending' || file.status === 'downloading')) {
      activeFiles.set(file.path, {...file, status: 'pending'});
    }
  });
  let lastItem = canResume ? checkpoint.last_item : undefined;
  let resumeItemGuard = canResume && checkpoint.last_item?.status !== 'completed' ?
    checkpoint.last_item :
    undefined;
  let checkpointWritePromise = Promise.resolve();
  const pageAttempts = new Map<number, number>();
  const reportProgress = (progress: Omit<ChatExportProgress, 'activeFiles'>) => {
    onProgress?.({
      ...progress,
      activeFiles: Array.from(activeFiles.values())
      .filter((file) => file.status === 'downloading')
      .map(({path, downloaded, size}) => ({path, downloaded, size}))
    });
  };

  const removeCheckpointTemp = async() => {
    try {
      await exportDirectory.removeEntry?.('export_metadata.json.tmp');
    } catch(error) {
      if(!(error instanceof DOMException && error.name === 'NotFoundError')) {
        console.warn('[ChatExport] failed to remove checkpoint temp file', error);
      }
    }
  };

  const writeCheckpoint = (
    status: ExportCheckpoint['status'],
    nextOffsetId: number | null,
    messageCount = exportedCount,
    nextScheduledIndex: number | null = scheduled ? scheduledIndex : null
  ) => {
    const checkpointData: ExportCheckpoint = {
      schema_version: 5,
      export_key: exportKey,
      status,
      chat: {peer_id: peerId, title: options.title, thread_id: threadId || null, scheduled},
      exported_at: checkpoint?.exported_at || new Date().toISOString(),
      updated_at: new Date().toISOString(),
      range: {from: options.fromDate?.toISOString() || null, to: options.toDate?.toISOString() || null},
      formats,
      media_types: options.mediaTypes,
      max_media_bytes: options.maxMediaBytes,
      message_count: messageCount,
      total_count: total,
      history_peer_id: scheduled ? undefined : historyPeerId,
      next_offset_id: scheduled ? null : nextOffsetId,
      next_scheduled_index: scheduled ? nextScheduledIndex : null,
      next_scheduled_mid: scheduled && nextScheduledIndex !== null ?
        scheduledMids?.[nextScheduledIndex] ?? null :
        null,
      parts,
      media_files: Array.from(completedMedia.values()),
      failed_media: Array.from(failedMedia.values()),
      active_files: Array.from(activeFiles.values()),
      last_item: lastItem
    };
    const serialized = JSON.stringify(checkpointData, null, 2);
    const write = checkpointWritePromise.then(async() => {
      await writeFile(exportDirectory, 'export_metadata.json.tmp', serialized, 'application/json');
      await writeFile(exportDirectory, 'export_metadata.json.bak', serialized, 'application/json');
      await writeFile(exportDirectory, 'export_metadata.json', serialized, 'application/json');
      await removeCheckpointTemp();
    });
    checkpointWritePromise = write.catch(() => undefined);
    return write;
  };

  const scheduledMids = scheduled ?
    await (async() => {
      const result = await waitForAbortable(Promise.resolve(rootScope.managers.appMessagesManager.getScheduledMessages(peerId)), signal);
      if(!Array.isArray(result)) throw new Error('SCHEDULED_HISTORY_UNAVAILABLE');
      return result.slice().reverse();
    })() :
    undefined;
  if(scheduledMids) total = scheduledMids.length;
  if(scheduled && canResume && checkpoint.next_scheduled_mid !== undefined) {
    const nextMidIndex = scheduledMids!.indexOf(checkpoint.next_scheduled_mid);
    if(nextMidIndex >= 0) scheduledIndex = nextMidIndex;
  }

  await writeCheckpoint('exporting', scheduled ? null : offsetId, exportedCount, scheduled ? scheduledIndex : null);

  const advanceHistory = async(rawMessagesLength: number, lastRawId?: number) => {
    if(scheduled) {
      scheduledIndex += rawMessagesLength;
      await writeCheckpoint('exporting', null, exportedCount, scheduledIndex);
      return scheduledIndex < (scheduledMids?.length || 0);
    }

    if(lastRawId === undefined || lastRawId === 0) {
      throw new Error('EXPORT_HISTORY_CURSOR_MISSING');
    }
    if(lastRawId === offsetId || visitedOffsets.has(lastRawId)) {
      await writeCheckpoint('exporting', lastRawId);
      throw new Error(`EXPORT_HISTORY_STALLED_${lastRawId}`);
    }
    visitedOffsets.add(lastRawId);
    await writeCheckpoint('exporting', lastRawId);
    offsetId = lastRawId;
    return true;
  };

  while(true) {
    if(isCancelled(signal)) throw new DOMException('Export cancelled', 'AbortError');

    let rawMessages: MyMessage[];
    let lastRawId: number | undefined;
    let rawPageLength = 0;
    if(scheduled) {
      const mids = scheduledMids!.slice(scheduledIndex, scheduledIndex + PAGE_SIZE);
      if(!mids.length) break;
      rawPageLength = mids.length;
      rawMessages = await Promise.all(mids.map(async(mid) => {
        const message = await waitForAbortable(
          Promise.resolve(rootScope.managers.appMessagesManager.getScheduledMessageByPeer(peerId, mid)),
          signal
        );
        if(!message) throw new Error(`SCHEDULED_MESSAGE_MISSING_${mid}`);
        return message as MyMessage;
      }));
    } else {
      const historyType = await rootScope.managers.appMessagesManager.getHistoryType(historyPeerId, threadId);
      const result = await requestExportHistory({
        peerId: historyPeerId,
        threadId,
        offsetId,
        limit: PAGE_SIZE,
        minDate: options.fromDate?.getTime(),
        maxDate: options.toDate?.getTime(),
        historyType,
        allowRestricted: true
      }, signal, (seconds) => {
        reportProgress({loaded: exportedCount, total, current: `Telegram 限流，等待 ${seconds} 秒`, phase: 'history'});
      });

      const raw = (result.messages || []) as Array<MyMessage & {id?: number, mid?: number, _?: string}>;
      rawPageLength = raw.length;
      if(!options.fromDate && !options.toDate && !hasMigratedHistory && 'count' in result && result.count !== undefined) {
        total = Math.max(result.count || 0, exportedCount);
      }
      if(!raw.length) {
        const previousPeerId = !threadId ?
          (await rootScope.managers.appMessagesManager.getMigration(historyPeerId))?.prev :
          undefined;
        if(previousPeerId !== undefined && previousPeerId !== historyPeerId) {
          historyPeerId = previousPeerId;
          offsetId = 0;
          visitedOffsets.clear();
          hasMigratedHistory = true;
          total = undefined;
          await writeCheckpoint('exporting', offsetId);
          continue;
        }
        break;
      }
      const lastRaw = raw[raw.length - 1];
      lastRawId = lastRaw?.mid ?? lastRaw?.id;
      if(lastRawId === undefined) throw new Error('EXPORT_HISTORY_CURSOR_MISSING');
      rawMessages = raw.filter((message): message is MyMessage =>
        !!message && (message._ === 'message' || message._ === 'messageService')
      );
      if(!rawMessages.length) {
        await advanceHistory(rawPageLength, lastRawId);
        continue;
      }
    }

    const page = rawMessages.filter((message) => {
      const timestamp = message.date * 1000;
      return (!options.fromDate || timestamp >= options.fromDate.getTime()) &&
        (!options.toDate || timestamp <= options.toDate.getTime());
    });
    if(!page.length) {
      const reachedFromDate = options.fromDate && rawMessages.every((message) => message.date * 1000 < options.fromDate!.getTime());
      if(reachedFromDate) break;
      if(!await advanceHistory(rawPageLength, lastRawId)) break;
      continue;
    }

    const dates = page.map((message) => message.date);
    const fallbackDate = Math.floor(Date.now() / 1000);
    const firstDate = dates.length ? Math.min(...dates) : fallbackDate;
    const lastDate = dates.length ? Math.max(...dates) : fallbackDate;
    const partName = `messages-${formatExportDate(firstDate)}_to_${formatExportDate(lastDate)}-${('0000' + ++partNumber).slice(-4)}`;
    const pageStartExportedCount = exportedCount;
    let pageHadFailures = false;
    let pageFailureError: unknown;
    let jsonWriter: ExportWritable | undefined;
    let htmlWriter: ExportWritable | undefined;
    let jsonClosed = false;
    let htmlClosed = false;
    const closeWriters = async() => {
      if(jsonWriter && !jsonClosed) {
        await jsonWriter.close();
        jsonClosed = true;
      }
      if(htmlWriter && !htmlClosed) {
        await htmlWriter.close();
        htmlClosed = true;
      }
    };
    const cleanupWriters = async() => {
      const writers: Array<[ExportWritable | undefined, boolean]> = [[jsonWriter, jsonClosed], [htmlWriter, htmlClosed]];
      for(const [writer, closed] of writers) {
        if(!writer || closed) continue;
        try {
          await writer.close();
        } catch(error) {
          console.error('[ChatExport] failed to close page writer during cleanup', error);
        }
      }
      for(const format of formats) {
        try {
          await exportDirectory.removeEntry?.(`${partName}.${format}`);
        } catch(error) {
          if(!(error instanceof DOMException && error.name === 'NotFoundError')) throw error;
        }
      }
    };

    try {
      if(formats.includes('json')) jsonWriter = await createWriter(exportDirectory, `${partName}.json`);
      if(formats.includes('html')) htmlWriter = await createWriter(exportDirectory, `${partName}.html`);
      let jsonFirst = true;
      let partCount = 0;
      if(jsonWriter) await jsonWriter.write('[');
      if(htmlWriter) await htmlWriter.write(`<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHTML(options.title)}</title><style>html,body{margin:0;padding:0;background:#fff;color:#222;font:14px Arial,sans-serif}.page_wrap{min-height:100vh}.page_header{padding:18px 24px;background:#517da2;color:#fff}.page_header .text{font-size:20px;font-weight:600}.page_body{max-width:980px;margin:0 auto;padding:24px}.message{position:relative;display:flex;gap:12px;padding:10px 0;border-bottom:1px solid #e6e6e6}.body{min-width:0;flex:1}.date{float:right;max-width:100%;margin-left:12px;color:#999;font-size:12px;white-space:nowrap}.from_name{margin-bottom:5px;color:#517da2;font-weight:600}.text{white-space:normal;overflow-wrap:anywhere;line-height:1.45}.media_wrap{margin:6px 0}.media_photo{display:block;max-width:min(100%,640px);max-height:640px;border-radius:4px}.media_wrap video{display:block;max-width:min(100%,640px);max-height:640px}.media_wrap audio{max-width:min(100%,640px)}.media_wrap a{color:#517da2;text-decoration:none}.details{color:#999}</style></head><body><div class="page_wrap"><div class="page_header"><div class="content"><div class="text bold">${escapeHTML(options.title)}</div></div></div><div class="page_body chat_page"><div class="history">`);

      const processed = new Array<{exported: ExportedMessage, itemFailed: boolean, mediaPath?: string}>(page.length);
      const pageAbortController = new AbortController();
      const abortPage = () => pageAbortController.abort();
      signal?.addEventListener('abort', abortPage, {once: true});
      const pageSignal = pageAbortController.signal;
      let nextMessageIndex = 0;
      const processMessage = async(message: MyMessage, index: number) => {
        if(isCancelled(pageSignal)) throw new DOMException('Export cancelled', 'AbortError');
        const exported = await normalizeMessage(message);
        const timestamp = message.date * 1000;
        const messageTime = new Date(timestamp).toLocaleString();
        reportProgress({loaded: exportedCount, total, current: messageTime, phase: 'history'});
        const mediaType = getMediaType(message);
        let itemFailed = false;
        let mediaPath: string | undefined;
        const innerMedia = getMediaFromMessage(message, true) as unknown;
        if(mediaType && options.mediaTypes.includes(mediaType)) {
          if(!isExportableMedia(innerMedia)) {
            exported.media = {...exported.media, type: mediaType, error: 'MEDIA_UNAVAILABLE'};
          } else {
            const media = innerMedia;
            const mediaSize = getMediaSize(media);
            const metadata = getMediaMetadata(media);
            if(mediaSize !== undefined && mediaSize > options.maxMediaBytes) {
              exported.media = {
                ...exported.media,
                type: mediaType,
                ...metadata,
                error: 'MEDIA_SIZE_LIMIT'
              };
              console.info('[ChatExport] media skipped by size policy', {peerId, mid: message.mid, mediaType, mediaSize, maxMediaBytes: options.maxMediaBytes});
            } else {
              const mediaDirectoryName = mediaType === 'photos' ? 'photos' : mediaType === 'videos' || mediaType === 'video_notes' || mediaType === 'animated_gif' ? 'video_files' : 'files';
              const mediaDirectory = await exportDirectory.getDirectoryHandle(mediaDirectoryName, {create: true});
              const extension = getMediaExtension(media);
              const fileName = `${message.mid}.${extension}`;
              mediaPath = `${mediaDirectoryName}/${fileName}`;
              const identity = getMediaIdentity(media);
              reportProgress({loaded: exportedCount, total, current: `${fileName} (${formatMediaSize(mediaSize)})`, phase: 'history'});
              try {
                const existingHandle = await mediaDirectory.getFileHandle(fileName, {create: true});
                const existingFile = await existingHandle.getFile?.();
                const existingSize = existingFile?.size || 0;
                const completed = completedMedia.get(mediaPath);
                const isComplete = !!completed &&
                  completed.identity === identity &&
                  completed.size !== undefined &&
                  completed.size === existingSize &&
                  (completed.modified_at === undefined || completed.modified_at === existingFile?.lastModified) &&
                  (mediaSize === undefined || existingSize === mediaSize);
                const isInterruptedResumeItem = resumeItemGuard?.message_id === message.mid;
                const reuseMedia = isComplete && !failedMedia.has(mediaPath) && !isInterruptedResumeItem;
                if(!reuseMedia) {
                  const hasResumeState = failedMedia.has(mediaPath) ||
                    activeFiles.get(mediaPath)?.identity === identity;
                  const failedIdentityMatches = failedMedia.get(mediaPath)?.identity === identity;
                  const resumeExisting = hasResumeState &&
                    (failedIdentityMatches || activeFiles.get(mediaPath)?.identity === identity) &&
                    (mediaSize === undefined || existingSize < mediaSize);
                  activeFiles.set(mediaPath, {
                    path: mediaPath,
                    message_id: message.mid,
                    size: mediaSize,
                    identity,
                    downloaded: resumeExisting ? existingSize : 0,
                    status: 'downloading'
                  });
                  const actualSize = await downloadMediaToFile(
                    media,
                    mediaDirectory,
                    fileName,
                    mediaSize,
                    (downloaded) => {
                      const current = activeFiles.get(mediaPath!);
                      if(current) current.downloaded = downloaded;
                      reportProgress({loaded: exportedCount, total, current: fileName, phase: 'history'});
                    },
                    pageSignal,
                    options.maxMediaBytes,
                    resumeExisting
                  );
                  const completedFile = await existingHandle.getFile?.();
                  completedMedia.set(mediaPath, {
                    path: mediaPath,
                    size: actualSize,
                    identity,
                    modified_at: completedFile?.lastModified
                  });
                  failedMedia.delete(mediaPath);
                  activeFiles.delete(mediaPath);
                  exported.media = {type: mediaType, fileName: mediaPath, ...metadata, size: actualSize};
                  reportProgress({loaded: exportedCount, total, current: fileName, phase: 'history'});
                } else {
                  activeFiles.delete(mediaPath);
                  exported.media = {type: mediaType, fileName: mediaPath, ...metadata, size: existingSize};
                  reportProgress({loaded: exportedCount, total, current: fileName, phase: 'history'});
                }
              } catch(error) {
                if(isCancelled(pageSignal)) throw error;
                const failedHandle = await mediaDirectory.getFileHandle(fileName, {create: true});
                const failedFile = await failedHandle.getFile?.();
                if(failedFile?.size === 0 && mediaDirectory.removeEntry) {
                  await mediaDirectory.removeEntry(fileName);
                }
                const sizeLimit = error instanceof Error && /SIZE_LIMIT/.test(error.message);
                if(sizeLimit) {
                  activeFiles.delete(mediaPath);
                  try {
                    await mediaDirectory.removeEntry?.(fileName);
                  } catch(removeError) {
                    if(!(removeError instanceof DOMException && removeError.name === 'NotFoundError')) {
                      console.warn('[ChatExport] failed to remove media rejected by size limit', removeError);
                    }
                  }
                  reportProgress({loaded: exportedCount, total, current: fileName, phase: 'history'});
                  exported.media = {type: mediaType, ...metadata, error: 'MEDIA_SIZE_LIMIT'};
                } else {
                  pageHadFailures = true;
                  pageFailureError = error;
                  itemFailed = true;
                  activeFiles.delete(mediaPath);
                  failedMedia.set(mediaPath, {path: mediaPath, message_id: message.mid, size: mediaSize, identity});
                  exported.media = {type: mediaType, ...metadata, error: 'MEDIA_DOWNLOAD_FAILED'};
                  reportProgress({loaded: exportedCount, total, current: fileName, phase: 'history'});
                  console.warn('[ChatExport] media download failed; retrying page', {peerId, mid: message.mid, mediaType, error});
                }
              }
            }
          }
        }
        processed[index] = {exported, itemFailed, mediaPath};
        if(resumeItemGuard?.message_id === message.mid) resumeItemGuard = undefined;
      };
      const workers = Array.from({length: Math.min(MEDIA_DOWNLOAD_CONCURRENCY, page.length)}, async() => {
        while(nextMessageIndex < page.length) {
          const index = nextMessageIndex++;
          await processMessage(page[index], index);
        }
      });
      try {
        await Promise.all(workers);
      } catch(error) {
        pageAbortController.abort();
        await Promise.allSettled(workers);
        throw error;
      } finally {
        signal?.removeEventListener('abort', abortPage);
      }
      if(isCancelled(signal)) throw new DOMException('Export cancelled', 'AbortError');

      for(const result of processed) {
        if(isCancelled(signal)) throw new DOMException('Export cancelled', 'AbortError');
        if(!result) throw new Error('EXPORT_MESSAGE_PROCESSING_GAP');
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
          await jsonWriter.write(`${jsonFirst ? '' : ',\\n'}${JSON.stringify(exported)}`);
          jsonFirst = false;
        }
        if(htmlWriter) await htmlWriter.write(makeHTMLMessage(exported));
        ++exportedCount;
        ++partCount;
      }

      if(jsonWriter) await jsonWriter.write(']');
      if(htmlWriter) await htmlWriter.write('</div></div></div></body></html>');
      await closeWriters();
      if(isCancelled(signal)) throw new DOMException('Export cancelled', 'AbortError');
      if(!pageHadFailures) {
        if(jsonWriter) parts.push({path: `${partName}.json`, format: 'json', message_count: partCount});
        if(htmlWriter) parts.push({path: `${partName}.html`, format: 'html', message_count: partCount});
      }
    } catch(error) {
      try {
        await cleanupWriters();
      } catch(cleanupError) {
        console.error('[ChatExport] failed to clean up export page after error', cleanupError);
      }
      throw error;
    }

    if(pageHadFailures) {
      await cleanupWriters();
      exportedCount = pageStartExportedCount;
      const pageKey = scheduled ? scheduledIndex : offsetId;
      const attempts = (pageAttempts.get(pageKey) || 0) + 1;
      pageAttempts.set(pageKey, attempts);
      await writeCheckpoint('exporting', scheduled ? null : offsetId, exportedCount, scheduled ? scheduledIndex : null);
      if(attempts >= MEDIA_PAGE_RETRIES) {
        const reason = pageFailureError instanceof Error ? pageFailureError.message : String(pageFailureError);
        throw new Error(`MEDIA_PAGE_FAILED_AFTER_${attempts}_ATTEMPTS: ${reason}`);
      }
      continue;
    }

    if(isCancelled(signal)) throw new DOMException('Export cancelled', 'AbortError');
    pageAttempts.delete(scheduled ? scheduledIndex : offsetId);
    reportProgress({loaded: exportedCount, total, phase: 'history'});
    const hasMoreHistory = await advanceHistory(rawPageLength, lastRawId);
    completedMedia.clear();
    failedMedia.clear();
    if(!hasMoreHistory) break;
  }

  reportProgress({loaded: exportedCount, total: total || exportedCount, phase: 'writing'});
  total = Math.max(total || 0, exportedCount);
  await writeCheckpoint('completed', null, exportedCount, null);
  reportProgress({loaded: exportedCount, total, phase: 'completed'});
}

export async function getExportTitle(peerId: PeerId) {
  return getPeerTitle({peerId, plainText: true});
}
