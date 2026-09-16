import template from './cmp.loading-screen.html?raw';

export class LoadingScreen extends HTMLElement {

  private elements: {
    mainContainer: HTMLElement;
    logList: HTMLElement;
  } = {} as any;

  constructor() {
    super();
  }

  connectedCallback() {
    this.innerHTML = template;
    this.elements = {
      mainContainer: this.querySelector("#loading-screen-container") as HTMLElement,
      logList: this.querySelector("#loading-screen-log-list") as HTMLElement
    };
  }

  clearLog() {
    this.elements.logList.innerHTML = '';
  }

  show() {
    this.elements.mainContainer.classList.remove('hidden');
    this.clearLog();
  }

  hide() {
    this.elements.mainContainer.classList.add('hidden');
  }

  log(message: string, progress?: { current: number; total: number }) {
    const logItem: {
      element: HTMLElement;
      message: string;
      progress?: { current: number; total: number };
      updateLogItem: (message: string, progress?: { current: number; total: number }) => void;
    } = {
      element: document.createElement('div'),
      message: message,
      progress: progress
     } as any;

    const updateLogItem = (message: string, progress?: { current: number; total: number }) => {
      logItem.element.innerHTML = `
        <div class="w-full">${message}${progress ? ` — ${progress.current}/${progress.total} (${Math.round((progress.current / progress.total) * 100)}%)` : ''}</div>
        ${progress ? `<div class="w-full h-1 bg-brown-900 relative mb-1">
          <div class="absolute top-0 left-0 h-full bg-green-500" style="width: ${Math.round((progress.current / progress.total) * 100)}%;"></div>
        </div>` : ''}
      `
    }
    logItem.updateLogItem = updateLogItem;

    updateLogItem(message, progress);
    this.elements.logList.appendChild(logItem.element);

    return logItem;
  }
}
