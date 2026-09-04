import {Document, InputFileLocation, Photo, PhotoSize} from '../../layer';
import rootScope from '../rootScope';
import getDocumentDownloadOptions from '../appManagers/utils/docs/getDocumentDownloadOptions';
import getPhotoDownloadOptions from '../appManagers/utils/photos/getPhotoDownloadOptions';

const PART_SIZE = 512 * 1024;

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
) {
  const source = media._ === 'document' ?
    await rootScope.managers.appDocsManager.getDoc(media.id) || media :
    await rootScope.managers.appPhotosManager.getPhoto(media.id) || media;
  const options = source._ === 'document' ?
    getDocumentDownloadOptions(source, undefined) :
    getPhotoDownloadOptions(source, thumb);
  const size = options.size || 0;
  let offset = startOffset;
  onProgress?.(offset, size || undefined);

  while(!size || offset < size) {
    let result;
    while(true) {
      try {
        result = await rootScope.managers.apiManager.invokeApi('upload.getFile', {
          location: options.location as InputFileLocation,
          offset,
          limit: PART_SIZE
        }, {
          dcId: options.dcId,
          fileDownload: true
        });
        break;
      } catch(error) {
        const seconds = getFloodWaitSeconds(error);
        if(seconds === undefined) throw error;
        console.info(`[ChatExport] Telegram rate limit for media part; waiting ${seconds}s`);
        await waitForFloodWait(seconds);
      }
    }
    const bytes = 'bytes' in result ? result.bytes as Uint8Array : undefined;
    if(!bytes?.byteLength) break;
    await onPart(bytes, offset);
    offset += bytes.byteLength;
    onProgress?.(offset, size || undefined);
  }
}
