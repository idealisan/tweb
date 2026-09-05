import {Document, InputFileLocation, Photo, PhotoSize} from '../../layer';
import rootScope from '../rootScope';
import getDocumentDownloadOptions from '../appManagers/utils/docs/getDocumentDownloadOptions';
import getPhotoDownloadOptions from '../appManagers/utils/photos/getPhotoDownloadOptions';

const PART_SIZE = 512 * 1024;
const PART_CONCURRENCY = 6;

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
  let offset = startOffset;
  onProgress?.(offset, size || undefined);

  const requestPart = async(partOffset: number): Promise<Uint8Array | undefined> => {
    while(true) {
      try {
        const result = await rootScope.managers.apiManager.invokeApi('upload.getFile', {
          location: options.location as InputFileLocation,
          offset: partOffset,
          limit: PART_SIZE
        }, {
          dcId: options.dcId,
          fileDownload: true
        });
        const bytes = 'bytes' in result ? result.bytes as Uint8Array : undefined;
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
    for(let partOffset = startOffset; partOffset < size; partOffset += PART_SIZE) {
      offsets.push(partOffset);
    }

    const parts = new Map<number, Uint8Array>();
    let nextPart = 0;
    const workers = Array.from({length: Math.min(PART_CONCURRENCY, offsets.length)}, async() => {
      while(nextPart < offsets.length) {
        const index = nextPart++;
        const partOffset = offsets[index];
        const bytes = await requestPart(partOffset);
        if(!bytes) throw new Error(`MEDIA_DOWNLOAD_EMPTY_PART_${partOffset}`);
        parts.set(partOffset, bytes);
      }
    });
    await Promise.all(workers);

    for(const partOffset of offsets) {
      const bytes = parts.get(partOffset);
      if(!bytes) throw new Error(`MEDIA_DOWNLOAD_MISSING_PART_${partOffset}`);
      await onPart(bytes, partOffset);
      offset = partOffset + bytes.byteLength;
      onProgress?.(offset, size);
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
