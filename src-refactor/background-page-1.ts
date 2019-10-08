function isPermissibleURL(url: string | undefined): boolean {
  if (!url) {
    return false;
  }
  const protocol = new URL(url).protocol;
  // We can't open these we just have to throw them away
  if (protocol === 'about:' || protocol === 'chrome:' || protocol === 'moz-extension:') {
    return false;
  }
  return true;
}

const DEFAULT_TAB = 'about:newtab';
const NEW_TAB_PAGES = new Set(['about:startpage', 'about:newtab', 'about:home', 'about:blank']);
const unhideQueue: string[] = [];

async function getExtensionInfo() {
  const manifestPath = browser.extension.getURL('manifest.json');
  const response = await fetch(manifestPath);
  const extensionInfo = await response.json();
  return extensionInfo;
}

function getUserContextIdFromCookieStoreId(cookieStoreId: string): undefined | string {
  if (!cookieStoreId) {
    return undefined;
  }
  const container = cookieStoreId.replace('firefox-container-', '');
  if (container !== cookieStoreId) {
    return container;
  }
  return undefined;
}

async function deleteContainer(userContextId: string, removed = false): Promise<{ done: true; userContextId: string }> {
  await _closeTabs(userContextId);
  if (!removed) {
    await browser.contextualIdentities.remove(getCookieStoreId(userContextId));
  }
  storageAreaDeleteContainer(userContextId);
  return { done: true, userContextId };
}

interface createOrUpdateContainerOptions {
  userContextId: string;
  params: { name: string; color: string; icon: string };
}

async function createOrUpdateContainer(options: createOrUpdateContainerOptions): Promise<void> {
  let donePromise: Promise<browser.contextualIdentities.ContextualIdentity>;
  if (options.userContextId !== 'new') {
    donePromise = browser.contextualIdentities.update(getCookieStoreId(options.userContextId), options.params);
  } else {
    donePromise = browser.contextualIdentities.create(options.params);
  }
  await donePromise;
  browser.runtime.sendMessage({
    method: 'refreshNeeded',
  });
}

interface OpenNewTabOptions {
  userContextId?: string;
  url?: string;
  nofocus?: boolean;
  pinned?: boolean;
}

async function openNewTab(options: OpenNewTabOptions): Promise<browser.tabs.Tab | undefined> {
  let url = options.url || undefined;
  const userContextId = options.userContextId || '0';
  const active = 'nofocus' in options ? options.nofocus : true;

  const cookieStoreId = getCookieStoreId(userContextId);
  // Autofocus url bar will happen in 54: https://bugzilla.mozilla.org/show_bug.cgi?id=1295072

  // We can't open new tab pages, so open a blank tab. Used in tab un-hide
  if (url && NEW_TAB_PAGES.has(url)) {
    url = undefined;
  }

  if (!isPermissibleURL(url)) {
    return;
  }

  return browser.tabs.create({
    url,
    active,
    pinned: options.pinned || false,
    cookieStoreId,
  });
}

function checkArgs<T extends object, K extends keyof T>(
  requiredArguments: K[],
  options: T,
  methodName: string
): Required<Pick<T, K>> {
  for (const arg of requiredArguments) {
    if (!(arg in options) || !options[arg]) {
      throw new Error(`${methodName} must be called with ${arg} argument.`);
    }
  }
  return options as any;
}

async function getTabs(options: browser.tabs.Tab): Promise<browser.tabs.Tab[]> {
  const { cookieStoreId, windowId } = checkArgs(['cookieStoreId', 'windowId'], options, 'getTabs');

  const tabs = await browser.tabs.query({ cookieStoreId, windowId });
  const list = tabs.map(_createTabObject);

  const containerState = await identityStateGet(cookieStoreId);
  return list.concat(containerState.hiddenTabs);
}

async function unhideContainer(cookieStoreId: string): Promise<void> {
  if (cookieStoreId && !unhideQueue.includes(cookieStoreId)) {
    unhideQueue.push(cookieStoreId);
    await showTabs({ cookieStoreId });
    unhideQueue.splice(unhideQueue.indexOf(cookieStoreId), 1);
  }
}

