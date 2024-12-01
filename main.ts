import {
    App,
    Platform,
    Plugin,
    PluginSettingTab,
    Setting,
    WorkspaceLeaf,
    normalizePath,
} from "obsidian";

// Needed for reading nicknames from a hidden file in this and other vaults.
// Obsidian doesn't offer an API to access hidden files nor files from other
// vaults.
import {
    existsSync,
    readFileSync,
    writeFileSync,
} from "fs";

interface VaultNicknamePluginSettings {
    /// The name that will be used to override the vault's display name in the
    /// vault switcher. If this is empty or whitespace, the plugin will
    /// fallback to the vault's folder name.
    ///
    nickname: string;
}

const DEFAULT_SETTINGS: VaultNicknamePluginSettings = {
    nickname: "My Vault Nickname",
}

const PATH_SEPARATOR: string = Platform.isWin ? '\\' : '/';

/// A path local to any vault's root that points at this plugins settings file.
/// Unfortunately, we cannot use the standard "data.json" that lives in the
/// plugins install folder directly because we cannot reliably know this path
/// from outside vaults. (The use can override a vault's config folder and the
/// plugin's folder name may be arbitrarily changed if installed manually.)
///
const VAULT_LOCAL_SETTINGS_FILE_PATH: string = ".vault-nickname";

export default class VaultNicknamePlugin extends Plugin {
    settings: VaultNicknamePluginSettings;

    /// The vault switcher element where this plugin visualizes nicknames.
    /// This element is cached so that some custom callbacks can check whether
    /// it has a context menu visible: `hasClass('has-active-menu')`
    ///
    vaultSwitcherElement: Element | null;

    /// The callback invoked whenever the vault switcher is clicked. It is a
    /// bound function and is therefore cached so it can be removed when the
    /// addon is disabled.
    ///
    vaultSwitcherClickCallback: () => Promise<void>;
    vaultSwitcherContextMenuCallback: () => Promise<void>;

    /// The callback that is invoked whenever the user clicks on an item in
    /// Obsidian's file tree. This callback ensures the app title correctly
    /// updates to show the vault's nickname.
    ///
    activeLeafChangeCallback: (file: WorkspaceLeaf | null) => void;

    async onload() {
        // Create (but don't register) the callbacks (bound to `this`).
        this.vaultSwitcherClickCallback = this.onVaultSwitcherClicked.bind(this);
        this.vaultSwitcherContextMenuCallback = this.onVaultSwitcherContextMenu.bind(this);
        this.activeLeafChangeCallback = this.onActiveLeafChange.bind(this);

        await this.loadSettings();

        const settingsFilePath = await this.getSettingsFilePath();

        if (!existsSync(settingsFilePath)) {
            // Ensure the plugin's settings file exists as soon as possible.
            // This is necessary to ensure the vault switcher drop down menu
            // updates correctly for within this vault and other vaults that
            // have the plugin installed.
            await this.saveSettings();
        }

        this.addSettingTab(new VaultNicknameSettingTab(this.app, this));
        this.app.workspace.onLayoutReady(this.onLayoutReady.bind(this));
        this.app.workspace.on('active-leaf-change', this.activeLeafChangeCallback);
    }

    onunload() {
        this.app.workspace.off('active-leaf-change', this.activeLeafChangeCallback);
        this.useVaultSwitcherCallbacks(false);
        this.refreshSelectedVaultName();
    }

    onLayoutReady() {
        this.vaultSwitcherElement =
            window.activeDocument.querySelector('.workspace-drawer-vault-switcher');

        this.useVaultSwitcherCallbacks(true);
        this.refreshSelectedVaultName();
    }

    useVaultSwitcherCallbacks(use: boolean) {
        if (!this.vaultSwitcherElement) {
            console.error('Vault switcher element not found. Cannot update its events.');
            return;
        }

        // Unsubscribe, even if we want to subscribe. This guards against
        // duplicate listeners.
        this.vaultSwitcherElement.removeEventListener('click', this.vaultSwitcherClickCallback);
        this.vaultSwitcherElement.removeEventListener('contextmenu', this.vaultSwitcherContextMenuCallback);

        if (use) {
            // Install the callbacks.
            this.vaultSwitcherElement.addEventListener('click', this.vaultSwitcherClickCallback);
            this.vaultSwitcherElement.addEventListener('contextmenu', this.vaultSwitcherContextMenuCallback);
        }

    }

