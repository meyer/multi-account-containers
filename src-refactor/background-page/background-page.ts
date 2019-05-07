const DEFAULT_TAB = 'about:newtab';
const backgroundLogic = {
  NEW_TAB_PAGES: new Set(['about:startpage', 'about:newtab', 'about:home', 'about:blank']),
  unhideQueue: [],

  async getExtensionInfo() {
    const manifestPath = browser.extension.getURL('manifest.json');
    const response = await fetch(manifestPath);
    const extensionInfo = await response.json();
    return extensionInfo;
  },

  getUserContextIdFromCookieStoreId(cookieStoreId) {
    if (!cookieStoreId) {
      return false;
    }
    const container = cookieStoreId.replace('firefox-container-', '');
    if (container !== cookieStoreId) {
      return container;
    }
    return false;
  },

  async deleteContainer(userContextId, removed = false) {
    await this._closeTabs(userContextId);
    if (!removed) {
      await browser.contextualIdentities.remove(this.cookieStoreId(userContextId));
    }
    assignManager.deleteContainer(userContextId);
    return { done: true, userContextId };
  },

  async createOrUpdateContainer(options) {
    let donePromise;
    if (options.userContextId !== 'new') {
      donePromise = browser.contextualIdentities.update(this.cookieStoreId(options.userContextId), options.params);
    } else {
      donePromise = browser.contextualIdentities.create(options.params);
    }
    await donePromise;
    browser.runtime.sendMessage({
      method: 'refreshNeeded',
    });
  },

  async openNewTab(options) {
    let url = options.url || undefined;
    const userContextId = 'userContextId' in options ? options.userContextId : 0;
    const active = 'nofocus' in options ? options.nofocus : true;

    const cookieStoreId = backgroundLogic.cookieStoreId(userContextId);
    // Autofocus url bar will happen in 54: https://bugzilla.mozilla.org/show_bug.cgi?id=1295072

    // We can't open new tab pages, so open a blank tab. Used in tab un-hide
    if (this.NEW_TAB_PAGES.has(url)) {
      url = undefined;
    }

    if (!this.isPermissibleURL(url)) {
      return;
    }

    return browser.tabs.create({
      url,
      active,
      pinned: options.pinned || false,
      cookieStoreId,
    });
  },

  isPermissibleURL(url) {
    const protocol = new URL(url).protocol;
    // We can't open these we just have to throw them away
    if (protocol === 'about:' || protocol === 'chrome:' || protocol === 'moz-extension:') {
      return false;
    }
    return true;
  },

  checkArgs(requiredArguments, options, methodName) {
    requiredArguments.forEach(argument => {
      if (!(argument in options)) {
        return new Error(`${methodName} must be called with ${argument} argument.`);
      }
    });
  },

  async getTabs(options) {
    const requiredArguments = ['cookieStoreId', 'windowId'];
    this.checkArgs(requiredArguments, options, 'getTabs');
    const { cookieStoreId, windowId } = options;

    const list = [];
    const tabs = await browser.tabs.query({
      cookieStoreId,
      windowId,
    });
    tabs.forEach(tab => {
      list.push(identityState._createTabObject(tab));
    });

    const containerState = await identityState.storageArea.get(cookieStoreId);
    return list.concat(containerState.hiddenTabs);
  },

  async unhideContainer(cookieStoreId) {
    if (!this.unhideQueue.includes(cookieStoreId)) {
      this.unhideQueue.push(cookieStoreId);
      await this.showTabs({
        cookieStoreId,
      });
      this.unhideQueue.splice(this.unhideQueue.indexOf(cookieStoreId), 1);
    }
  },

  async moveTabsToWindow(options) {
    const requiredArguments = ['cookieStoreId', 'windowId'];
    this.checkArgs(requiredArguments, options, 'moveTabsToWindow');
    const { cookieStoreId, windowId } = options;

    const list = await browser.tabs.query({
      cookieStoreId,
      windowId,
    });

    const containerState = await identityState.storageArea.get(cookieStoreId);

    // Nothing to do
    if (list.length === 0 && containerState.hiddenTabs.length === 0) {
      return;
    }
    let newWindowObj;
    let hiddenDefaultTabToClose;
    if (list.length) {
      newWindowObj = await browser.windows.create();

      // Pin the default tab in the new window so existing pinned tabs can be moved after it.
      // From the docs (https://developer.mozilla.org/en-US/Add-ons/WebExtensions/API/tabs/move):
      //   Note that you can't move pinned tabs to a position after any unpinned tabs in a window, or move any unpinned tabs to a position before any pinned tabs.
      await browser.tabs.update(newWindowObj.tabs[0].id, { pinned: true });

      browser.tabs.move(list.map(tab => tab.id), {
        windowId: newWindowObj.id,
        index: -1,
      });
    } else {
      //As we get a blank tab here we will need to await the tabs creation
      newWindowObj = await browser.windows.create({});
      hiddenDefaultTabToClose = true;
    }

    const showHiddenPromises = [];

    // Let's show the hidden tabs.
    if (!this.unhideQueue.includes(cookieStoreId)) {
      this.unhideQueue.push(cookieStoreId);
      for (let object of containerState.hiddenTabs) {
        // eslint-disable-line prefer-const
        showHiddenPromises.push(
          browser.tabs.create({
            url: object.url || DEFAULT_TAB,
            windowId: newWindowObj.id,
            cookieStoreId,
          })
        );
      }
    }

    if (hiddenDefaultTabToClose) {
      // Lets wait for hidden tabs to show before closing the others
      await showHiddenPromises;
    }

    containerState.hiddenTabs = [];

    // Let's close all the normal tab in the new window. In theory it
    // should be only the first tab, but maybe there are addons doing
    // crazy stuff.
    const tabs = await browser.tabs.query({ windowId: newWindowObj.id });
    for (let tab of tabs) {
      // eslint-disable-line prefer-const
      if (tab.cookieStoreId !== cookieStoreId) {
        browser.tabs.remove(tab.id);
      }
    }
    const rv = await identityState.storageArea.set(cookieStoreId, containerState);
    this.unhideQueue.splice(this.unhideQueue.indexOf(cookieStoreId), 1);
    return rv;
  },

  async _closeTabs(userContextId, windowId = false) {
    const cookieStoreId = this.cookieStoreId(userContextId);
    let tabs;
    /* if we have no windowId we are going to close all this container (used for deleting) */
    if (windowId !== false) {
      tabs = await browser.tabs.query({
        cookieStoreId,
        windowId,
      });
    } else {
      tabs = await browser.tabs.query({
        cookieStoreId,
      });
    }
    const tabIds = tabs.map(tab => tab.id);
    return browser.tabs.remove(tabIds);
  },

  async queryIdentitiesState(windowId) {
    const identities = await browser.contextualIdentities.query({});
    const identitiesOutput = {};
    const identitiesPromise = identities.map(async identity => {
      const { cookieStoreId } = identity;
      const containerState = await identityState.storageArea.get(cookieStoreId);
      const openTabs = await browser.tabs.query({
        cookieStoreId,
        windowId,
      });
      identitiesOutput[cookieStoreId] = {
        hasHiddenTabs: !!containerState.hiddenTabs.length,
        hasOpenTabs: !!openTabs.length,
        numberOfHiddenTabs: containerState.hiddenTabs.length,
        numberOfOpenTabs: openTabs.length,
      };
      return;
    });
    await Promise.all(identitiesPromise);
    return identitiesOutput;
  },

  async sortTabs() {
    const windows = await browser.windows.getAll();
    for (let windowObj of windows) {
      // eslint-disable-line prefer-const
      // First the pinned tabs, then the normal ones.
      await this._sortTabsInternal(windowObj, true);
      await this._sortTabsInternal(windowObj, false);
    }
  },

  async _sortTabsInternal(windowObj, pinnedTabs) {
    const tabs = await browser.tabs.query({ windowId: windowObj.id });
    let pos = 0;

    // Let's collect UCIs/tabs for this window.
    const map = new Map();
    for (const tab of tabs) {
      if (pinnedTabs && !tab.pinned) {
        // We don't have, or we already handled all the pinned tabs.
        break;
      }

      if (!pinnedTabs && tab.pinned) {
        // pinned tabs must be consider as taken positions.
        ++pos;
        continue;
      }

      const userContextId = backgroundLogic.getUserContextIdFromCookieStoreId(tab.cookieStoreId);
      if (!map.has(userContextId)) {
        map.set(userContextId, []);
      }
      map.get(userContextId).push(tab);
    }

    // Let's sort the map.
    const sortMap = new Map([...map.entries()].sort((a, b) => a[0] > b[0]));

    // Let's move tabs.
    sortMap.forEach(tabs => {
      for (const tab of tabs) {
        ++pos;
        browser.tabs.move(tab.id, {
          windowId: windowObj.id,
          index: pos,
        });
      }
    });
  },

  async hideTabs(options) {
    const requiredArguments = ['cookieStoreId', 'windowId'];
    this.checkArgs(requiredArguments, options, 'hideTabs');
    const { cookieStoreId, windowId } = options;

    const userContextId = backgroundLogic.getUserContextIdFromCookieStoreId(cookieStoreId);

    const containerState = await identityState.storeHidden(cookieStoreId, windowId);
    await this._closeTabs(userContextId, windowId);
    return containerState;
  },

  async showTabs(options) {
    if (!('cookieStoreId' in options)) {
      return Promise.reject('showTabs must be called with cookieStoreId argument.');
    }

    const userContextId = backgroundLogic.getUserContextIdFromCookieStoreId(options.cookieStoreId);
    const promises = [];

    const containerState = await identityState.storageArea.get(options.cookieStoreId);

    for (let object of containerState.hiddenTabs) {
      // eslint-disable-line prefer-const
      promises.push(
        this.openNewTab({
          userContextId: userContextId,
          url: object.url,
          nofocus: options.nofocus || false,
          pinned: object.pinned,
        })
      );
    }

    containerState.hiddenTabs = [];

    await Promise.all(promises);
    return await identityState.storageArea.set(options.cookieStoreId, containerState);
  },

  cookieStoreId(userContextId) {
    return `firefox-container-${userContextId}`;
  },
};

