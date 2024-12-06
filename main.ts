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
    /// The override vault display name. Used in the vault switcher.
    /// If empty or whitespace, the vault's actual name (folder name) is used.
    ///
    nickname: string;
}

const DEFAULT_SETTINGS: VaultNicknamePluginSettings = {
    nickname: "My Vault Nickname",
}

const PATH_SEPARATOR: string = Platform.isWin ? '\\' : '/';

/// The vault-local path to the plugin's settings. This file is intentionally
/// stored in the vault's root (as a hidden file) to ensure it can be found by
/// instances of the plugin running in other vaults.
///
const VAULT_LOCAL_SETTINGS_FILE_PATH = ".vault-nickname";

export default class VaultNicknamePlugin extends Plugin {

    /// Is the plugin is enabled. Used by `onload` to reliably check the
    /// plugin's state as a workaround for `this.app.plugins.enabledPlugins`
    /// omitting plugins that are actively loading.
    ///
    isEnabled = false;

    settings: VaultNicknamePluginSettings;

    /// The vault switcher element where this plugin visualizes nicknames.
    /// This element is cached so that some custom callbacks can check whether
    /// it has a context menu visible: `hasClass('has-active-menu')`
    ///
    vaultSwitcherElement: Element | null;

    /// Callbacks invoked whenever the vault switcher is clicked.
    ///
    vaultSwitcherClickCallback: () => Promise<void>;
    vaultSwitcherContextMenuCallback: () => Promise<void>;

    /// A callback invoked whenever the user clicks an item in the file tree.
    /// Ensures the app title correctly updates to show the vault's nickname.
    ///
    activeLeafChangeCallback: (file: WorkspaceLeaf | null) => void;

    async onload() {
        this.isEnabled = true;

        // Create bound callbacks for access to `this` pointer.
        this.vaultSwitcherClickCallback = this.onVaultSwitcherClicked.bind(this);
        this.vaultSwitcherContextMenuCallback = this.onVaultSwitcherContextMenu.bind(this);
        this.activeLeafChangeCallback = this.onActiveLeafChange.bind(this);

        await this.loadSettings();

        const settingsFilePath = await this.getSettingsFilePath();

        if (!existsSync(settingsFilePath)) {
            // Ensure the plugin's settings file exists as soon as possible.
            // This is necessary to because the plugin reads this file for
            // this vault and other vault's nickname when updating the vault
            // switcher drop down menu items.
            await this.saveSettings();
        }

        this.addSettingTab(new VaultNicknameSettingTab(this.app, this));
        this.app.workspace.onLayoutReady(this.onLayoutReady.bind(this));
        this.registerEvent(this.app.workspace.on('active-leaf-change', this.activeLeafChangeCallback));
    }

    onunload() {
        this.isEnabled = false;

        this.useVaultSwitcherCallbacks(false);
        this.refreshVaultDisplayName();
    }

    onLayoutReady() {
        this.vaultSwitcherElement =
            window.activeDocument.querySelector('.workspace-drawer-vault-switcher');

        this.useVaultSwitcherCallbacks(true);
        this.refreshVaultDisplayName();
    }

    useVaultSwitcherCallbacks(use: boolean) {
        if (!this.vaultSwitcherElement) {
            console.error('Vault switcher element not found. Cannot update its events.');
            return;
        }

        // Doubles as a sanity-unsubscribe when `use` is true.
        this.vaultSwitcherElement.removeEventListener('click', this.vaultSwitcherClickCallback);
        this.vaultSwitcherElement.removeEventListener('contextmenu', this.vaultSwitcherContextMenuCallback);

        if (use) {
            this.vaultSwitcherElement.addEventListener('click', this.vaultSwitcherClickCallback);
            this.vaultSwitcherElement.addEventListener('contextmenu', this.vaultSwitcherContextMenuCallback);
        }
    }