    /// Query for a selector. If not found, try observing for
    /// `timeoutMilliseconds` for it to be added, otherwise return `null`.
    ///
    async waitForSelector(selector: string, timeoutMilliseconds: number) : Promise<Element|null> {
        return new Promise<Element|null>(resolve => {
            // Check initially if the selector matches.
            if (window.activeDocument.querySelector(selector)) {
                return resolve(document.querySelector(selector));
            }

            const timeout = setTimeout(() => {
                resolve(null);
            }, timeoutMilliseconds);

            // Otherwise, use MutationObserver to track changes in the DOM.
            const observer = new MutationObserver(mutations => {
                if (document.querySelector(selector)) {
                    clearTimeout(timeout);
                    observer.disconnect();
                    resolve(document.querySelector(selector));
                }
            });

            // Observe changes in the subtree of the element's parent
            observer.observe(document.body, {
                childList: true,
                subtree: true
            });
        });
    }

    /// Wait for an element to be removed.
    async waitForElementToBeRemoved(element: Element, timeoutMilliseconds: number) : Promise<void> {
        return new Promise(resolve => {
            // Check initially if the parent is null (it could already be
            // removed).
            const parent = element.parentNode;

            if (!parent) {
                resolve();
                return;
            }

            const timeout = setTimeout(() => {
                resolve();
            }, timeoutMilliseconds);

            // Otherwise, use MutationObserver to track changes in the DOM
            const observer = new MutationObserver(() => {
                if (!element.parentNode) {
                    clearTimeout(timeout);
                    observer.disconnect();
                    resolve();
                }
            });

            // Observe changes in the subtree of the element's parent
            observer.observe(parent, {
                childList: true,
                subtree: true
            });
        });
    }

    /// Invoked when the active workspace leaf was changed. We need to use this
    /// event to fix up the app window's title.
    ///
    onActiveLeafChange(file: WorkspaceLeaf | null) {
        this.refreshSelectedVaultName();
    }

    /// Invoked when the user clicks the workspace's vault switcher drawer.
    /// This function changes the vault names shown in the vault popup menu
    /// to the names provided by the vault's personal Vault Nickname plugin.
    ///
    async onVaultSwitcherClicked() {
        const vaultSwitcherMenu = await this.waitForSelector('.menu', 100);

        if (!vaultSwitcherMenu) {
            console.error('The vault switcher menu was not found after the timeout.');
            return;
        }

        // Ask Obsidian for its list of known vaults.
        const vaults = electron.ipcRenderer.sendSync("vault-list");
        if (!vaults) {
            console.error('Failed to retrieve list of known vaults.');
        }

        // Pair each vault to its menu item and apply its nickname.
        // This applies the vault's nickname even if the nickname plugin is
        // disabled in that value.
        const vaultKeys = Object.keys(vaults);
        const menuItems = vaultSwitcherMenu.querySelectorAll('.menu-item');
        const min = Math.min(menuItems.length, vaultKeys.length);
        for (let i = 0; i < min; ++i) {
            const vaultKey = vaultKeys[i];
            const vault = vaults[vaultKey];

            const titleElement = menuItems[i].querySelector('.menu-item-title');
            if (!titleElement) {
                console.error('No title element for this vault: ' + vault.path);
                continue;
            }

            // We could use the following undocumented function kindly shared
            // by @mnaoumov (https://forum.obsidian.md/t/sharing-plugin-data-between-vaults-stumped-by-override-config-folder/92570/2),
            // to learn a vault's config folder. However, we would still need
            // a fallback '.obsidian' literal to handle the default case of a
            // vault using the normal config folder because in those cases the
            // function returns `null`. Having a string literal for the default
            // config folder causes trouble with ObsidianReviewBot on github.
            //const vaultConfigFolderName = App.getOverrideConfigDir(vaultKey);

            const vaultPluginSettingsFilePath = normalizePath([
                vault.path,
                VAULT_LOCAL_SETTINGS_FILE_PATH
            ].join(PATH_SEPARATOR));

            if (!existsSync(vaultPluginSettingsFilePath)) {
                //console.log("Plugin settings does not exist: " + vaultPluginSettingsFilePath);
                continue;
            }

            const vaultPluginSettingsJson =
                readFileSync(vaultPluginSettingsFilePath);

            if (!vaultPluginSettingsJson) {
                //console.log("Could not read plugin settings: " + vaultPluginSettingsFilePath);
                continue;
            }

            const vaultPluginSettings = JSON.parse(vaultPluginSettingsJson);

            if (!vaultPluginSettings || !vaultPluginSettings.nickname || !vaultPluginSettings.nickname.trim()) {
                //console.log("No nickname in json or nickname is blank: " + vaultPluginSettingsFilePath);
                continue;
            }

            titleElement.textContent = vaultPluginSettings.nickname;
        }
    }