///////////////////

const assignManager = {
  MENU_ASSIGN_ID: 'open-in-this-container',
  MENU_REMOVE_ID: 'remove-open-in-this-container',
  MENU_SEPARATOR_ID: 'separator',
  MENU_HIDE_ID: 'hide-container',
  MENU_MOVE_ID: 'move-to-new-window-container',

  storageArea: {
    area: browser.storage.local,
    exemptedTabs: {},

    getSiteStoreKey(pageUrl) {
      const url = new window.URL(pageUrl);
      const storagePrefix = 'siteContainerMap@@_';
      if (url.port === '80' || url.port === '443') {
        return `${storagePrefix}${url.hostname}`;
      } else {
        return `${storagePrefix}${url.hostname}${url.port}`;
      }
    },

    setExempted(pageUrl, tabId) {
      const siteStoreKey = this.getSiteStoreKey(pageUrl);
      if (!(siteStoreKey in this.exemptedTabs)) {
        this.exemptedTabs[siteStoreKey] = [];
      }
      this.exemptedTabs[siteStoreKey].push(tabId);
    },

    removeExempted(pageUrl) {
      const siteStoreKey = this.getSiteStoreKey(pageUrl);
      this.exemptedTabs[siteStoreKey] = [];
    },

    isExempted(pageUrl, tabId) {
      const siteStoreKey = this.getSiteStoreKey(pageUrl);
      if (!(siteStoreKey in this.exemptedTabs)) {
        return false;
      }
      return this.exemptedTabs[siteStoreKey].includes(tabId);
    },

    get(pageUrl) {
      const siteStoreKey = this.getSiteStoreKey(pageUrl);
      return new Promise((resolve, reject) => {
        this.area
          .get([siteStoreKey])
          .then(storageResponse => {
            if (storageResponse && siteStoreKey in storageResponse) {
              resolve(storageResponse[siteStoreKey]);
            }
            resolve(null);
          })
          .catch(e => {
            reject(e);
          });
      });
    },

    set(pageUrl, data, exemptedTabIds) {
      const siteStoreKey = this.getSiteStoreKey(pageUrl);
      if (exemptedTabIds) {
        exemptedTabIds.forEach(tabId => {
          this.setExempted(pageUrl, tabId);
        });
      }
      return this.area.set({
        [siteStoreKey]: data,
      });
    },

    remove(pageUrl) {
      const siteStoreKey = this.getSiteStoreKey(pageUrl);
      // When we remove an assignment we should clear all the exemptions
      this.removeExempted(pageUrl);
      return this.area.remove([siteStoreKey]);
    },

    async deleteContainer(userContextId) {
      const sitesByContainer = await this.getByContainer(userContextId);
      this.area.remove(Object.keys(sitesByContainer));
    },

    async getByContainer(userContextId) {
      const sites = {};
      const siteConfigs = await this.area.get();
      Object.keys(siteConfigs).forEach(key => {
        // For some reason this is stored as string... lets check them both as that
        if (String(siteConfigs[key].userContextId) === String(userContextId)) {
          const site = siteConfigs[key];
          // In hindsight we should have stored this
          // TODO file a follow up to clean the storage onLoad
          site.hostname = key.replace(/^siteContainerMap@@_/, '');
          sites[key] = site;
        }
      });
      return sites;
    },
  },

  _neverAsk(m) {
    const pageUrl = m.pageUrl;
    if (m.neverAsk === true) {
      // If we have existing data and for some reason it hasn't been deleted etc lets update it
      this.storageArea
        .get(pageUrl)
        .then(siteSettings => {
          if (siteSettings) {
            siteSettings.neverAsk = true;
            this.storageArea.set(pageUrl, siteSettings);
          }
        })
        .catch(e => {
          throw e;
        });
    }
  },

  // We return here so the confirm page can load the tab when exempted
  async _exemptTab(m) {
    const pageUrl = m.pageUrl;
    this.storageArea.setExempted(pageUrl, m.tabId);
    return true;
  },

  // Before a request is handled by the browser we decide if we should route through a different container
  async onBeforeRequest(options) {
    if (options.frameId !== 0 || options.tabId === -1) {
      return {};
    }
    this.removeContextMenu();
    const [tab, siteSettings] = await Promise.all([browser.tabs.get(options.tabId), this.storageArea.get(options.url)]);
    let container;
    try {
      container = await browser.contextualIdentities.get(backgroundLogic.cookieStoreId(siteSettings.userContextId));
    } catch (e) {
      container = false;
    }

    // The container we have in the assignment map isn't present any more so lets remove it
    //   then continue the existing load
    if (siteSettings && !container) {
      this.deleteContainer(siteSettings.userContextId);
      return {};
    }
    const userContextId = this.getUserContextIdFromCookieStore(tab);
    if (
      !siteSettings ||
      userContextId === siteSettings.userContextId ||
      tab.incognito ||
      this.storageArea.isExempted(options.url, tab.id)
    ) {
      return {};
    }
    const removeTab =
      backgroundLogic.NEW_TAB_PAGES.has(tab.url) ||
      (messageHandler.lastCreatedTab && messageHandler.lastCreatedTab.id === tab.id);
    const openTabId = removeTab ? tab.openerTabId : tab.id;

    if (!this.canceledRequests[tab.id]) {
      // we decided to cancel the request at this point, register canceled request
      this.canceledRequests[tab.id] = {
        requestIds: {
          [options.requestId]: true,
        },
        urls: {
          [options.url]: true,
        },
      };

      // since webRequest onCompleted and onErrorOccurred are not 100% reliable (see #1120)
      // we register a timer here to cleanup canceled requests, just to make sure we don't
      // end up in a situation where certain urls in a tab.id stay canceled
      setTimeout(() => {
        if (this.canceledRequests[tab.id]) {
          delete this.canceledRequests[tab.id];
        }
      }, 2000);
    } else {
      let cancelEarly = false;
      if (
        this.canceledRequests[tab.id].requestIds[options.requestId] ||
        this.canceledRequests[tab.id].urls[options.url]
      ) {
        // same requestId or url from the same tab
        // this is a redirect that we have to cancel early to prevent opening two tabs
        cancelEarly = true;
      }
      // we decided to cancel the request at this point, register canceled request
      this.canceledRequests[tab.id].requestIds[options.requestId] = true;
      this.canceledRequests[tab.id].urls[options.url] = true;
      if (cancelEarly) {
        return {
          cancel: true,
        };
      }
    }

    this.reloadPageInContainer(
      options.url,
      userContextId,
      siteSettings.userContextId,
      tab.index + 1,
      tab.active,
      siteSettings.neverAsk,
      openTabId
    );
    this.calculateContextMenu(tab);

    /* Removal of existing tabs:
        We aim to open the new assigned container tab / warning prompt in it's own tab:
          - As the history won't span from one container to another it seems most sane to not try and reopen a tab on history.back()
          - When users open a new tab themselves we want to make sure we don't end up with three tabs as per: https://github.com/mozilla/testpilot-containers/issues/421
        If we are coming from an internal url that are used for the new tab page (NEW_TAB_PAGES), we can safely close as user is unlikely losing history
        Detecting redirects on "new tab" opening actions is pretty hard as we don't get tab history:
        - Redirects happen from Short URLs and tracking links that act as a gateway
        - Extensions don't provide a way to history crawl for tabs, we could inject content scripts to do this
            however they don't run on about:blank so this would likely be just as hacky.
        We capture the time the tab was created and close if it was within the timeout to try to capture pages which haven't had user interaction or history.
    */
    if (removeTab) {
      browser.tabs.remove(tab.id);
    }
    return {
      cancel: true,
    };
  },

  init() {
    browser.contextMenus.onClicked.addListener((info, tab) => {
      this._onClickedHandler(info, tab);
    });

    // Before a request is handled by the browser we decide if we should route through a different container
    this.canceledRequests = {};
    browser.webRequest.onBeforeRequest.addListener(
      options => {
        return this.onBeforeRequest(options);
      },
      { urls: ['<all_urls>'], types: ['main_frame'] },
      ['blocking']
    );

    // Clean up canceled requests
    browser.webRequest.onCompleted.addListener(
      options => {
        if (this.canceledRequests[options.tabId]) {
          delete this.canceledRequests[options.tabId];
        }
      },
      { urls: ['<all_urls>'], types: ['main_frame'] }
    );
    browser.webRequest.onErrorOccurred.addListener(
      options => {
        if (this.canceledRequests[options.tabId]) {
          delete this.canceledRequests[options.tabId];
        }
      },
      { urls: ['<all_urls>'], types: ['main_frame'] }
    );
  },

  async _onClickedHandler(info, tab) {
    const userContextId = this.getUserContextIdFromCookieStore(tab);
    // Mapping ${URL(info.pageUrl).hostname} to ${userContextId}
    let remove;
    if (userContextId) {
      switch (info.menuItemId) {
        case this.MENU_ASSIGN_ID:
        case this.MENU_REMOVE_ID:
          if (info.menuItemId === this.MENU_ASSIGN_ID) {
            remove = false;
          } else {
            remove = true;
          }
          await this._setOrRemoveAssignment(tab.id, info.pageUrl, userContextId, remove);
          break;
        case this.MENU_MOVE_ID:
          backgroundLogic.moveTabsToWindow({
            cookieStoreId: tab.cookieStoreId,
            windowId: tab.windowId,
          });
          break;
        case this.MENU_HIDE_ID:
          backgroundLogic.hideTabs({
            cookieStoreId: tab.cookieStoreId,
            windowId: tab.windowId,
          });
          break;
      }
    }
  },

  deleteContainer(userContextId) {
    this.storageArea.deleteContainer(userContextId);
  },

  getUserContextIdFromCookieStore(tab) {
    if (!('cookieStoreId' in tab)) {
      return false;
    }
    return backgroundLogic.getUserContextIdFromCookieStoreId(tab.cookieStoreId);
  },

  isTabPermittedAssign(tab) {
    // Ensure we are not an important about url
    // Ensure we are not in incognito mode
    const url = new URL(tab.url);
    if (url.protocol === 'about:' || url.protocol === 'moz-extension:' || tab.incognito) {
      return false;
    }
    return true;
  },

  async _setOrRemoveAssignment(tabId, pageUrl, userContextId, remove) {
    let actionName;

    // https://github.com/mozilla/testpilot-containers/issues/626
    // Context menu has stored context IDs as strings, so we need to coerce
    // the value to a string for accurate checking
    userContextId = String(userContextId);

    if (!remove) {
      const tabs = await browser.tabs.query({});
      const assignmentStoreKey = this.storageArea.getSiteStoreKey(pageUrl);
      const exemptedTabIds = tabs
        .filter(tab => {
          const tabStoreKey = this.storageArea.getSiteStoreKey(tab.url);
          /* Auto exempt all tabs that exist for this hostname that are not in the same container */
          if (tabStoreKey === assignmentStoreKey && this.getUserContextIdFromCookieStore(tab) !== userContextId) {
            return true;
          }
          return false;
        })
        .map(tab => {
          return tab.id;
        });

      await this.storageArea.set(
        pageUrl,
        {
          userContextId,
          neverAsk: false,
        },
        exemptedTabIds
      );
      actionName = 'added';
    } else {
      await this.storageArea.remove(pageUrl);
      actionName = 'removed';
    }
    browser.tabs.sendMessage(tabId, {
      text: `Successfully ${actionName} site to always open in this container`,
    });
    const tab = await browser.tabs.get(tabId);
    this.calculateContextMenu(tab);
  },

  async _getAssignment(tab) {
    const cookieStore = this.getUserContextIdFromCookieStore(tab);
    // Ensure we have a cookieStore to assign to
    if (cookieStore && this.isTabPermittedAssign(tab)) {
      return await this.storageArea.get(tab.url);
    }
    return false;
  },

  _getByContainer(userContextId) {
    return this.storageArea.getByContainer(userContextId);
  },

  removeContextMenu() {
    // There is a focus issue in this menu where if you change window with a context menu click
    // you get the wrong menu display because of async
    // See: https://bugzilla.mozilla.org/show_bug.cgi?id=1215376#c16
    // We also can't change for always private mode
    // See: https://bugzilla.mozilla.org/show_bug.cgi?id=1352102
    browser.contextMenus.remove(this.MENU_ASSIGN_ID);
    browser.contextMenus.remove(this.MENU_REMOVE_ID);
    browser.contextMenus.remove(this.MENU_SEPARATOR_ID);
    browser.contextMenus.remove(this.MENU_HIDE_ID);
    browser.contextMenus.remove(this.MENU_MOVE_ID);
  },

  async calculateContextMenu(tab) {
    this.removeContextMenu();
    const siteSettings = await this._getAssignment(tab);
    // Return early and not add an item if we have false
    // False represents assignment is not permitted
    if (siteSettings === false) {
      return false;
    }
    let checked = false;
    let menuId = this.MENU_ASSIGN_ID;
    const tabUserContextId = this.getUserContextIdFromCookieStore(tab);
    if (siteSettings && Number(siteSettings.userContextId) === Number(tabUserContextId)) {
      checked = true;
      menuId = this.MENU_REMOVE_ID;
    }
    browser.contextMenus.create({
      id: menuId,
      title: 'Always Open in This Container',
      checked,
      type: 'checkbox',
      contexts: ['all'],
    });

    browser.contextMenus.create({
      id: this.MENU_SEPARATOR_ID,
      type: 'separator',
      contexts: ['all'],
    });

    browser.contextMenus.create({
      id: this.MENU_HIDE_ID,
      title: 'Hide This Container',
      contexts: ['all'],
    });

    browser.contextMenus.create({
      id: this.MENU_MOVE_ID,
      title: 'Move Tabs to a New Window',
      contexts: ['all'],
    });
  },

  encodeURLProperty(url) {
    return encodeURIComponent(url).replace(/[!'()*]/g, c => {
      const charCode = c.charCodeAt(0).toString(16);
      return `%${charCode}`;
    });
  },

  reloadPageInContainer(url, currentUserContextId, userContextId, index, active, neverAsk = false, openerTabId = null) {
    const cookieStoreId = backgroundLogic.cookieStoreId(userContextId);
    const loadPage = browser.extension.getURL('confirm-page.html');
    // False represents assignment is not permitted
    // If the user has explicitly checked "Never Ask Again" on the warning page we will send them straight there
    if (neverAsk) {
      browser.tabs.create({ url, cookieStoreId, index, active, openerTabId });
    } else {
      let confirmUrl = `${loadPage}?url=${this.encodeURLProperty(url)}&cookieStoreId=${cookieStoreId}`;
      let currentCookieStoreId;
      if (currentUserContextId) {
        currentCookieStoreId = backgroundLogic.cookieStoreId(currentUserContextId);
        confirmUrl += `&currentCookieStoreId=${currentCookieStoreId}`;
      }
      browser.tabs
        .create({
          url: confirmUrl,
          cookieStoreId: currentCookieStoreId,
          openerTabId,
          index,
          active,
        })
        .then(() => {
          // We don't want to sync this URL ever nor clutter the users history
          browser.history.deleteUrl({ url: confirmUrl });
        })
        .catch(e => {
          throw e;
        });
    }
  },
};