async function moveTabsToWindow(options: browser.tabs.Tab): Promise<void> {
  const { cookieStoreId, windowId } = checkArgs(['cookieStoreId', 'windowId'], options, 'moveTabsToWindow');

  const list = await browser.tabs.query({
    cookieStoreId,
    windowId,
  });

  const containerState = await identityStateGet(cookieStoreId);

  // Nothing to do
  if (list.length === 0 && containerState.hiddenTabs.length === 0) {
    return;
  }
  let newWindowObj;
  let hiddenDefaultTabToClose;
  if (list.length) {
    newWindowObj = await browser.windows.create();

    if (!newWindowObj) {
      throw new Error('Could not create window');
    }

    // Pin the default tab in the new window so existing pinned tabs can be moved after it.
    // From the docs (https://developer.mozilla.org/en-US/Add-ons/WebExtensions/API/tabs/move):
    //   Note that you can't move pinned tabs to a position after any unpinned tabs in a window, or move any unpinned tabs to a position before any pinned tabs.

    const firstTab = newWindowObj.tabs && newWindowObj.tabs[0];

    if (!firstTab || firstTab.id == null) {
      throw new Error('First tab does not exist');
    }

    await browser.tabs.update(firstTab.id, { pinned: true });

    browser.tabs.move(list.map(tab => tab.id).filter((f): f is number => f != null), {
      windowId: newWindowObj.id,
      index: -1,
    });
  } else {
    //As we get a blank tab here we will need to await the tabs creation
    newWindowObj = await browser.windows.create({});
    hiddenDefaultTabToClose = true;

    if (!newWindowObj) {
      throw new Error('new window obj is undefined');
    }
  }

  const showHiddenPromises = [];

  // Let's show the hidden tabs.
  if (!unhideQueue.includes(cookieStoreId)) {
    unhideQueue.push(cookieStoreId);
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
    if (tab.cookieStoreId !== cookieStoreId && tab.id != null) {
      browser.tabs.remove(tab.id);
    }
  }
  const rv = await identityStateSet(cookieStoreId, containerState);
  unhideQueue.splice(unhideQueue.indexOf(cookieStoreId), 1);
  return rv;
}

async function _closeTabs(userContextId: string, windowId: number | false = false) {
  const cookieStoreId = getCookieStoreId(userContextId);
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
  const tabIds = tabs.map(tab => tab.id).filter((f): f is number => f != null);
  return browser.tabs.remove(tabIds);
}

interface IdentitiesState {
  hasHiddenTabs: boolean;
  hasOpenTabs: boolean;
  numberOfHiddenTabs: number;
  numberOfOpenTabs: number;
}

