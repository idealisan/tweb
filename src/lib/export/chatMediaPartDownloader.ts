import {Document, InputFileLocation, Photo, PhotoSize} from '../../layer';
import rootScope from '../rootScope';
import getDocumentDownloadOptions from '../appManagers/utils/docs/getDocumentDownloadOptions';
import getPhotoDownloadOptions from '../appManagers/utils/photos/getPhotoDownloadOptions';

const PART_SIZE = 512 * 1024;

type DownloadableMedia = Photo.photo | Document.document;
type PartCallback = (bytes: Uint8Array, offset: number) => Promise<void>;

export async function downloadMediaParts(
  media: DownloadableMedia,
  thumb: PhotoSize | undefined,
  onPart: PartCallback
) {
  const source = media._ === 'document' ?
    await rootScope.managers.appDocsManager.getDoc(media.id) || media :
    await rootScope.managers.appPhotosManager.getPhoto(media.id) || media;
  const options = source._ === 'document' ?
    getDocumentDownloadOptions(source, undefined) :
    getPhotoDownloadOptions(source, thumb);
  const size = options.size || 0;
  let offset = 0;

  while(!size || offset < size) {
    const result = await rootScope.managers.apiManager.invokeApi('upload.getFile', {
      location: options.location as InputFileLocation,
      offset,
      limit: PART_SIZE
    }, {
      dcId: options.dcId,
      fileDownload: true
    });
    const bytes = 'bytes' in result ? result.bytes as Uint8Array : undefined;
    if(!bytes?.byteLength) break;
    await onPart(bytes, offset);
    offset += bytes.byteLength;
  }
}
