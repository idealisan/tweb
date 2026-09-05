import {Document, InputFileLocation, Photo, PhotoSize} from '../../layer';
import rootScope from '../rootScope';
import getDocumentDownloadOptions from '../appManagers/utils/docs/getDocumentDownloadOptions';
import getPhotoDownloadOptions from '../appManagers/utils/photos/getPhotoDownloadOptions';

const MIN_PART_SIZE = 64 * 1024;
const AVG_PART_SIZE = 512 * 1024;
const MAX_PART_SIZE = 1024 * 1024;
const DEFAULT_MAX_DOWNLOAD_PARTS = 8000;
const REGULAR_DOWNLOAD_DELTA = (9 * AVG_PART_SIZE) / MIN_PART_SIZE;
const PREMIUM_DOWNLOAD_DELTA = (56 * AVG_PART_SIZE) / MIN_PART_SIZE;

type DownloadTask = {
  activeDelta: number;
  run: () => Promise<Uint8Array | undefined>;
  resolve: (bytes: Uint8Array | undefined) => void;
  reject: (error: unknown) => void;
};

const downloadQueues = new Map<string, DownloadTask[]>();
const downloadActives = new Map<string, number>();
let maxDownloadParts = DEFAULT_MAX_DOWNLOAD_PARTS;

rootScope.addEventListener('app_config', (config) => {
  maxDownloadParts = config.upload_max_fileparts_premium || DEFAULT_MAX_DOWNLOAD_PARTS;
});

const getDownloadLimit = () => rootScope.premium ? PREMIUM_DOWNLOAD_DELTA : REGULAR_DOWNLOAD_DELTA;

const getPartSize = (size: number) => {
  if(!size) return AVG_PART_SIZE;

  let partSize = MIN_PART_SIZE;
  while(size / partSize > maxDownloadParts && partSize < MAX_PART_SIZE) {
    partSize *= 2;
  }
  return partSize;
};

const pumpDownloadQueue = (dcId: number) => {
  const key = String(dcId);
  const queue = downloadQueues.get(key);
  if(!queue?.length) return;

  const active = downloadActives.get(key) || 0;
  const index = queue.findIndex((task) => active + task.activeDelta <= getDownloadLimit());
  if(index === -1) return;

  const task = queue.splice(index, 1)[0];
  downloadActives.set(key, active + task.activeDelta);
  void task.run().then(task.resolve, task.reject).finally(() => {
    downloadActives.set(key, (downloadActives.get(key) || 0) - task.activeDelta);
    pumpDownloadQueue(dcId);
  });
  pumpDownloadQueue(dcId);
};

const scheduleDownloadPart = (dcId: number, partSize: number, run: DownloadTask['run']) => new Promise<Uint8Array | undefined>((resolve, reject) => {
  const key = String(dcId);
  const queue = downloadQueues.get(key) || [];
  queue.push({
    activeDelta: partSize / MIN_PART_SIZE,
    run,
    resolve,
    reject
  });
  downloadQueues.set(key, queue);
  pumpDownloadQueue(dcId);
});

type DownloadableMedia = Photo.photo | Document.document;
type PartCallback = (bytes: Uint8Array, offset: number) => Promise<void>;
type ProgressCallback = (downloaded: number, total?: number) => void;

const getFloodWaitSeconds = (error: unknown) => {
  const type = typeof error === 'object' && error && 'type' in error ? String(error.type) : '';
  const message = error instanceof Error ? error.message : '';
  const match = `${type} ${message}`.match(/FLOOD_WAIT[_ ](\d+)/i);
  return match ? Number(match[1]) : undefined;
};

const waitForFloodWait = (seconds: number) => new Promise<void>((resolve) => {
  window.setTimeout(resolve, seconds * 1000);
});

export async function downloadMediaParts(
  media: DownloadableMedia,
  thumb: PhotoSize | undefined,
  onPart: PartCallback,
  onProgress?: ProgressCallback,
  startOffset = 0
): Promise<number> {
  const source = media._ === 'document' ?
    await rootScope.managers.appDocsManager.getDoc(media.id) || media :
    await rootScope.managers.appPhotosManager.getPhoto(media.id) || media;
  const options = source._ === 'document' ?
    getDocumentDownloadOptions(source, undefined) :
    getPhotoDownloadOptions(source, thumb);
  const size = options.size || 0;
  const partSize = getPartSize(size);
  let offset = startOffset;
  onProgress?.(offset, size || undefined);

  const requestPart = async(partOffset: number): Promise<Uint8Array | undefined> => {
    while(true) {
      try {
        const bytes = await scheduleDownloadPart(options.dcId, partSize, async() => {
          const result = await rootScope.managers.apiManager.invokeApi('upload.getFile', {
            location: options.location as InputFileLocation,
            offset: partOffset,
            limit: partSize
          }, {
            dcId: options.dcId,
            fileDownload: true
          });
          return 'bytes' in result ? result.bytes as Uint8Array : undefined;
        });
        return bytes?.byteLength ? bytes : undefined;
      } catch(error) {
        const seconds = getFloodWaitSeconds(error);
        if(seconds === undefined) throw error;
        console.info(`[ChatExport] Telegram rate limit for media part; waiting ${seconds}s`);
        await waitForFloodWait(seconds);
      }
    }
  };

  if(size) {
    const offsets: number[] = [];
    for(let partOffset = startOffset; partOffset < size; partOffset += partSize) {
      offsets.push(partOffset);
    }

    const parts = new Map<number, Uint8Array>();
    let downloadedPartsBytes = 0;
    await Promise.all(offsets.map(async(partOffset) => {
      const bytes = await requestPart(partOffset);
      if(!bytes) throw new Error(`MEDIA_DOWNLOAD_EMPTY_PART_${partOffset}`);
      parts.set(partOffset, bytes);
      downloadedPartsBytes += bytes.byteLength;
      onProgress?.(startOffset + downloadedPartsBytes, size);
    }));

    for(const partOffset of offsets) {
      const bytes = parts.get(partOffset);
      if(!bytes) throw new Error(`MEDIA_DOWNLOAD_MISSING_PART_${partOffset}`);
      await onPart(bytes, partOffset);
      offset = partOffset + bytes.byteLength;
    }
  } else {
    while(true) {
      const bytes = await requestPart(offset);
      if(!bytes) break;
      await onPart(bytes, offset);
      offset += bytes.byteLength;
      onProgress?.(offset, undefined);
    }
  }

  return offset;
}