async function queryIdentitiesState(windowId: number): Promise<Record<string, IdentitiesState>> {
  const identities = await browser.contextualIdentities.query({});
  const identitiesOutput: Record<string, IdentitiesState> = {};
  const identitiesPromise = identities.map(async identity => {
    const { cookieStoreId } = identity;
    const containerState = await identityStateGet(cookieStoreId);
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
}

async function sortTabs() {
  const windows = await browser.windows.getAll();
  for (let windowObj of windows) {
    // eslint-disable-line prefer-const
    // First the pinned tabs, then the normal ones.
    await _sortTabsInternal(windowObj, true);
    await _sortTabsInternal(windowObj, false);
  }
}

async function _sortTabsInternal(windowObj: browser.windows.Window, pinnedTabs: boolean) {
  const tabs = await browser.tabs.query({ windowId: windowObj.id });
  let pos = 0;

  // Let's collect UCIs/tabs for this window.
  const map = new Map<string, browser.tabs.Tab[]>();
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

    if (!tab.cookieStoreId) {
      continue;
    }

    const userContextId = getUserContextIdFromCookieStoreId(tab.cookieStoreId);
    if (userContextId) {
      if (!map.has(userContextId)) {
        map.set(userContextId, []);
      }
      map.get(userContextId)!.push(tab);
    }
  }

  // Let's sort the map.
  const sortMap = new Map([...map.entries()].sort((a, b) => a[0].localeCompare(b[0])));

  // Let's move tabs.
  sortMap.forEach(tabs => {
    for (const tab of tabs) {
      if (tab.id == null) {
        continue;
      }
      ++pos;
      browser.tabs.move(tab.id, {
        windowId: windowObj.id,
        index: pos,
      });
    }
  });
}

async function hideTabs(options: browser.tabs.Tab): Promise<void> {
  const { cookieStoreId, windowId } = checkArgs(['cookieStoreId', 'windowId'], options, 'hideTabs');

  const userContextId = getUserContextIdFromCookieStoreId(cookieStoreId);

  if (!userContextId) {
    throw new Error('no userContextId!');
  }

  const containerState = await storeHidden(cookieStoreId, windowId);
  await _closeTabs(userContextId, windowId);

  return containerState;
}

interface ShowTabsOptions {
  cookieStoreId: string;
  nofocus?: boolean;
}

async function showTabs(options: ShowTabsOptions): Promise<void> {
  const userContextId = getUserContextIdFromCookieStoreId(options.cookieStoreId);
  const promises = [];

  const containerState = await identityStateGet(options.cookieStoreId);

  for (let object of containerState.hiddenTabs) {
    // eslint-disable-line prefer-const
    promises.push(
      openNewTab({
        userContextId: userContextId,
        url: object.url,
        nofocus: options.nofocus || false,
        pinned: object.pinned,
      })
    );
  }

  containerState.hiddenTabs = [];

  await Promise.all(promises);
  return await identityStateSet(options.cookieStoreId, containerState);
}

function getCookieStoreId(userContextId: string): string {
  return `firefox-container-${userContextId}`;
}

///////////////////

function getSiteStoreKey(pageUrl: string | undefined): string {
  if (!pageUrl) {
    return '';
  }
  const url = new window.URL(pageUrl);
  const storagePrefix = 'siteContainerMap@@_';
  if (url.port === '80' || url.port === '443') {
    return `${storagePrefix}${url.hostname}`;
  } else {
    return `${storagePrefix}${url.hostname}${url.port}`;
  }
}

const MENU_ASSIGN_ID = 'open-in-this-container';
const MENU_REMOVE_ID = 'remove-open-in-this-container';
const MENU_SEPARATOR_ID = 'separator';
const MENU_HIDE_ID = 'hide-container';
const MENU_MOVE_ID = 'move-to-new-window-container';

const exemptedTabs: Record<string, number[]> = {};

function setExempted(pageUrl: string, tabId: number): void {
  const siteStoreKey = getSiteStoreKey(pageUrl);
  if (!(siteStoreKey in exemptedTabs)) {
    exemptedTabs[siteStoreKey] = [];
  }
  exemptedTabs[siteStoreKey].push(tabId);
}

function removeExempted(pageUrl: string): void {
  const siteStoreKey = getSiteStoreKey(pageUrl);
  exemptedTabs[siteStoreKey] = [];
}

function isExempted(pageUrl: string, tabId: number | undefined): boolean {
  if (tabId == null) {
    return false;
  }
  const siteStoreKey = getSiteStoreKey(pageUrl);
  if (!(siteStoreKey in exemptedTabs)) {
    return false;
  }
  return exemptedTabs[siteStoreKey].includes(tabId);
}

function storageAreaGet(pageUrl: string | undefined): Promise<any> {
  if (!pageUrl) {
    return Promise.reject('No page url');
  }
  const siteStoreKey = getSiteStoreKey(pageUrl);
  return new Promise((resolve, reject) => {
    browser.storage.local
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
}

function storageAreaSet(pageUrl: string, data: any, exemptedTabIds?: (number | undefined)[]) {
  const siteStoreKey = getSiteStoreKey(pageUrl);
  if (exemptedTabIds) {
    exemptedTabIds.forEach(tabId => {
      if (tabId != null) {
        setExempted(pageUrl, tabId);
      }
    });
  }
  return browser.storage.local.set({
    [siteStoreKey]: data,
  });
}

function storageAreaRemove(pageUrl: string): Promise<void> {
  const siteStoreKey = getSiteStoreKey(pageUrl);
  // When we remove an assignment we should clear all the exemptions
  removeExempted(pageUrl);
  return browser.storage.local.remove([siteStoreKey]);
}

async function storageAreaDeleteContainer(userContextId: string) {
  const sitesByContainer = await getByContainer(userContextId);
  browser.storage.local.remove(Object.keys(sitesByContainer));
}

interface ThingConfig {
  hostname: string;
  userContextId: string;
}

async function getByContainer(userContextId: string) {
  const sites: Record<string, ThingConfig> = {};
  const siteConfigs: Record<string, ThingConfig> = await browser.storage.local.get();
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
}

function _neverAsk(m: any) {
  const pageUrl = m.pageUrl;
  if (m.neverAsk === true) {
    // If we have existing data and for some reason it hasn't been deleted etc lets update it
    storageAreaGet(pageUrl)
      .then(siteSettings => {
        if (siteSettings) {
          siteSettings.neverAsk = true;
          storageAreaSet(pageUrl, siteSettings);
        }
      })
      .catch(e => {
        throw e;
      });
  }
}

// We return here so the confirm page can load the tab when exempted
async function _exemptTab(m: any) {
  const pageUrl = m.pageUrl;
  setExempted(pageUrl, m.tabId);
  return true;
}

interface OnBeforeRequestOptions {
  requestId: string;
  url: string;
  method: string;
  frameId: number;
  parentFrameId: number;
  originUrl?: string | undefined;
  documentUrl?: string | undefined;
  requestBody?:
    | {
        error?: string | undefined;
        formData?: object | undefined;
        raw?: browser.webRequest.UploadData[] | undefined;
      }
    | undefined;
  tabId: number;
  type: browser.webRequest.ResourceType;
  timeStamp: number;
}

// Before a request is handled by the browser we decide if we should route through a different container
async function onBeforeRequest(options: OnBeforeRequestOptions) {
  if (options.frameId !== 0 || options.tabId === -1) {
    return {};
  }
  removeContextMenu();
  const [tab, siteSettings] = await Promise.all([browser.tabs.get(options.tabId), storageAreaGet(options.url)]);
  let container: false | browser.contextualIdentities.ContextualIdentity = false;
  if (siteSettings) {
    try {
      container = await browser.contextualIdentities.get(getCookieStoreId(siteSettings.userContextId));
    } catch (e) {
      //
    }
  }

  // The container we have in the assignment map isn't present any more so lets remove it
  //   then continue the existing load
  if (siteSettings && !container) {
    deleteContainer(siteSettings.userContextId);
    return {};
  }
  const userContextId = getUserContextIdFromCookieStore(tab);
  if (
    !userContextId ||
    !siteSettings ||
    userContextId === siteSettings.userContextId ||
    tab.incognito ||
    isExempted(options.url, tab.id)
  ) {
    return {};
  }
  const removeTab = (tab.url && NEW_TAB_PAGES.has(tab.url)) || (lastCreatedTab && lastCreatedTab.id === tab.id);
  const openTabId = removeTab ? tab.openerTabId : tab.id;

  if (tab.id == null) {
    throw new Error('tab ID is undefined or null');
  }

  if (!canceledRequests[tab.id]) {
    // we decided to cancel the request at this point, register canceled request
    canceledRequests[tab.id] = {
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
      if (tab.id != null && canceledRequests[tab.id]) {
        delete canceledRequests[tab.id];
      }
    }, 2000);
  } else {
    let cancelEarly = false;
    if (canceledRequests[tab.id].requestIds[options.requestId] || canceledRequests[tab.id].urls[options.url]) {
      // same requestId or url from the same tab
      // this is a redirect that we have to cancel early to prevent opening two tabs
      cancelEarly = true;
    }
    // we decided to cancel the request at this point, register canceled request
    canceledRequests[tab.id].requestIds[options.requestId] = true;
    canceledRequests[tab.id].urls[options.url] = true;
    if (cancelEarly) {
      return {
        cancel: true,
      };
    }
  }

  reloadPageInContainer(
    options.url,
    userContextId,
    siteSettings.userContextId,
    tab.index + 1,
    tab.active,
    siteSettings.neverAsk,
    openTabId
  );

  calculateContextMenu(tab);

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
}

browser.contextMenus.onClicked.addListener(_onClickedHandler);

// Before a request is handled by the browser we decide if we should route through a different container
const canceledRequests: Record<number, { requestIds: Record<string, boolean>; urls: Record<string, boolean> }> = {};

browser.webRequest.onBeforeRequest.addListener(onBeforeRequest, { urls: ['<all_urls>'], types: ['main_frame'] }, [
  'blocking',
]);

// Clean up canceled requests
browser.webRequest.onCompleted.addListener(
  options => {
    if (canceledRequests[options.tabId]) {
      delete canceledRequests[options.tabId];
    }
  },
  { urls: ['<all_urls>'], types: ['main_frame'] }
);

browser.webRequest.onErrorOccurred.addListener(
  options => {
    if (canceledRequests[options.tabId]) {
      delete canceledRequests[options.tabId];
    }
  },
  { urls: ['<all_urls>'], types: ['main_frame'] }
);

async function _onClickedHandler(info: browser.contextMenus.OnClickData, tab?: browser.tabs.Tab) {
  if (!tab || !tab.id) {
    throw new Error('_onClickedHandler did not get a tab');
  }

  const userContextId = getUserContextIdFromCookieStore(tab);
  // Mapping ${URL(info.pageUrl).hostname} to ${userContextId}
  let remove;
  if (userContextId) {
    switch (info.menuItemId) {
      case MENU_ASSIGN_ID:
      case MENU_REMOVE_ID:
        if (info.menuItemId === MENU_ASSIGN_ID) {
          remove = false;
        } else {
          remove = true;
        }
        if (!info.pageUrl) {
          throw new Error('info.pageUrl is falsey');
        }

        await _setOrRemoveAssignment(tab.id, info.pageUrl, userContextId, remove);

        break;
      case MENU_MOVE_ID:
        moveTabsToWindow(tab);
        break;
      case MENU_HIDE_ID:
        hideTabs(tab);
        break;
    }
  }
}

function assignManagerDeleteContainer(userContextId: string): void {
  storageAreaDeleteContainer(userContextId);
}

function getUserContextIdFromCookieStore(tab: browser.tabs.Tab): false | string | undefined {
  if (!tab.cookieStoreId) {
    return false;
  }
  return getUserContextIdFromCookieStoreId(tab.cookieStoreId);
}

function isTabPermittedAssign(tab: browser.tabs.Tab): boolean {
  if (!tab.url) {
    return false;
  }
  // Ensure we are not an important about url
  // Ensure we are not in incognito mode
  const url = new URL(tab.url);
  if (url.protocol === 'about:' || url.protocol === 'moz-extension:' || tab.incognito) {
    return false;
  }
  return true;
}

async function _setOrRemoveAssignment(tabId: number, pageUrl: string, userContextId: string, remove: boolean) {
  let actionName;

  // https://github.com/mozilla/testpilot-containers/issues/626
  // Context menu has stored context IDs as strings, so we need to coerce
  // the value to a string for accurate checking
  userContextId = String(userContextId);

  if (!remove) {
    const tabs = await browser.tabs.query({});
    const assignmentStoreKey = getSiteStoreKey(pageUrl);
    const exemptedTabIds = tabs
      .filter(tab => {
        const tabStoreKey = getSiteStoreKey(tab.url);
        /* Auto exempt all tabs that exist for this hostname that are not in the same container */
        if (tabStoreKey === assignmentStoreKey && getUserContextIdFromCookieStore(tab) !== userContextId) {
          return true;
        }
        return false;
      })
      .map(tab => tab.id);

    await storageAreaSet(
      pageUrl,
      {
        userContextId,
        neverAsk: false,
      },
      exemptedTabIds
    );
    actionName = 'added';
  } else {
    await storageAreaRemove(pageUrl);
    actionName = 'removed';
  }
  browser.tabs.sendMessage(tabId, {
    text: `Successfully ${actionName} site to always open in this container`,
  });
  const tab = await browser.tabs.get(tabId);
  calculateContextMenu(tab);
}

async function _getAssignment(tab: browser.tabs.Tab) {
  const cookieStore = getUserContextIdFromCookieStore(tab);
  // Ensure we have a cookieStore to assign to
  if (cookieStore && isTabPermittedAssign(tab)) {
    return await storageAreaGet(tab.url);
  }
  return false;
}

function _getByContainer(userContextId: string) {
  return getByContainer(userContextId);
}

function removeContextMenu() {
  // There is a focus issue in this menu where if you change window with a context menu click
  // you get the wrong menu display because of async
  // See: https://bugzilla.mozilla.org/show_bug.cgi?id=1215376#c16
  // We also can't change for always private mode
  // See: https://bugzilla.mozilla.org/show_bug.cgi?id=1352102
  browser.contextMenus.remove(MENU_ASSIGN_ID);
  browser.contextMenus.remove(MENU_REMOVE_ID);
  browser.contextMenus.remove(MENU_SEPARATOR_ID);
  browser.contextMenus.remove(MENU_HIDE_ID);
  browser.contextMenus.remove(MENU_MOVE_ID);
}

async function calculateContextMenu(tab: browser.tabs.Tab): Promise<void> {
  removeContextMenu();
  const siteSettings = await _getAssignment(tab);
  // Return early and not add an item if we have false
  // False represents assignment is not permitted
  if (siteSettings === false) {
    return;
  }

  let checked = false;
  let menuId = MENU_ASSIGN_ID;
  const tabUserContextId = getUserContextIdFromCookieStore(tab);
  if (siteSettings && Number(siteSettings.userContextId) === Number(tabUserContextId)) {
    checked = true;
    menuId = MENU_REMOVE_ID;
  }
  browser.contextMenus.create({
    id: menuId,
    title: 'Always Open in This Container',
    checked,
    type: 'checkbox',
    contexts: ['all'],
  });

  browser.contextMenus.create({
    id: MENU_SEPARATOR_ID,
    type: 'separator',
    contexts: ['all'],
  });

  browser.contextMenus.create({
    id: MENU_HIDE_ID,
    title: 'Hide This Container',
    contexts: ['all'],
  });

  browser.contextMenus.create({
    id: MENU_MOVE_ID,
    title: 'Move Tabs to a New Window',
    contexts: ['all'],
  });
}

function encodeURLProperty(url: string): string {
  return encodeURIComponent(url).replace(/[!'()*]/g, c => {
    const charCode = c.charCodeAt(0).toString(16);
    return `%${charCode}`;
  });
}

function reloadPageInContainer(
  url: string,
  currentUserContextId: string,
  userContextId: string | false | undefined,
  index: number,
  active: boolean,
  neverAsk = false,
  openerTabId?: number
) {
  if (!userContextId) {
    throw new Error('userContextId is false or undefined');
  }
  const cookieStoreId = getCookieStoreId(userContextId);
  const loadPage = browser.extension.getURL('confirm-page.html');
  // False represents assignment is not permitted
  // If the user has explicitly checked "Never Ask Again" on the warning page we will send them straight there
  if (neverAsk) {
    browser.tabs.create({ url, cookieStoreId, index, active, openerTabId });
  } else {
    let confirmUrl = `${loadPage}?url=${encodeURLProperty(url)}&cookieStoreId=${cookieStoreId}`;
    let currentCookieStoreId;
    if (currentUserContextId) {
      currentCookieStoreId = getCookieStoreId(currentUserContextId);
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
}

///////////////////////////

const MAJOR_VERSIONS = ['2.3.0', '2.4.0'];

browser.windows.getCurrent().then(currentWindow => {
  if (!currentWindow) {
    throw new Error('No currentWindow');
  }
  displayBrowserActionBadge(currentWindow.incognito);
});

function disableAddon(tabId: number) {
  browser.browserAction.disable(tabId);
  browser.browserAction.setTitle({ tabId, title: 'Containers disabled in Private Browsing Mode' });
}

async function displayBrowserActionBadge(isIncognito?: boolean) {
  const extensionInfo = await getExtensionInfo();
  const storage = await browser.storage.local.get({ browserActionBadgesClicked: [] });

  if (
    MAJOR_VERSIONS.indexOf(extensionInfo.version) > -1 &&
    storage.browserActionBadgesClicked.indexOf(extensionInfo.version) < 0
  ) {
    browser.browserAction.setBadgeBackgroundColor({ color: 'rgba(0,217,0,255)' });
    browser.browserAction.setBadgeText({ text: 'NEW' });
  }
}

///////////////////////////

function getContainerStoreKey(cookieStoreId: string) {
  const storagePrefix = 'identitiesState@@_';
  return `${storagePrefix}${cookieStoreId}`;
}

async function identityStateGet(cookieStoreId: string) {
  const storeKey = getContainerStoreKey(cookieStoreId);
  const storageResponse = await browser.storage.local.get([storeKey]);
  if (storageResponse && storeKey in storageResponse) {
    return storageResponse[storeKey];
  }
  const defaultContainerState = _createIdentityState();
  await identityStateSet(cookieStoreId, defaultContainerState);

  return defaultContainerState;
}

function identityStateSet(cookieStoreId: string, data: any) {
  const storeKey = getContainerStoreKey(cookieStoreId);
  return browser.storage.local.set({
    [storeKey]: data,
  });
}

function identityStateRemove(cookieStoreId: string) {
  const storeKey = getContainerStoreKey(cookieStoreId);
  return browser.storage.local.remove([storeKey]);
}

function _createTabObject(tab: browser.tabs.Tab) {
  return Object.assign({}, tab);
}

async function storeHidden(cookieStoreId: string, windowId: number) {
  const containerState = await identityStateGet(cookieStoreId);
  const tabsByContainer = await browser.tabs.query({ cookieStoreId, windowId });
  tabsByContainer.forEach(tab => {
    const tabObject = _createTabObject(tab);
    if (!isPermissibleURL(tab.url)) {
      return;
    }
    // This tab is going to be closed. Let's mark this tabObject as
    // non-active.
    tabObject.active = false;
    // TODO(meyer) hmmmmmmm
    (tabObject as any).hiddenState = true;
    containerState.hiddenTabs.push(tabObject);
  });

  return identityStateSet(cookieStoreId, containerState);
}

function _createIdentityState() {
  return {
    hiddenTabs: [],
  };
}

////////////////////////////

let lastCreatedTab: browser.tabs.Tab | undefined | null;
const LAST_CREATED_TAB_TIMER = 2000;

// After the timer completes we assume it's a tab the user meant to keep open
// We use this to catch redirected tabs that have just opened
// If this were in platform we would change how the tab opens based on "new tab" link navigations such as ctrl+click

// Handles messages from webextension code
browser.runtime.onMessage.addListener(m => {
  let response;

  switch (m.method) {
    case 'deleteContainer':
      response = deleteContainer(m.message.userContextId);
      break;
    case 'createOrUpdateContainer':
      response = createOrUpdateContainer(m.message);
      break;
    case 'neverAsk':
      _neverAsk(m);
      break;
    case 'getAssignment':
      response = browser.tabs.get(m.tabId).then(tab => {
        return _getAssignment(tab);
      });
      break;
    case 'getAssignmentObjectByContainer':
      response = _getByContainer(m.message.userContextId);
      break;
    case 'setOrRemoveAssignment':
      // m.tabId is used for where to place the in content message
      // m.url is the assignment to be removed/added
      response = browser.tabs.get(m.tabId).then(tab => {
        if (tab.id == null) {
          throw new Error('Could not set or remove assignment because tab.id is falsey');
        }
        return _setOrRemoveAssignment(tab.id, m.url, m.userContextId, m.value);
      });
      break;
    case 'sortTabs':
      sortTabs();
      break;
    case 'showTabs':
      unhideContainer(m.cookieStoreId);
      break;
    case 'hideTabs':
      hideTabs(m);
      break;
    case 'checkIncompatibleAddons':
      // TODO
      break;
    case 'moveTabsToWindow':
      response = moveTabsToWindow(m);
      break;
    case 'getTabs':
      response = getTabs(m);
      break;
    case 'queryIdentitiesState':
      response = queryIdentitiesState(m.message.windowId);
      break;
    case 'exemptContainerAssignment':
      response = _exemptTab(m);
      break;
  }
  return response;
});

// Handles external messages from webextensions
const externalExtensionAllowed: Record<string, true> = {};
browser.runtime.onMessageExternal.addListener(async (message, sender) => {
  if (sender.id && !externalExtensionAllowed[sender.id]) {
    const extensionInfo = await browser.management.get(sender.id);
    if (!extensionInfo || !extensionInfo.permissions) {
      throw new Error('Could not fetch extensionInfo');
    }
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
      response = storageAreaGet(message.url);
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
    const userContextId = getUserContextIdFromCookieStoreId(contextualIdentity.cookieStoreId);
    if (userContextId) {
      deleteContainer(userContextId, true);
    }
  });
}

browser.tabs.onActivated.addListener(info => {
  removeContextMenu();
  browser.tabs
    .get(info.tabId)
    .then(calculateContextMenu)
    .catch(e => {
      throw e;
    });
});

browser.windows.onFocusChanged.addListener(windowId => {
  onFocusChangedCallback(windowId);
});

browser.webRequest.onCompleted.addListener(
  details => {
    if (details.frameId !== 0 || details.tabId === -1) {
      return;
    }
    removeContextMenu();

    browser.tabs
      .get(details.tabId)
      .then(tab => {
        calculateContextMenu(tab);
      })
      .catch(e => {
        throw e;
      });
  },
  { urls: ['<all_urls>'], types: ['main_frame'] }
);

browser.tabs.onCreated.addListener(tab => {
  if (tab.id != null && tab.incognito) {
    disableAddon(tab.id);
  }
  // lets remember the last tab created so we can close it if it looks like a redirect
  lastCreatedTab = tab;
  if (tab.cookieStoreId) {
    // Don't count firefox-default, firefox-private, nor our own confirm page loads
    if (
      tab.cookieStoreId !== 'firefox-default' &&
      tab.cookieStoreId !== 'firefox-private' &&
      tab.url &&
      !tab.url.startsWith('moz-extension')
    ) {
      // increment the counter of container tabs opened
      incrementCountOfContainerTabsOpened();
    }

    unhideContainer(tab.cookieStoreId);
  }
  setTimeout(() => {
    lastCreatedTab = null;
  }, LAST_CREATED_TAB_TIMER);
});

async function incrementCountOfContainerTabsOpened() {
  const key = 'containerTabsOpened';
  const count: { [key]: number } = await browser.storage.local.get({ [key]: 0 });
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
}

async function onFocusChangedCallback(windowId: number) {
  removeContextMenu();
  // browserAction loses background color in new windows ...
  // https://bugzil.la/1314674
  // https://github.com/mozilla/testpilot-containers/issues/608
  // ... so re-call displayBrowserActionBadge on window changes
  displayBrowserActionBadge();
  browser.tabs
    .query({ active: true, windowId })
    .then(tabs => {
      if (tabs && tabs[0]) {
        calculateContextMenu(tabs[0]);
      }
    })
    .catch(e => {
      throw e;
    });
}
