import PopupElement from './index';
import PopupDatePicker from './datePicker';
import CheckboxField from '../checkboxField';
import {attachClickEvent} from '../../helpers/dom/clickEvent';
import {ChatExportFormat, ChatExportMediaType, ExportDirectoryHandle, exportChatHistory, getExportTitle, pickExportDirectory} from '../../lib/export/chatHistoryExporter';
import type Chat from '../chat/chat';
import {ChatType} from '../chat/chat';
import {toastNew} from '../toast';
import I18n, {LangPackKey} from '../../lib/langPack';

const MEDIA_OPTIONS: LangPackKey[] = [
  'ChatExport.Settings.Photos',
  'ChatExport.Settings.Videos',
  'ChatExport.Settings.Voice',
  'ChatExport.Settings.VideoNotes',
  'ChatExport.Settings.Stickers',
  'ChatExport.Settings.AnimatedGif',
  'ChatExport.Settings.Files'
];

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

  private appendCheckbox(langKey: LangPackKey, field: CheckboxField) {
    const caption = document.createElement('span');
    caption.className = 'checkbox-caption';
    caption.textContent = I18n.format(langKey, true);
    field.label.append(caption);
    this.body.append(field.label);
  }

  constructor(private chat: Chat) {
    super('chat-export-settings', {
      body: true,
      title: (() => {
        const title = document.createElement('span');
        title.textContent = I18n.format('ChatExport.Settings.Title', true);
        return title;
      })(),
      buttons: [{
        langKey: 'Cancel',
        isCancel: true
      }, {
        langKey: 'ChatExport.Settings.Export',
        callback: () => this.startExport()
      }]
    });

    this.buildBody();
  }

  private buildBody() {
    const mediaTitle = document.createElement('div');
    mediaTitle.className = 'chat-export-section-title';
    mediaTitle.textContent = I18n.format('ChatExport.Settings.Media', true);
    this.body.append(mediaTitle);

    const mediaTypes: ChatExportMediaType[] = ['photos', 'videos', 'voice', 'video_notes', 'stickers', 'animated_gif', 'files'];
    this.selectAllMediaField = new CheckboxField();
    this.appendCheckbox('ChatExport.Settings.SelectAll', this.selectAllMediaField);
    this.selectAllMediaField.input.addEventListener('change', () => {
      this.mediaFields.forEach(({field}) => field.setValueSilently(this.selectAllMediaField.checked));
    });
    MEDIA_OPTIONS.forEach((langKey, idx) => {
      const field = new CheckboxField();
      field.checked = true;
      this.mediaFields.push({type: mediaTypes[idx], field});
      field.input.addEventListener('change', () => {
        this.selectAllMediaField.setValueSilently(this.mediaFields.every(({field}) => field.checked));
      });
      this.appendCheckbox(langKey, field);
    });
    this.selectAllMediaField.checked = true;

    const sizeLabel = document.createElement('label');
    sizeLabel.className = 'chat-export-size';
    sizeLabel.append(I18n.format('ChatExport.Settings.MaxMediaSize', true));
    const sizeValue = document.createElement('output');
    sizeValue.textContent = this.formatMediaBytes(this.maxMediaBytes);
    const sizeInput = document.createElement('input');
    sizeInput.type = 'range';
    sizeInput.min = '12';
    sizeInput.max = '32';
    sizeInput.value = '32';
    sizeInput.addEventListener('input', () => {
      const bytes = 2 ** +sizeInput.value;
      this.maxMediaBytes = bytes;
      sizeValue.textContent = this.formatMediaBytes(bytes);
    });
    sizeLabel.append(sizeValue, sizeInput);
    this.body.append(sizeLabel);

    const formatTitle = document.createElement('div');
    formatTitle.className = 'chat-export-section-title';
    formatTitle.textContent = I18n.format('ChatExport.Settings.Format', true);
    this.body.append(formatTitle);
    (['html', 'json'] as ChatExportFormat[]).forEach((format) => {
      const field = new CheckboxField();
      this.formatFields.push({format, field});
      this.appendCheckbox(format === 'html' ? 'ChatExport.Settings.HTML' : 'ChatExport.Settings.JSON', field);
    });
    this.formatFields.forEach(({field}) => field.checked = true);

    this.directoryButton = document.createElement('button');
    this.directoryButton.className = 'btn-primary btn-color-primary chat-export-directory';
    this.directoryButton.textContent = I18n.format('ChatExport.Settings.ChooseFolder', true);
    attachClickEvent(this.directoryButton, this.chooseDirectory, {listenerSetter: this.listenerSetter});
    this.body.append(this.directoryButton);

    const dates = document.createElement('div');
    dates.className = 'chat-export-dates';
    this.fromButton = this.makeDateButton('ChatExport.Settings.From', (date) => {
      this.fromDate = date;
    });
    this.toButton = this.makeDateButton('ChatExport.Settings.To', (date) => {
      this.toDate = date;
    });
    dates.append(this.fromButton, this.toButton);
    this.body.append(dates);
  }

  private makeDateButton(labelKey: LangPackKey, onPick: (date: Date) => void) {
    const button = document.createElement('button');
    button.className = 'btn-secondary chat-export-date';
    button.textContent = `${I18n.format(labelKey, true)}: ${I18n.format('ChatExport.Settings.AllDates', true)}`;
    attachClickEvent(button, () => {
      const popup = PopupElement.createPopup(
        PopupDatePicker,
        new Date(),
        (timestamp: number) => {
          const date = new Date(timestamp * 1000);
          const normalized = labelKey === 'ChatExport.Settings.To' ?
            new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1, 0, 0, 0, -1) :
            new Date(date.getFullYear(), date.getMonth(), date.getDate());
          onPick(normalized);
          button.textContent = `${I18n.format(labelKey, true)}: ${normalized.toLocaleDateString()}`;
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
      const name = this.directory.name || I18n.format('ChatExport.Settings.SelectedFolder', true);
      this.directoryButton.textContent = `${I18n.format('ChatExport.Settings.Folder', true)}: ${name}`;
      this.directoryButton.title = name;
    } catch(error) {
      if(error instanceof DOMException && error.name === 'AbortError') return;
      if(error instanceof Error && error.message === 'DIRECTORY_PICKER_UNSUPPORTED') {
        toastNew({langPackKey: 'ChatExport.Unsupported'});
        return;
      }
      console.error('[ChatExport] failed to choose export directory', error);
      toastNew({langPackKey: 'ChatExport.DirectoryError'});
    }
  };

  private formatMediaBytes(bytes: number) {
    if(bytes < 1024 ** 2) return `${Math.round(bytes / 1024)} KB`;
    if(bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(bytes < 10 * 1024 ** 2 ? 1 : 0)} MB`;
    return `${(bytes / 1024 ** 3).toFixed(bytes < 10 * 1024 ** 3 ? 1 : 0)} GB`;
  }

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
    const toDate = this.toDate;
    if(fromDate && toDate && fromDate.getTime() > toDate.getTime()) {
      toastNew({langPackKey: 'ChatExport.InvalidDateRange'});
      return false;
    }
    const abortController = new AbortController();
    this.hide();
    const exportGeneration = this.chat.topbar.startExportProgress(title, abortController);

    void exportChatHistory({
      peerId: this.chat.peerId,
      threadId: this.chat.threadId,
      scheduled: this.chat.type === ChatType.Scheduled,
      title,
      directory: this.directory,
      formats,
      mediaTypes: this.mediaFields.filter(({field}) => field.checked).map(({type}) => type),
      maxMediaBytes: this.maxMediaBytes,
      fromDate,
      toDate,
      signal: abortController.signal,
      onProgress: (progress) => this.chat.topbar.updateExportProgress(progress, exportGeneration)
    }).then(() => {
      this.chat.topbar.finishExportProgress('completed', exportGeneration);
    }, (error) => {
      console.error('[ChatExport] export failed', error);
      this.chat.topbar.finishExportProgress(
        abortController.signal.aborted || (error instanceof DOMException && error.name === 'AbortError') ? 'cancelled' : 'failed',
        exportGeneration
      );
    });

    return true;
  };
}
