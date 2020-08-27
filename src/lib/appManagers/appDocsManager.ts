import {RichTextProcessor} from '../richtextprocessor';
import { CancellablePromise, deferredPromise } from '../polyfill';
import { isObject, getFileURL, FileURLType } from '../utils';
import opusDecodeController from '../opusDecodeController';
import { MTDocument, inputDocumentFileLocation, MTPhotoSize } from '../../types';
import { getFileNameByLocation } from '../bin_utils';
import appDownloadManager, { Download, ResponseMethod, DownloadBlob } from './appDownloadManager';
import appPhotosManager from './appPhotosManager';

class AppDocsManager {
  private docs: {[docID: string]: MTDocument} = {};
  private downloadPromises: {[docID: string]: CancellablePromise<Blob>} = {};
  
  public saveDoc(apiDoc: MTDocument, context?: any) {
    //console.log('saveDoc', apiDoc, this.docs[apiDoc.id]);
    if(this.docs[apiDoc.id]) {
      const d = this.docs[apiDoc.id];

      if(apiDoc.thumbs) {
        if(!d.thumbs) d.thumbs = apiDoc.thumbs;
        /* else if(apiDoc.thumbs[0].bytes && !d.thumbs[0].bytes) {
          d.thumbs.unshift(apiDoc.thumbs[0]);
        } else if(d.thumbs[0].url) { // fix for converted thumb in safari
          apiDoc.thumbs[0] = d.thumbs[0];
        } */
      }

      d.file_reference = apiDoc.file_reference;
      return d;

      //return Object.assign(d, apiDoc, context);
      //return context ? Object.assign(d, context) : d;
    }
    
    if(context) {
      Object.assign(apiDoc, context);
    }

    this.docs[apiDoc.id] = apiDoc;
    
    apiDoc.attributes.forEach((attribute: any) => {
      switch(attribute._) {
        case 'documentAttributeFilename':
          apiDoc.file_name = RichTextProcessor.wrapPlainText(attribute.file_name);
          break;

        case 'documentAttributeAudio':
          apiDoc.duration = attribute.duration;
          apiDoc.audioTitle = attribute.title;
          apiDoc.audioPerformer = attribute.performer;
          apiDoc.type = attribute.pFlags.voice && apiDoc.mime_type == "audio/ogg" ? 'voice' : 'audio';

          /* if(apiDoc.type == 'audio') {
            apiDoc.supportsStreaming = true;
          } */
          break;

        case 'documentAttributeVideo':
          apiDoc.duration = attribute.duration;
          apiDoc.w = attribute.w;
          apiDoc.h = attribute.h;
          //apiDoc.supportsStreaming = attribute.pFlags?.supports_streaming/*  && apiDoc.size > 524288 */;
          if(/* apiDoc.thumbs &&  */attribute.pFlags.round_message) {
            apiDoc.type = 'round';
          } else /* if(apiDoc.thumbs) */ {
            apiDoc.type = 'video';
          }
          break;

        case 'documentAttributeSticker':
          if(attribute.alt !== undefined) {
            apiDoc.stickerEmojiRaw = attribute.alt;
            apiDoc.stickerEmoji = RichTextProcessor.wrapRichText(apiDoc.stickerEmojiRaw, {noLinks: true, noLinebreaks: true});
          }

          if(attribute.stickerset) {
            if(attribute.stickerset._ == 'inputStickerSetEmpty') {
              delete attribute.stickerset;
            } else if(attribute.stickerset._ == 'inputStickerSetID') {
              apiDoc.stickerSetInput = attribute.stickerset;
            }
          }

          if(/* apiDoc.thumbs &&  */apiDoc.mime_type == 'image/webp') {
            apiDoc.type = 'sticker';
            apiDoc.sticker = 1;
          }
          break;

        case 'documentAttributeImageSize':
          apiDoc.w = attribute.w;
          apiDoc.h = attribute.h;
          break;

        case 'documentAttributeAnimated':
          if((apiDoc.mime_type == 'image/gif' || apiDoc.mime_type == 'video/mp4')/*  && apiDoc.thumbs */) {
            apiDoc.type = 'gif';
          }

          apiDoc.animated = true;
          break;
      }
    });
    
    if(!apiDoc.mime_type) {
      switch(apiDoc.type) {
        case 'gif':
        case 'video':
        case 'round':
          apiDoc.mime_type = 'video/mp4';
          break;
        case 'sticker':
          apiDoc.mime_type = 'image/webp';
          break;
        case 'audio':
          apiDoc.mime_type = 'audio/mpeg';
          break;
        case 'voice':
          apiDoc.mime_type = 'audio/ogg';
          break;
        default:
          apiDoc.mime_type = 'application/octet-stream';
          break;
      }
    }

    if((apiDoc.type == 'gif' && apiDoc.size > 8e6) || apiDoc.type == 'audio' || apiDoc.type == 'video') {
      apiDoc.supportsStreaming = true;
    }
    
    if(!apiDoc.file_name) {
      apiDoc.file_name = '';
    }

    if(apiDoc.mime_type == 'application/x-tgsticker' && apiDoc.file_name == "AnimatedSticker.tgs") {
      apiDoc.type = 'sticker';
      apiDoc.animated = true;
      apiDoc.sticker = 2;
    }
    
    if(apiDoc._ == 'documentEmpty') {
      apiDoc.size = 0;
    }

    if(!apiDoc.url) {
      apiDoc.url = this.getFileURL(apiDoc);
    }

    return apiDoc;
  }
  