assignManager.init();

///////////////////////////

const MAJOR_VERSIONS = ['2.3.0', '2.4.0'];
const badge = {
  async init() {
    const currentWindow = await browser.windows.getCurrent();
    this.displayBrowserActionBadge(currentWindow.incognito);
  },

  disableAddon(tabId) {
    browser.browserAction.disable(tabId);
    browser.browserAction.setTitle({ tabId, title: 'Containers disabled in Private Browsing Mode' });
  },

  async displayBrowserActionBadge() {
    const extensionInfo = await backgroundLogic.getExtensionInfo();
    const storage = await browser.storage.local.get({ browserActionBadgesClicked: [] });

    if (
      MAJOR_VERSIONS.indexOf(extensionInfo.version) > -1 &&
      storage.browserActionBadgesClicked.indexOf(extensionInfo.version) < 0
    ) {
      browser.browserAction.setBadgeBackgroundColor({ color: 'rgba(0,217,0,255)' });
      browser.browserAction.setBadgeText({ text: 'NEW' });
    }
  },
};

badge.init();

///////////////////////////

const identityState = {
  storageArea: {
    area: browser.storage.local,

    getContainerStoreKey(cookieStoreId) {
      const storagePrefix = 'identitiesState@@_';
      return `${storagePrefix}${cookieStoreId}`;
    },

    async get(cookieStoreId) {
      const storeKey = this.getContainerStoreKey(cookieStoreId);
      const storageResponse = await this.area.get([storeKey]);
      if (storageResponse && storeKey in storageResponse) {
        return storageResponse[storeKey];
      }
      const defaultContainerState = identityState._createIdentityState();
      await this.set(cookieStoreId, defaultContainerState);

      return defaultContainerState;
    },

    set(cookieStoreId, data) {
      const storeKey = this.getContainerStoreKey(cookieStoreId);
      return this.area.set({
        [storeKey]: data,
      });
    },

    remove(cookieStoreId) {
      const storeKey = this.getContainerStoreKey(cookieStoreId);
      return this.area.remove([storeKey]);
    },
  },

  _createTabObject(tab) {
    return Object.assign({}, tab);
  },

  async storeHidden(cookieStoreId, windowId) {
    const containerState = await this.storageArea.get(cookieStoreId);
    const tabsByContainer = await browser.tabs.query({ cookieStoreId, windowId });
    tabsByContainer.forEach(tab => {
      const tabObject = this._createTabObject(tab);
      if (!backgroundLogic.isPermissibleURL(tab.url)) {
        return;
      }
      // This tab is going to be closed. Let's mark this tabObject as
      // non-active.
      tabObject.active = false;
      tabObject.hiddenState = true;
      containerState.hiddenTabs.push(tabObject);
    });

    return this.storageArea.set(cookieStoreId, containerState);
  },

  _createIdentityState() {
    return {
      hiddenTabs: [],
    };
  },
};

