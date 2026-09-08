import {Document, InputFileLocation, Photo, PhotoSize, UploadCdnFile, UploadFile} from '../../layer';
import rootScope from '../rootScope';
import getDocumentDownloadOptions from '../appManagers/utils/docs/getDocumentDownloadOptions';
import getPhotoDownloadOptions from '../appManagers/utils/photos/getPhotoDownloadOptions';

const MIN_PART_SIZE = 64 * 1024;
const AVG_PART_SIZE = 512 * 1024;
const MAX_PART_SIZE = 1024 * 1024;
const FILE_PART_CONCURRENCY = 8;
const DEFAULT_MAX_DOWNLOAD_PARTS = 8000;
const REGULAR_DOWNLOAD_DELTA = (9 * AVG_PART_SIZE) / MIN_PART_SIZE;
const PREMIUM_DOWNLOAD_DELTA = (56 * AVG_PART_SIZE) / MIN_PART_SIZE;

type DownloadTask = {
  activeDelta: number;
  run: () => Promise<any>;
  resolve: (value: any) => void;
  reject: (error: unknown) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
};

const downloadQueues = new Map<string, DownloadTask[]>();
const downloadActives = new Map<string, number>();
let maxDownloadParts = DEFAULT_MAX_DOWNLOAD_PARTS;

rootScope.addEventListener('app_config', (config) => {
  maxDownloadParts = config.upload_max_fileparts_premium || DEFAULT_MAX_DOWNLOAD_PARTS;
});

const getDownloadLimit = () => rootScope.premium ? PREMIUM_DOWNLOAD_DELTA : REGULAR_DOWNLOAD_DELTA;

const createAbortError = () => new DOMException('Export cancelled', 'AbortError');

const throwIfAborted = (signal?: AbortSignal) => {
  if(signal?.aborted) {
    throw createAbortError();
  }
};

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

  while(queue.length) {
    const active = downloadActives.get(key) || 0;
    const index = queue.findIndex((task) => !task.signal?.aborted && active + task.activeDelta <= getDownloadLimit());
    if(index === -1) {
      for(let i = queue.length - 1; i >= 0; i--) {
        if(!queue[i].signal?.aborted) continue;
        const [cancelled] = queue.splice(i, 1);
        cancelled.onAbort = undefined;
        cancelled.reject(createAbortError());
      }
      if(!queue.length) {
        downloadQueues.delete(key);
      }
      return;
    }

    const task = queue.splice(index, 1)[0];
    task.signal?.removeEventListener('abort', task.onAbort!);
    task.onAbort = undefined;
    downloadActives.set(key, active + task.activeDelta);
    void task.run().then(task.resolve, task.reject).finally(() => {
      downloadActives.set(key, Math.max(0, (downloadActives.get(key) || 0) - task.activeDelta));
      pumpDownloadQueue(dcId);
    });
  }
};