  public getDoc(docID: string | MTDocument): MTDocument {
    return isObject(docID) && typeof(docID) !== 'string' ? docID : this.docs[docID as string];
  }

  public getMediaInput(doc: MTDocument) {
    return {
      _: 'inputMediaDocument',
      flags: 0,
      id: {
        _: 'inputDocument',
        id: doc.id,
        access_hash: doc.access_hash,
        file_reference: doc.file_reference
      },
      ttl_seconds: 0
    };
  }

  public getInput(doc: MTDocument, thumbSize?: string): inputDocumentFileLocation {
    return {
      _: 'inputDocumentFileLocation',
      id: doc.id,
      access_hash: doc.access_hash,
      file_reference: doc.file_reference,
      thumb_size: thumbSize
    };
  }

  public getFileURL(doc: MTDocument, download = false, thumb?: MTPhotoSize) {
    const inputFileLocation = this.getInput(doc, thumb?.type);

    let type: FileURLType;
    if(download) {
      type = 'download';
    } else if(thumb) {
      type = 'thumb';
    } else if(doc.supportsStreaming) {
      type = 'stream';
    } else {
      type = 'document';
    }

    let mimeType: string;
    if(thumb) {
      mimeType = doc.sticker ? 'image/webp' : 'image/jpeg'/* doc.mime_type */;
    } else {
      mimeType = doc.mime_type || 'application/octet-stream';
    }

    return getFileURL(type, {
      dcID: doc.dc_id, 
      location: inputFileLocation, 
      size: thumb ? thumb.size : doc.size, 
      mimeType: mimeType,
      fileName: doc.file_name
    });
  }

  public getThumbURL(doc: MTDocument, useBytes = true) {
    if(doc.thumbs?.length) {
      let thumb: MTPhotoSize;
      if(!useBytes) {
        thumb = doc.thumbs.find(t => !t.bytes);
      }
      
      if(!thumb) {
        thumb = doc.thumbs[0];
      }

      if(thumb.bytes) {
        return appPhotosManager.getPreviewURLFromBytes(doc.thumbs[0].bytes, !!doc.sticker);  
      } else {
        return this.getFileURL(doc, false, thumb);
      }
    }

    return '';
  }

  public getInputFileName(doc: MTDocument, thumbSize?: string) {
    return getFileNameByLocation(this.getInput(doc, thumbSize), {fileName: doc.file_name});
  }

  public downloadDocNew(docID: string | MTDocument/* , method: ResponseMethod = 'blob' */): DownloadBlob {
    const doc = this.getDoc(docID);

    if(doc._ == 'documentEmpty') {
      throw new Error('Document empty!');
    }

    const fileName = this.getInputFileName(doc);

    let download: DownloadBlob = appDownloadManager.getDownload(fileName);
    if(download) {
      return download;
    }

    download = appDownloadManager.download(doc.url, fileName/* , method */);

    const originalPromise = download;
    originalPromise.then((blob) => {
      doc.downloaded = true;

      if(!doc.supportsStreaming) {
        doc.url = URL.createObjectURL(blob);
      }
    });

    if(doc.type == 'voice' && !opusDecodeController.isPlaySupported()) {
      download = originalPromise.then(async(blob) => {
        let reader = new FileReader();
  
        await new Promise((resolve, reject) => {
          reader.onloadend = (e) => {
            let uint8 = new Uint8Array(e.target.result as ArrayBuffer);
            //console.log('sending uint8 to decoder:', uint8);
            opusDecodeController.decode(uint8).then(result => {
              doc.url = result.url;
              resolve();
            }, (err) => {
              delete doc.downloaded;
              reject(err);
            });
          };
    
          reader.readAsArrayBuffer(blob);
        });
  
        return blob;
        //return originalPromise;
        //return new Response(blob);
      });
    }

    return download;
  }

  public saveDocFile(doc: MTDocument) {
    const url = this.getFileURL(doc, true);
    const fileName = this.getInputFileName(doc);

    return appDownloadManager.downloadToDisc(fileName, url, doc.file_name);
  }
}

const appDocsManager = new AppDocsManager();
// @ts-ignore
if(process.env.NODE_ENV != 'production') {
  (window as any).appDocsManager = appDocsManager;
}
export default appDocsManager;
