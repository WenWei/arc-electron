// Scrips are moved to scripts/renderer/preload.js so node integration can be disabled
// in the application window.
/**
 * Class responsible for initializing the main ARC elements
 * and setup base options.
 * Also serves as a communication bridge between main process and app window.
 *
 * This is only supported in the Electron platform.
 *
 * In ARC node integration is disabled as responses received from the server
 * can be executed in preview window. Any script would instantly get access
 * to whole electron and node environment. As a consequence the script
 * would have access to user system. Classes that need access to electron / node
 * API are loaded in sandbox in the preload script and initialized here.
 * Scripts can't use `require()` or any other node function.
 */
class ArcInit {
  /**
   * @constructor
   */
  constructor() {
    /* global ipc, ArcContextMenu, ArcElectronDrive, OAuth2Handler,
    ThemeManager, ArcPreferencesProxy, CookieBridge, WorkspaceManager,
    FilesystemProxy */
    this.created = false;
    this.contextActions = new ArcContextMenu();
    this.driveBridge = new ArcElectronDrive();
    this.oauth2Proxy = new OAuth2Handler();
    this.themeManager = new ThemeManager();
    this.prefProxy = new ArcPreferencesProxy();
    this.cookieBridge = new CookieBridge();
    this.fs = new FilesystemProxy();
  }
  /**
   * Reference to the main application window.
   *
   * @return {HtmlElement}
   */
  get app() {
    return document.getElementById('app');
  }
  /**
   * Listens for application events to create a communication
   * bridge between main process and the app.
   */
  listen() {
    this.contextActions.listenMainEvents();
    window.onbeforeunload = this.beforeUnloadWindow.bind(this);
    const updateHandler = this.updateEventHandler.bind(this);
    this.driveBridge.listen();
    this.oauth2Proxy.listen();
    this.themeManager.listen();
    this.prefProxy.observe();
    this.cookieBridge.listen();
    this.fs.listen();
    ipc.on('checking-for-update', updateHandler);
    ipc.on('update-available', updateHandler);
    ipc.on('update-not-available', updateHandler);
    ipc.on('autoupdate-error', updateHandler);
    ipc.on('download-progress', updateHandler);
    ipc.on('update-downloaded', updateHandler);
    ipc.on('command', this.commandHandler.bind(this));
    ipc.on('request-action', this.execRequestAction.bind(this));
    ipc.on('theme-editor-preview', this._themePreviewHandler.bind(this));
    ipc.on('window-state-info', this._stateInfoHandler.bind(this));
  }
  /**
   * Requests initial state information from the main process for current
   * window.
   */
  requestState() {
    ipc.send('window-state-request');
  }
  /**
   * Handler for the `window-state-info` event from the main process.
   * Setups properties to be passed to the ARC application.
   *
   * When this is called it creates application window and places it in the
   * document body.
   *
   * @param {Event} e
   * @param {Object} info Main proces initil properties. See `AppOptions` class
   * for more details.
   */
  _stateInfoHandler(e, info) {
    info = info || {};
    const initConfig = info;
    if (!initConfig.workspaceIndex) {
      initConfig.workspaceIndex = 0;
    }
    this.workspaceIndex = initConfig.workspaceIndex;
    if (!window.ArcConfig) {
      window.ArcConfig = {};
    }
    this.initConfig = initConfig;
    window.ArcConfig.initConfig = initConfig;
    this.initApp()
    .then(() => console.log('Application window is now ready.'));
  }
  /**
   * Initialized the application when window is ready.
   *
   * @return {Promise}
   */
  initApp() {
    console.info('Initializing renderer window...');
    const opts = {};
    if (this.initConfig.workspacePath) {
      opts.filePath = this.initConfig.workspacePath;
    }
    this.workspaceManager = new WorkspaceManager(this.workspaceIndex, opts);
    this.workspaceManager.observe();
    return this._createApp()
    .then(() => this.themeManager.loadTheme(this.initConfig.themeFile))
    .catch((cause) => this.reportFatalError(cause));
  }
  /**
   * Reports fatal application error.
   *
   * @param {Error} err Error object
   */
  reportFatalError(err) {
    console.error(err);
    ipc.send('fatal-error', err.message);
  }
  /**
   * Creates application main element.
   *
   * @return {Promise} Promise resolved when element is loaded and ready
   * rendered.
   */
  _createApp() {
    if (this.created) {
      return Promise.resolve();
    }
    console.log('Importing components from ', this.initConfig.importFile);
    return this._importHref(this.initConfig.importFile)
    .catch(() => {
      throw new Error('Unable to load components import file.');
    })
    .then(() => {
      console.log('Importing arc-electron component');
      return new Promise((resolve, reject) => {
        Polymer.importHref('src/arc-electron.html', () => {
          resolve();
        }, () => {
          reject(new Error('Unable to load ARC app'));
        });
      });
    })
    .then(() => {
      console.info('Initializing arc-electron element...');
      const app = document.createElement('arc-electron');
      app.id = 'app';
      this._setupApp(app);
      document.body.appendChild(app);
      this.created = true;
    });
  }