////////////////////////////

const messageHandler = {
  // After the timer completes we assume it's a tab the user meant to keep open
  // We use this to catch redirected tabs that have just opened
  // If this were in platform we would change how the tab opens based on "new tab" link navigations such as ctrl+click
  LAST_CREATED_TAB_TIMER: 2000,

  init() {
    // Handles messages from webextension code
    browser.runtime.onMessage.addListener(m => {
      let response;

      switch (m.method) {
        case 'deleteContainer':
          response = backgroundLogic.deleteContainer(m.message.userContextId);
          break;
        case 'createOrUpdateContainer':
          response = backgroundLogic.createOrUpdateContainer(m.message);
          break;
        case 'neverAsk':
          assignManager._neverAsk(m);
          break;
        case 'getAssignment':
          response = browser.tabs.get(m.tabId).then(tab => {
            return assignManager._getAssignment(tab);
          });
          break;
        case 'getAssignmentObjectByContainer':
          response = assignManager._getByContainer(m.message.userContextId);
          break;
        case 'setOrRemoveAssignment':
          // m.tabId is used for where to place the in content message
          // m.url is the assignment to be removed/added
          response = browser.tabs.get(m.tabId).then(tab => {
            return assignManager._setOrRemoveAssignment(tab.id, m.url, m.userContextId, m.value);
          });
          break;
        case 'sortTabs':
          backgroundLogic.sortTabs();
          break;
        case 'showTabs':
          backgroundLogic.unhideContainer(m.cookieStoreId);
          break;
        case 'hideTabs':
          backgroundLogic.hideTabs({
            cookieStoreId: m.cookieStoreId,
            windowId: m.windowId,
          });
          break;
        case 'checkIncompatibleAddons':
          // TODO
          break;
        case 'moveTabsToWindow':
          response = backgroundLogic.moveTabsToWindow({
            cookieStoreId: m.cookieStoreId,
            windowId: m.windowId,
          });
          break;
        case 'getTabs':
          response = backgroundLogic.getTabs({
            cookieStoreId: m.cookieStoreId,
            windowId: m.windowId,
          });
          break;
        case 'queryIdentitiesState':
          response = backgroundLogic.queryIdentitiesState(m.message.windowId);
          break;
        case 'exemptContainerAssignment':
          response = assignManager._exemptTab(m);
          break;
      }
      return response;
    });

    // Handles external messages from webextensions
    const externalExtensionAllowed = {};
    browser.runtime.onMessageExternal.addListener(async (message, sender) => {
      if (!externalExtensionAllowed[sender.id]) {
        const extensionInfo = await browser.management.get(sender.id);
        if (!extensionInfo.permissions.includes('contextualIdentities')) {
          throw new Error('Missing contextualIdentities permission');
        }
        externalExtensionAllowed[sender.id] = true;
      }
      let response;
      switch (message.method) {
        case 'getAssignment':
          if (typeof message.url === 'undefined') {
            throw new Error('Missing message.url');
          }
          response = assignManager.storageArea.get(message.url);
          break;
        default:
          throw new Error('Unknown message.method');
      }
      return response;
    });
    // Delete externalExtensionAllowed if add-on installs/updates; permissions might change
    browser.management.onInstalled.addListener(extensionInfo => {
      if (externalExtensionAllowed[extensionInfo.id]) {
        delete externalExtensionAllowed[extensionInfo.id];
      }
    });
    // Delete externalExtensionAllowed if add-on uninstalls; not needed anymore
    browser.management.onUninstalled.addListener(extensionInfo => {
      if (externalExtensionAllowed[extensionInfo.id]) {
        delete externalExtensionAllowed[extensionInfo.id];
      }
    });

    if (browser.contextualIdentities.onRemoved) {
      browser.contextualIdentities.onRemoved.addListener(({ contextualIdentity }) => {
        const userContextId = backgroundLogic.getUserContextIdFromCookieStoreId(contextualIdentity.cookieStoreId);
        backgroundLogic.deleteContainer(userContextId, true);
      });
    }

    browser.tabs.onActivated.addListener(info => {
      assignManager.removeContextMenu();
      browser.tabs
        .get(info.tabId)
        .then(tab => {
          assignManager.calculateContextMenu(tab);
        })
        .catch(e => {
          throw e;
        });
    });

    browser.windows.onFocusChanged.addListener(windowId => {
      this.onFocusChangedCallback(windowId);
    });

    browser.webRequest.onCompleted.addListener(
      details => {
        if (details.frameId !== 0 || details.tabId === -1) {
          return {};
        }
        assignManager.removeContextMenu();

        browser.tabs
          .get(details.tabId)
          .then(tab => {
            assignManager.calculateContextMenu(tab);
          })
          .catch(e => {
            throw e;
          });
      },
      { urls: ['<all_urls>'], types: ['main_frame'] }
    );

    browser.tabs.onCreated.addListener(tab => {
      if (tab.incognito) {
        badge.disableAddon(tab.id);
      }
      // lets remember the last tab created so we can close it if it looks like a redirect
      this.lastCreatedTab = tab;
      if (tab.cookieStoreId) {
        // Don't count firefox-default, firefox-private, nor our own confirm page loads
        if (
          tab.cookieStoreId !== 'firefox-default' &&
          tab.cookieStoreId !== 'firefox-private' &&
          !tab.url.startsWith('moz-extension')
        ) {
          // increment the counter of container tabs opened
          this.incrementCountOfContainerTabsOpened();
        }

        backgroundLogic.unhideContainer(tab.cookieStoreId);
      }
      setTimeout(() => {
        this.lastCreatedTab = null;
      }, this.LAST_CREATED_TAB_TIMER);
    });
  },

  async incrementCountOfContainerTabsOpened() {
    const key = 'containerTabsOpened';
    const count = await browser.storage.local.get({ [key]: 0 });
    const countOfContainerTabsOpened = ++count[key];
    browser.storage.local.set({ [key]: countOfContainerTabsOpened });

    // When the user opens their _ tab, give them the achievement
    if (countOfContainerTabsOpened === 100) {
      const storage = await browser.storage.local.get({ achievements: [] });
      storage.achievements.push({ name: 'manyContainersOpened', done: false });
      // use set and spread to create a unique array
      const achievements = [...new Set(storage.achievements)];
      browser.storage.local.set({ achievements });
      browser.browserAction.setBadgeBackgroundColor({ color: 'rgba(0,217,0,255)' });
      browser.browserAction.setBadgeText({ text: 'NEW' });
    }
  },

  async onFocusChangedCallback(windowId) {
    assignManager.removeContextMenu();
    // browserAction loses background color in new windows ...
    // https://bugzil.la/1314674
    // https://github.com/mozilla/testpilot-containers/issues/608
    // ... so re-call displayBrowserActionBadge on window changes
    badge.displayBrowserActionBadge();
    browser.tabs
      .query({ active: true, windowId })
      .then(tabs => {
        if (tabs && tabs[0]) {
          assignManager.calculateContextMenu(tabs[0]);
        }
      })
      .catch(e => {
        throw e;
      });
  },
};

// Lets do this last as theme manager did a check before connecting before
messageHandler.init();