    /// Query for a selector. If not found, try observing for
    /// `timeoutMilliseconds` for it to be added, otherwise return `null`.
    ///
    async waitForSelector(selector: string, timeoutMilliseconds: number) : Promise<Element|null> {
        return new Promise<Element|null>(resolve => {
            if (window.activeDocument.querySelector(selector)) {
                // Already exists.
                return resolve(document.querySelector(selector));
            }

            const timeout = setTimeout(() => resolve(null), timeoutMilliseconds);

            // Otherwise, use MutationObserver to track changes in the DOM.
            const observer = new MutationObserver(mutations => {
                if (document.querySelector(selector)) {
                    clearTimeout(timeout);
                    observer.disconnect();
                    resolve(document.querySelector(selector));
                }
            });

            observer.observe(document.body, {
                childList: true,
                subtree: true
            });
        });
    }

    /// Wait for an element to be removed.
    ///
    async waitForElementToBeRemoved(element: Element, timeoutMilliseconds: number) : Promise<void> {
        return new Promise(resolve => {
            const parent = element.parentNode;

            if (!parent) {
                // Already removed.
                resolve();
                return;
            }

            const timeout = setTimeout(() => resolve(), timeoutMilliseconds);

            // Otherwise, use MutationObserver to track changes in the DOM
            const observer = new MutationObserver(() => {
                if (!element.parentNode) {
                    clearTimeout(timeout);
                    observer.disconnect();
                    resolve();
                }
            });

            observer.observe(parent, {
                childList: true,
                subtree: true
            });
        });
    }