  _importHref(href) {
    return new Promise((resolve, reject) => {
      const link = document.createElement('link');
      link.rel = 'import';
      link.href = href;
      link.setAttribute('import-href', '');
      link.setAttribute('async', '');
      const callbacks = {
        load: function() {
          callbacks.cleanup();
          resolve();
        },
        error: function() {
          callbacks.cleanup();
          reject();
        },
        cleanup: function() {
          link.removeEventListener('load', callbacks.load);
          link.removeEventListener('error', callbacks.error);
        }
      };
      link.addEventListener('load', callbacks.load);
      link.addEventListener('error', callbacks.error);
      document.head.appendChild(link);
    });
  }
  /**
   * Sets up the application properties.
   *
   * @param {ArcElectron} app App electron element.
   */
  _setupApp(app) {
    console.info('Initializing ARC app');
    app.componentsDir = this.initConfig.appComponents;
    app.initApplication();
  }
  /**
   * Because window has to be setup from the main process
   * (setting app init values) the window sends reload
   * information to the main process so it can re-set the
   * window after it's reloaded.
   */
  beforeUnloadWindow() {
    ipc.send('window-reloading');
  }

  /**
   * Handles events related to the application auto-update action.
   *
   * @param {Object} sender
   * @param {Array} message
   */
  updateEventHandler(sender, message) {
    const app = this.app;
    console.log('updateEventHandler', message);
    app.updateState = message;
    if (message[0] === 'update-downloaded') {
      app.hasAppUpdate = true;
    }
  }
  /**
   * Handler for application command.
   *
   * @param {EventEmitter} e Node's event
   * @param {String} action
   * @param {Array} args
   */
  commandHandler(e, action, ...args) {
    console.info('Renderer command handled: ', action);
    const app = this.app;
    switch (action) {
      case 'show-settings': app.openSettings(); break;
      case 'about': app.openAbout(); break;
      case 'open-license': app.openLicense(); break;
      case 'import-data': app.openImport(); break;
      case 'export-data': app.openExport(); break;
      case 'open-saved': app.openSaved(); break;
      case 'open-history': app.openHistory(); break;
      case 'open-drive': app.openDrivePicker(); break;
      case 'open-messages': app.openInfoCenter(); break;
      case 'login-external-webservice': app.openWebUrl(); break;
      case 'open-cookie-manager': app.openCookieManager(); break;
      case 'open-hosts-editor': app.openHostRules(); break;
      case 'get-tabs-count': this.sendTabsCount(e, args[0]); break;
      case 'activate-tab': this.activateTab(e, args[0], args[1]); break;
      case 'get-request-data': this.getRequestData(e, args[0], args[1]); break;
      case 'open-themes': app.openThemesPanel(); break;
      case 'open-requests-workspace': app.openWorkspace(); break;
      case 'open-web-socket': app.openWebSocket(); break;
    }
  }
  /**
   * Remote API command.
   * Sends number of tabs command to the main process.
   *
   * @param {EventEmitter} e
   * @param {Number} callId
   */
  sendTabsCount(e, callId) {
    const cnt = this.app.getTabsCount();
    e.sender.send('current-tabs-count', callId, false, cnt);
  }
  /**
   * Remote API command.
   * Activates a tab in current window.
   *
   * @param {EventEmitter} e
   * @param {Number} callId
   * @param {Number} tabId ID of a tab
   */
  activateTab(e, callId, tabId) {
    this.app.workspace.selected = tabId;
    e.sender.send('tab-activated', callId, false);
  }
  /**
   * Remote API command.
   * Sends request data to the main process.
   *
   * Because of limitations of sending the data between
   * renderer and main process objects like FormData of
   * file data won't be sent.
   *
   * @param {EventEmitter} e
   * @param {Number} callId
   * @param {Number} tabId ID of a tab
   */
  getRequestData(e, callId, tabId) {
    const request = this.app.workspace.activeRequests[tabId];
    e.sender.send('request-data', callId, false, request);
  }
  /**
   * Handles action performed in main thread (menu action) related to
   * a request.
   *
   * @param {EventEmitter} e
   * @param {String} action Action name to perform.
   */
  execRequestAction(e, action, ...args) {
    console.info('Renderer request command handled: ', action);
    const app = this.app;
    switch (action) {
      case 'save':
        app.saveOpened({
          source: 'shortcut'
        });
      break;
      case 'save-as':
        app.saveOpened();
      break;
      case 'new-tab':
        app.newRequestTab();
      break;
      case 'send-current':
        app.sendCurrentTab();
      break;
      case 'update-request':
        app.updateRequestTab(args[0], args[1]);
      break;
      default:
        throw new Error('Unrecognized action ' + action);
    }
  }
  /**
   * Handler for `theme-editor-preview` event. Current;ly this system is not
   * in use
   *
   * @param {EventEmitter} e
   * @param {Object} stylesMap
   */
  _themePreviewHandler(e, stylesMap) {
    this.themeLoader.previewThemes(stylesMap);
  }
}

const initScript = new ArcInit();
initScript.listen();
initScript.requestState();