const scheduleDownloadPart = <T>(dcId: number, partSize: number, run: () => Promise<T>, signal?: AbortSignal) => new Promise<T>((resolve, reject) => {
  throwIfAborted(signal);
  const key = String(dcId);
  const queue = downloadQueues.get(key) || [];
  const task: DownloadTask = {
    activeDelta: partSize / MIN_PART_SIZE,
    run,
    resolve,
    reject,
    signal
  };
  task.onAbort = () => {
    const queued = downloadQueues.get(key);
    const index = queued?.indexOf(task) ?? -1;
    if(index === -1) return;
    queued.splice(index, 1);
    if(!queued.length) downloadQueues.delete(key);
    reject(createAbortError());
    pumpDownloadQueue(dcId);
  };
  signal?.addEventListener('abort', task.onAbort, {once: true});
  queue.push(task);
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

const waitForFloodWait = (seconds: number, signal?: AbortSignal) => new Promise<void>((resolve, reject) => {
  throwIfAborted(signal);
  const timer = window.setTimeout(() => {
    signal?.removeEventListener('abort', onAbort);
    resolve();
  }, seconds * 1000);
  const onAbort = () => {
    window.clearTimeout(timer);
    reject(createAbortError());
  };
  signal?.addEventListener('abort', onAbort, {once: true});
});

const withTimeout = <T>(
  factory: () => Promise<T>,
  timeout: number,
  signal?: AbortSignal,
  onTimeout?: () => void
) => new Promise<T>((resolve, reject) => {
  throwIfAborted(signal);
  let settled = false;
  const timer = window.setTimeout(() => {
    if(settled) return;
    settled = true;
    onTimeout?.();
    signal?.removeEventListener('abort', onAbort);
    reject(new Error(`MEDIA_DOWNLOAD_TIMEOUT_${timeout}`));
  }, timeout);
  const onAbort = () => {
    if(settled) return;
    settled = true;
    window.clearTimeout(timer);
    reject(createAbortError());
  };
  signal?.addEventListener('abort', onAbort, {once: true});
  Promise.resolve().then(factory).then((value) => {
    if(settled) return;
    settled = true;
    window.clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
    resolve(value);
  }, (error) => {
    if(settled) return;
    settled = true;
    window.clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
    reject(error);
  });
});

const incrementCounter = (value: Uint8Array, blocks: number) => {
  const counter = value.slice();
  let carry = blocks;
  for(let i = counter.length - 1; i >= 0 && carry > 0; i--) {
    const next = counter[i] + (carry % 256);
    counter[i] = next & 0xff;
    carry = Math.floor(carry / 256) + Math.floor(next / 256);
  }
  return counter;
};

const decryptCdnBytes = async(
  redirect: UploadFile.uploadFileCdnRedirect,
  encrypted: Uint8Array,
  offset: number
) => {
  if(offset % 16) {
    throw new Error(`MEDIA_CDN_OFFSET_UNALIGNED_${offset}`);
  }
  const key = await crypto.subtle.importKey('raw', redirect.encryption_key, {name: 'AES-CTR'}, false, ['decrypt']);
  const decrypted = await crypto.subtle.decrypt({
    name: 'AES-CTR',
    counter: incrementCounter(redirect.encryption_iv, offset / 16),
    length: 128
  }, key, encrypted);
  return new Uint8Array(decrypted);
};

const bytesEqual = (left: Uint8Array, right: Uint8Array) =>
  left.length === right.length && left.every((byte, index) => byte === right[index]);

const getCdnPart = async(
  redirect: UploadFile.uploadFileCdnRedirect,
  offset: number,
  limit: number,
  signal?: AbortSignal
) => {
  throwIfAborted(signal);
  let result = await rootScope.managers.apiManager.invokeApi('upload.getCdnFile', {
    file_token: redirect.file_token,
    offset,
    limit
  }, {
    dcId: redirect.dc_id,
    fileDownload: true
  }) as UploadCdnFile;
  throwIfAborted(signal);

  if(result._ === 'upload.cdnFileReuploadNeeded') {
    redirect.file_hashes = await rootScope.managers.apiManager.invokeApi('upload.reuploadCdnFile', {
      file_token: redirect.file_token,
      request_token: result.request_token
    }, {
      dcId: redirect.dc_id,
      fileDownload: true
    });
    throwIfAborted(signal);
    result = await rootScope.managers.apiManager.invokeApi('upload.getCdnFile', {
      file_token: redirect.file_token,
      offset,
      limit
    }, {
      dcId: redirect.dc_id,
      fileDownload: true
    }) as UploadCdnFile;
    throwIfAborted(signal);
  }

  if(result._ !== 'upload.cdnFile') {
    throw new Error('MEDIA_CDN_FILE_UNAVAILABLE');
  }

  const bytes = await decryptCdnBytes(redirect, result.bytes, offset);
  for(const fileHash of redirect.file_hashes || []) {
    const hashOffset = Number(fileHash.offset);
    const hashLimit = Number(fileHash.limit);
    const relativeOffset = hashOffset - offset;
    if(!Number.isFinite(hashOffset) || !Number.isFinite(hashLimit) || hashLimit <= 0 ||
      relativeOffset < 0 || relativeOffset + hashLimit > bytes.byteLength) {
      continue;
    }
    const digest = new Uint8Array(await crypto.subtle.digest(
      'SHA-256',
      bytes.slice(relativeOffset, relativeOffset + hashLimit)
    ));
    if(!bytesEqual(digest, fileHash.hash)) {
      throw new Error(`MEDIA_CDN_HASH_MISMATCH_${hashOffset}`);
    }
  }
  return bytes;
};

export async function downloadMediaParts(
  media: DownloadableMedia,
  thumb: PhotoSize | undefined,
  onPart: PartCallback,
  onProgress?: ProgressCallback,
  startOffset = 0,
  signal?: AbortSignal,
  maxBytes?: number
): Promise<number> {
  throwIfAborted(signal);
  const source = media._ === 'document' ?
    await rootScope.managers.appDocsManager.getDoc(media.id) || media :
    await rootScope.managers.appPhotosManager.getPhoto(media.id) || media;
  if(!source || (source._ !== 'document' && source._ !== 'photo')) {
    throw new Error('MEDIA_SOURCE_UNAVAILABLE');
  }
  const options = source._ === 'document' ?
    getDocumentDownloadOptions(source, undefined) :
    getPhotoDownloadOptions(source, thumb);
  const size = typeof options.size === 'number' && options.size > 0 ? options.size : undefined;
  if(size !== undefined && maxBytes !== undefined && size > maxBytes) {
    throw new Error(`MEDIA_DOWNLOAD_SIZE_LIMIT_${maxBytes}`);
  }
  const partSize = getPartSize(size);
  const controller = new AbortController();
  const abortExternal = () => controller.abort();
  signal?.addEventListener('abort', abortExternal, {once: true});
  const downloadSignal = controller.signal;
  let offset = startOffset;
  onProgress?.(offset, size || undefined);

  const requestPart = async(partOffset: number, allowEmpty = false): Promise<Uint8Array | undefined> => {
    let attempts = 0;
    while(true) {
      throwIfAborted(downloadSignal);
      try {
        const requestController = new AbortController();
        const abortRequest = () => requestController.abort();
        downloadSignal.addEventListener('abort', abortRequest, {once: true});
        let result: UploadFile;
        try {
          result = await scheduleDownloadPart(options.dcId, partSize, () => withTimeout(
            () => rootScope.managers.apiFileManager.requestFilePart({
              dcId: options.dcId,
              location: options.location as InputFileLocation,
              offset: partOffset,
              limit: partSize
            }) as Promise<UploadFile>,
            120000,
            downloadSignal,
            abortRequest
          ), downloadSignal);
        } finally {
          downloadSignal.removeEventListener('abort', abortRequest);
        }
        if(!result) throw new Error(`MEDIA_DOWNLOAD_EMPTY_PART_${partOffset}`);
        if(result._ === 'upload.fileCdnRedirect') {
          const cdnRedirect = result;
          const cdnController = new AbortController();
          const abortCdn = () => cdnController.abort();
          downloadSignal.addEventListener('abort', abortCdn, {once: true});
          let bytes: Uint8Array;
          try {
            bytes = await withTimeout(() => getCdnPart(cdnRedirect, partOffset, partSize, cdnController.signal), 120000, downloadSignal, abortCdn);
          } finally {
            downloadSignal.removeEventListener('abort', abortCdn);
          }
          if(!bytes.byteLength) {
            if(allowEmpty) return;
            throw new Error(`MEDIA_DOWNLOAD_EMPTY_PART_${partOffset}`);
          }
          return bytes;
        }
        if(result._ !== 'upload.file') {
          throw new Error(`MEDIA_DOWNLOAD_EMPTY_PART_${partOffset}`);
        }
        if(!result.bytes?.byteLength) {
          if(allowEmpty) return;
          throw new Error(`MEDIA_DOWNLOAD_EMPTY_PART_${partOffset}`);
        }
        return result.bytes;
      } catch(error) {
        throwIfAborted(downloadSignal);
        const seconds = getFloodWaitSeconds(error);
        if(seconds !== undefined) {
          console.info(`[ChatExport] Telegram rate limit for media part; waiting ${seconds}s`);
          await waitForFloodWait(seconds, downloadSignal);
          continue;
        }
        if(++attempts > 2) throw error;
        await waitForFloodWait(Math.min(2 ** attempts, 8), downloadSignal);
      }
    }
  };

  if(size) {
    const offsets: number[] = [];
    for(let partOffset = startOffset; partOffset < size; partOffset += partSize) {
      offsets.push(partOffset);
    }

    const parts = new Map<number, Uint8Array>();
    let nextWriteOffset = startOffset;
    let writePromise = Promise.resolve();
    let canWrite = true;
    const writeReadyParts = () => {
      writePromise = writePromise.then(async() => {
        if(!canWrite) return;
        while(parts.has(nextWriteOffset)) {
          const bytes = parts.get(nextWriteOffset);
          parts.delete(nextWriteOffset);
          if(!bytes) break;
          await onPart(bytes, nextWriteOffset);
          nextWriteOffset += bytes.byteLength;
          onProgress?.(nextWriteOffset, size);
        }
      });
      return writePromise;
    };

    try {
      const workerCount = Math.min(FILE_PART_CONCURRENCY, offsets.length);
      let nextPartIndex = 0;
      await Promise.all(Array.from({length: workerCount}, async() => {
        while(nextPartIndex < offsets.length) {
          throwIfAborted(controller.signal);
          const partOffset = offsets[nextPartIndex++];
          const bytes = await requestPart(partOffset);
          if(!bytes) throw new Error(`MEDIA_DOWNLOAD_EMPTY_PART_${partOffset}`);
          const expectedPartBytes = Math.min(partSize, size - partOffset);
          if(bytes.byteLength !== expectedPartBytes) {
            throw new Error(`MEDIA_DOWNLOAD_SHORT_PART_${partOffset}_${bytes.byteLength}_${expectedPartBytes}`);
          }
          parts.set(partOffset, bytes);
          await writeReadyParts();
        }
      }));
    } catch(error) {
      canWrite = false;
      controller.abort();
      await writePromise.catch(() => {});
      throw error;
    } finally {
      signal?.removeEventListener('abort', abortExternal);
    }
    await writePromise;
    if(nextWriteOffset !== size) throw new Error(`MEDIA_DOWNLOAD_MISSING_PART_${nextWriteOffset}`);
    offset = nextWriteOffset;
  } else {
    try {
      let emptyPartRetries = 0;
      while(true) {
        throwIfAborted(downloadSignal);
        const bytes = await requestPart(offset, offset !== 0);
        if(!bytes?.byteLength) {
          if(offset === startOffset) throw new Error('MEDIA_DOWNLOAD_EMPTY_FILE');
          if(emptyPartRetries++ < 1) continue;
          break;
        }
        emptyPartRetries = 0;
        if(maxBytes !== undefined && offset + bytes.byteLength > maxBytes) {
          throw new Error(`MEDIA_DOWNLOAD_SIZE_LIMIT_${maxBytes}`);
        }
        await onPart(bytes, offset);
        offset += bytes.byteLength;
        onProgress?.(offset, undefined);
      }
    } catch(error) {
      controller.abort();
      throw error;
    } finally {
      signal?.removeEventListener('abort', abortExternal);
    }
  }

  return offset;
}
