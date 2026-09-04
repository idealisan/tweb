import PopupElement from './index';
import PopupDatePicker from './datePicker';
import CheckboxField from '../checkboxField';
import {attachClickEvent} from '../../helpers/dom/clickEvent';
import {ChatExportFormat, ChatExportMediaType, ExportDirectoryHandle, exportChatHistory, getExportTitle, pickExportDirectory} from '../../lib/export/chatHistoryExporter';
import type Chat from '../chat/chat';
import {toastNew} from '../toast';

const MEDIA_OPTIONS = ['Photos', 'Videos', 'Voice', 'Video Notes', 'Stickers', 'Animated GIF', 'Files'];

export default class PopupChatExportSettings extends PopupElement {
  private directory: ExportDirectoryHandle;
  private directoryButton: HTMLButtonElement;
  private fromButton: HTMLButtonElement;
  private toButton: HTMLButtonElement;
  private fromDate?: Date;
  private toDate?: Date;
  private formatFields: {format: ChatExportFormat, field: CheckboxField}[] = [];
  private mediaFields: {type: ChatExportMediaType, field: CheckboxField}[] = [];
  private selectAllMediaField: CheckboxField;
  private maxMediaBytes = 2 ** 32;

  private appendCheckbox(title: string, field: CheckboxField) {
    const caption = document.createElement('span');
    caption.className = 'checkbox-caption';
    caption.textContent = title;
    field.label.append(caption);
    this.body.append(field.label);
  }

  constructor(private chat: Chat) {
    super('chat-export-settings', {
      body: true,
      title: (() => {
        const title = document.createElement('span');
        title.textContent = 'Chat Expert Settings';
        return title;
      })(),
      buttons: [{
        langKey: 'Cancel',
        isCancel: true
      }, {
        text: document.createTextNode('Export'),
        callback: () => this.startExport()
      }]
    });

    this.buildBody();
  }

  private buildBody() {
    const mediaTitle = document.createElement('div');
    mediaTitle.className = 'chat-export-section-title';
    mediaTitle.textContent = 'Media';
    this.body.append(mediaTitle);

    const mediaTypes: ChatExportMediaType[] = ['photos', 'videos', 'voice', 'video_notes', 'stickers', 'animated_gif', 'files'];
    this.selectAllMediaField = new CheckboxField();
    this.appendCheckbox('Select all', this.selectAllMediaField);
    this.selectAllMediaField.input.addEventListener('change', () => {
      this.mediaFields.forEach(({field}) => field.setValueSilently(this.selectAllMediaField.checked));
    });
    MEDIA_OPTIONS.forEach((title, idx) => {
      const field = new CheckboxField();
      this.mediaFields.push({type: mediaTypes[idx], field});
      this.appendCheckbox(title, field);
    });

    const sizeLabel = document.createElement('label');
    sizeLabel.className = 'chat-export-size';
    sizeLabel.textContent = 'Maximum media file size: ';
    const sizeValue = document.createElement('output');
    sizeValue.textContent = '4 GB';
    const sizeInput = document.createElement('input');
    sizeInput.type = 'range';
    sizeInput.min = '12';
    sizeInput.max = '32';
    sizeInput.value = '32';
    sizeInput.addEventListener('input', () => {
      const bytes = 2 ** +sizeInput.value;
      this.maxMediaBytes = bytes;
      sizeValue.textContent = bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1)} GB` : `${Math.round(bytes / 1024 ** 2)} MB`;
    });
    sizeLabel.append(sizeValue, sizeInput);
    this.body.append(sizeLabel);

    const formatTitle = document.createElement('div');
    formatTitle.className = 'chat-export-section-title';
    formatTitle.textContent = 'Format';
    this.body.append(formatTitle);
    (['html', 'json'] as ChatExportFormat[]).forEach((format) => {
      const field = new CheckboxField();
      this.formatFields.push({format, field});
      this.appendCheckbox(format.toUpperCase(), field);
    });
    this.formatFields.forEach(({field}) => field.checked = true);

    this.directoryButton = document.createElement('button');
    this.directoryButton.className = 'btn-primary btn-color-primary chat-export-directory';
    this.directoryButton.textContent = 'Choose folder';
    attachClickEvent(this.directoryButton, this.chooseDirectory, {listenerSetter: this.listenerSetter});
    this.body.append(this.directoryButton);

    const dates = document.createElement('div');
    dates.className = 'chat-export-dates';
    this.fromButton = this.makeDateButton('From', (date) => {
      this.fromDate = date;
    });
    this.toButton = this.makeDateButton('To', (date) => {
      this.toDate = date;
    });
    dates.append(this.fromButton, this.toButton);
    this.body.append(dates);
  }

  private makeDateButton(label: string, onPick: (date: Date) => void) {
    const button = document.createElement('button');
    button.className = 'btn-secondary chat-export-date';
    button.textContent = `${label}: All dates`;
    attachClickEvent(button, () => {
      const popup = PopupElement.createPopup(
        PopupDatePicker,
        new Date(),
        (timestamp: number) => {
          const date = new Date(timestamp * 1000);
          onPick(date);
          button.textContent = `${label}: ${date.toLocaleDateString()}`;
        },
        {overlayClosable: true}
      );
      popup.show();
    }, {listenerSetter: this.listenerSetter});
    return button;
  }

  private chooseDirectory = async() => {
    try {
      this.directory = await pickExportDirectory();
      const name = this.directory.name || 'Selected folder';
      this.directoryButton.textContent = `Folder: ${name}`;
      this.directoryButton.title = name;
    } catch(error) {
      if((error as Error).message !== 'DIRECTORY_PICKER_UNSUPPORTED') throw error;
      toastNew({langPackKey: 'ChatExport.Unsupported'});
    }
  };

  private startExport = async() => {
    if(!this.directory) {
      toastNew({langPackKey: 'ChatExport.SelectFolder'});
      return false;
    }

    const formats = this.formatFields.filter(({field}) => field.checked).map(({format}) => format);
    if(!formats.length) {
      toastNew({langPackKey: 'ChatExport.SelectFormat'});
      return false;
    }

    const title = await getExportTitle(this.chat.peerId);
    const fromDate = this.fromDate;
    const toDate = this.toDate ? new Date(this.toDate.getTime() + 86400000 - 1) : undefined;
    const abortController = new AbortController();
    this.hide();
    this.chat.topbar.startExportProgress(title, abortController);

    void exportChatHistory({
      peerId: this.chat.peerId,
      threadId: this.chat.threadId,
      title,
      directory: this.directory,
      formats,
      mediaTypes: this.mediaFields.filter(({field}) => field.checked).map(({type}) => type),
      maxMediaBytes: this.maxMediaBytes,
      fromDate,
      toDate,
      signal: abortController.signal,
      onProgress: (progress) => this.chat.topbar.updateExportProgress(progress)
    }).then(() => {
      this.chat.topbar.finishExportProgress(false);
    }, (error) => {
      console.error('[ChatExport] export failed', error);
      this.chat.topbar.finishExportProgress(true);
    });

    return true;
  };
}