    /// Invoked when the active workspace leaf was changed. Applies the vault's
    /// nickname to the window title.
    ///
    onActiveLeafChange(_: WorkspaceLeaf | null) {
        this.refreshVaultDisplayName();
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

        // Apply the vault nicknames to the vault switcher's menu items.
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
                //console.log("No nickname settings for vault: " + vaultPluginSettingsFilePath);
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
    /// Adds a "Set nickname" item to the spawned menu as a shortcut to the
    /// plugin's settings page.
    ///
    async onVaultSwitcherContextMenu() {
        // Ensure the newest menu is found. Otherwise, when the user
        // context-clicks consecutively, this would find and add the shortcut
        // to the earlier, soon-to-be closed menu.
        if (this.vaultSwitcherElement && this.vaultSwitcherElement.hasClass('has-active-menu')) {

            // Obsidian says that a menu already exists. Wait for it to be
            // destroyed before looking for the new one.

            const alreadyOpenMenu = window.activeDocument.querySelector('.menu');

            if (alreadyOpenMenu) {
                await this.waitForElementToBeRemoved(alreadyOpenMenu, 200);
            }
        }

        // Get the new context menu.
        const vaultSwitcherMenu = await this.waitForSelector('.menu', 200);

        if (!vaultSwitcherMenu) {
            console.error('The vault switcher menu was not found after the timeout.');
            return;
        }

        // Find the "Show in explorer" item and clone it as the basis for the
        // "Set nickname" item.
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

        // Setup the "Set nickname" menu. 'mouseover' and 'mouseleave' must be
        // manually implemented for feedback during mouse hover.

        const openSettingsMenuItemIcon =
            openSettingsMenuItem.querySelector('.menu-item-icon');

        if (openSettingsMenuItemIcon) {
            // Hide the icon. (Not so simple to set a custom icon from here.)
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

        /// Animate during mouseover.
        ///
        const onMouseOver = function () {
            const parent = this.parentElement;

            // Deselect other items. Otherwise, two items will be selected.
            const menuItems = parent.querySelectorAll('.menu-item');
            for (const menuItem of menuItems) {
                menuItem.removeClass('selected');
            }

            this.addClass('selected');
        }

        /// Animate during mouseleave.
        ///
        const onMouseLeave = function () {
            this.removeClass('selected');
        }

        openSettingsMenuItem.addEventListener('mouseover', onMouseOver.bind(openSettingsMenuItem));
        openSettingsMenuItem.addEventListener('mouseleave', onMouseLeave.bind(openSettingsMenuItem));

        vaultSwitcherMenu.appendChild(openSettingsMenuItem);
    }

    /// Invoked by the custom "Set nickname" menu item added to the vault
    /// switcher's context menu. Opens the plugins setting page for quick
    /// access to nickname field.
    ///
    async openVaultNicknameSettings() {
        // Open the settings window.
        this.app.commands.executeCommandById('app:open-settings');

        const settingsMenu = await this.waitForSelector('.mod-settings', 200);
        if (!settingsMenu) {
            console.error('The vault settings menu was not found after the timeout.');
            return;
        }

        // Wait for any tab item to appear to know when it's go-time to find
        // tab for this plugin.
        const anyTab = await this.waitForSelector('.vertical-tab-nav-item', 200);
        if (!anyTab) {
            console.error('Timeout while waiting for a settings menu tab to be found.');
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
    refreshVaultDisplayName() {
        const currentVaultName =
            (this.isEnabled && this.settings && this.settings.nickname && this.settings.nickname.trim()) ?
                this.settings.nickname.trim() :
                this.app.vault.getName();

        this.setVaultDisplayName(currentVaultName);
    }

    /// Change the display name of the active vault in the workspace's vault
    /// switcher drawer and the app window's title.
    ///
    setVaultDisplayName(displayName: string) {
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

    /// Load the vault's nickname. Currently, a hidden file in the root of the
    /// vault is used because it simplifies sharing vault nicknames between
    /// other instances of the plugin.
    ///
    async loadSettings() {
        // Overwrite DEFAULT_SETTINGS with a default nickname that is
        // personalized to this vault's file path. We will use the name of the
        // vault's parent folder as the default nickname.

        const personalizedDefaultSettings =
            Object.assign({}, DEFAULT_SETTINGS);

        const parentFolderName = this.getVaultParentFolderName();
        if (parentFolderName) {
            personalizedDefaultSettings.nickname = parentFolderName;
        }

        // Setup an object to receive the nickname as read from the hidden
        // nickname file in the vault's root.

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

        this.refreshVaultDisplayName();
    }

    /// Write the vault's nickname to disk. Currently, a hidden file in the
    /// root of the vault is used because it simplifies sharing vault nicknames
    /// between other instances of the plugin.
    ///
    async saveSettings() {
        const settingsFilePath = await this.getSettingsFilePath();

        if (settingsFilePath) {
            const settingsJson = JSON.stringify(this.settings);

            // Using fs.writeFileSync because the `Vault` API doesn't support
            // hidden files.
            writeFileSync(settingsFilePath, settingsJson);
        }

        this.refreshVaultDisplayName();
    }

    /// Get the name of the vault's parent folder. This is used as the plugin's
    /// default vault nickname
    ///
    getVaultParentFolderName(): string {
        // Get the absolute path to the vault's root.
        const vaultAbsoluteFilePath = this.app.vault.adapter.getBasePath()

        if (!vaultAbsoluteFilePath) {
            return "";
        }

        // Explode the vault path into each of its folders.
        const explodedVaultPath = vaultAbsoluteFilePath.split(PATH_SEPARATOR);
        const indexOfParentFolder = explodedVaultPath.length - 2;
        if (indexOfParentFolder < 0 || !explodedVaultPath[indexOfParentFolder] || !explodedVaultPath[indexOfParentFolder].trim()) {
            return "";
        }

        return explodedVaultPath[indexOfParentFolder].trim();
    }

    /// Get the absolute path to this vault's nickname settings. This is a
    /// hidden file in the root of the vault. Ideally, we would have this file
    /// in the plugin's install folder but it is currently tricky to access
    /// files in other vaults' config folder.
    ///
    getSettingsFilePath(): string {
        // Ideally we would use a Vault API to get the TFile of the settings
        // file. However, that API does not support hidden files.
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
                    });
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