    /// Invoked when the user context-clicks on the vault switcher drop down.
    /// This function adds a custom "Set nickname" item to the spawned menu to
    /// act as a shortcut for quickly nicknaming the vault.
    ///
    async onVaultSwitcherContextMenu() {
        // Ensure we find the newest menu to append our "Set nickname" item.
        if (this.vaultSwitcherElement && this.vaultSwitcherElement.hasClass('has-active-menu')) {

            // Obsidian says that a menu already exists. We will wait for that
            // one to be destroyed before we look for the new one.

            const alreadyOpenMenu = window.activeDocument.querySelector('.menu');

            if (alreadyOpenMenu) {
                await this.waitForElementToBeRemoved(alreadyOpenMenu, 200);
            }
        }

        // Look for the new context menu.

        const vaultSwitcherMenu = await this.waitForSelector('.menu', 200);

        if (!vaultSwitcherMenu) {
            console.error('The vault switcher menu was not found after the timeout.');
            return;
        }

        const templateMenuItem = vaultSwitcherMenu.querySelector('.menu-item');
        if (!templateMenuItem) {
            console.error('No menu-item to clone');
            return;
        }

        const openSettingsMenuItem = templateMenuItem.cloneNode(true);
        if (!openSettingsMenuItem) {
            console.error('Failed to clone menu-item');
            return;
        }

        const openSettingsMenuItemIcon =
            openSettingsMenuItem.querySelector('.menu-item-icon');

        if (openSettingsMenuItemIcon) {
            // Hide the icon.
            openSettingsMenuItemIcon.toggleVisibility(false);
        }

        const openSettingsMenuItemLabel =
            openSettingsMenuItem.querySelector('.menu-item-title');

        if (!openSettingsMenuItemLabel) {
            console.error('No menu-item-title in cloned menu-item');
            return;
        }

        openSettingsMenuItemLabel.textContent = 'Set nickname';

        openSettingsMenuItem.addEventListener('click', this.openVaultNicknameSettings.bind(this));

        /// Deselect other items in this menu and then select (highlight) the
        /// "Set nickname" item. This is necessary to make the new menu item
        /// respond to hover events as expected.
        ///
        const onMouseOver = function () {
            const parent = this.parentElement;

            const menuItems = parent.querySelectorAll('.menu-item');
            for (const menuItem of menuItems) {
                menuItem.removeClass('selected');
            }

            this.addClass('selected');
        }

        /// Deselect the "Set nickname" menu item.
        ///
        const onMouseLeave = function () {
            this.removeClass('selected');
        }

        openSettingsMenuItem.addEventListener('mouseover', onMouseOver.bind(openSettingsMenuItem));
        openSettingsMenuItem.addEventListener('mouseleave', onMouseLeave.bind(openSettingsMenuItem));

        vaultSwitcherMenu.appendChild(openSettingsMenuItem);
    }

    async openVaultNicknameSettings() {
        // Request the settings window to open.
        this.app.commands.executeCommandById('app:open-settings');

        // Wait for the settings window to open.
        const settingsMenu = await this.waitForSelector('.mod-settings', 200);
        if (!settingsMenu) {
            console.error('The vault settings menu was not found after the timeout.');
            return;
        }

        // Wait for any tab item to appear. Then we know it's go-time to find
        // the settings tab item for our plugin.
        const anyTab = await this.waitForSelector('.vertical-tab-nav-item', 200);
        if (!anyTab) {
            console.error('Found no tab.');
            return;
        }

        // Find the tab that corresponds to this plugin.
        const settingsTabs = settingsMenu.querySelectorAll('.vertical-tab-nav-item');

        for (const tab of settingsTabs) {
            if (tab.textContent !== this.manifest.name) {
                continue;
            }

            // Open the plugin's settings page.
            tab.click();
            return;
        }

        console.error('Plugin tab not found.');
    }

    /// Refresh the text for the active vault in the workspace's vault switcher
    /// drawer. If no nickname exists for the active vault, the label will
    /// fallback to the vault's folder name.
    ///
    refreshSelectedVaultName() {
        const currentVaultName =
            (this.settings && this.settings.nickname && this.settings.nickname.trim()) ?
                this.settings.nickname.trim() :
                this.app.vault.getName();

        this.setSelectedVaultDisplayName(currentVaultName);
    }

    /// Change the display name of the active vault in the workspace's vault
    /// switcher drawer and the app window's title.
    ///
    setSelectedVaultDisplayName(displayName: string) {
        const selectedVaultNameElement =
            window.activeDocument.querySelector('.workspace-drawer-vault-name');

        if (selectedVaultNameElement) {
            selectedVaultNameElement.textContent = displayName;
        }

        const titleSeparator = ' - ';
        const titleParts = window.activeDocument.title.split(titleSeparator);
        if (titleParts.length > 2) {
            titleParts[titleParts.length - 2] = displayName;
            const title = titleParts.join(titleSeparator);
            window.activeDocument.title = title;
        }
    }

    async loadSettings() {
        // Setup a fallback nickname that is the name of the vault's parent
        // folder.
        const personalizedDefaultSettings =
            Object.assign({}, DEFAULT_SETTINGS);

        const parentFolderName = this.getVaultParentFolderName();
        if (parentFolderName) {
            personalizedDefaultSettings.nickname = parentFolderName;
        }

        // Try to load the saved vault nickname.
        let loadedSettings = {};

        const settingsFilePath = await this.getSettingsFilePath();

        if (existsSync(settingsFilePath)) {
            // Using fs.readFileSync because the `Vault` API doesn't support
            // hidden files.
            const settingsJson = readFileSync(settingsFilePath, 'utf8');

            if (settingsJson) {
                loadedSettings = JSON.parse(settingsJson);
            }
        }

        // Apply the loaded nickname settings.
        this.settings =
            Object.assign({}, personalizedDefaultSettings, loadedSettings);

        this.refreshSelectedVaultName();
    }

    async saveSettings() {
        const settingsFilePath = await this.getSettingsFilePath();

        if (settingsFilePath) {
            const settingsJson = JSON.stringify(this.settings);

            // Using fs.writeFileSync because the `Vault` API doesn't support
            // hidden files.
            writeFileSync(settingsFilePath, settingsJson);
        }

        this.refreshSelectedVaultName();
    }

    getVaultParentFolderName() : string {
        // Try use the vault's parent folder name as the default nickname.
        const vaultAbsoluteFilePath = this.app.vault.adapter.getBasePath()

        if (vaultAbsoluteFilePath) {
            const explodedVaultPath = vaultAbsoluteFilePath.split(PATH_SEPARATOR);
            const indexToParentFolder = explodedVaultPath.length - 2;
            if (indexToParentFolder >= 0 && explodedVaultPath[indexToParentFolder] && explodedVaultPath[indexToParentFolder].trim()) {
                return explodedVaultPath[indexToParentFolder].trim();
            }
        }

        return "";
    }

    async getSettingsFilePath(): Promise<string> {
        return [
            this.app.vault.adapter.getBasePath(),
            VAULT_LOCAL_SETTINGS_FILE_PATH
        ].join(PATH_SEPARATOR);
    }
}

class VaultNicknameSettingTab extends PluginSettingTab {
    plugin: VaultNicknamePlugin;

    constructor(app: App, plugin: VaultNicknamePlugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display(): void {
        const { containerEl } = this;

        containerEl.empty();
        containerEl.addClass('vault-nickname-settings');

        new Setting(containerEl)
            .setName('Vault nickname')
            .setDesc('Override the vault\'s display name.')
            .setTooltip("A vault nickname controls the text shown in the workspace's vault switcher. The 'Manage Vaults' window will continue showing the true vault name as these may be disambiguated by their visible path.")
            .addText((textComponent) => {
                // A text field to assign the vault's nickname.
                textComponent
                    .setPlaceholder('No nickname')
                    .setValue(this.plugin.settings.nickname)
                    .onChange(async newValue => {
                        this.plugin.settings.nickname = newValue;
                        await this.plugin.saveSettings();
                    })
            })
            .addButton(buttonComponent => {
                // A button to quickly apply the vault's parent folder name as
                // the nickname (a common use case and how the default nickname
                // is chosen).
                buttonComponent
                    .setIcon('folder-up')
                    .setTooltip('Use the name of the vault\'s parents folder.')
                    .onClick(async mouseEvent => {
                        const parentFolderName = this.plugin.getVaultParentFolderName();
                        if (!parentFolderName) {
                            return;
                        }

                        this.plugin.settings.nickname = parentFolderName;

                        // Refresh the nickname field in the settings window.
                        this.display();

                        await this.plugin.saveSettings();
                    })
            });
    }
}

