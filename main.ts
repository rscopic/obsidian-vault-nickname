import {
    App,
    Menu,
    Platform,
    Plugin,
    PluginSettingTab,
    Setting,
    TAbstractFile,
    WorkspaceLeaf,
    normalizePath,
} from "obsidian";

interface VaultNicknamePluginSettings {
    overrideAppTitle: string;
}

interface VaultNicknameSharedPluginSettings {
    /// The override vault display name. Used in the vault switcher.
    /// If empty or whitespace, the vault's actual name (folder name) is used.
    ///
    nickname: string;
}

const DEFAULT_PLUGIN_SETTINGS: VaultNicknamePluginSettings = {
    overrideAppTitle: 'override-app-title:file-first',
};

const DEFAULT_SHARED_SETTINGS: VaultNicknameSharedPluginSettings = {
    nickname: "My Vault Nickname",
};

const PATH_SEPARATOR: string = Platform.isWin ? '\\' : '/';

/// The vault-local path to the plugin's settings. This file is intentionally
/// stored in the vault's root (as a hidden file) to ensure it can be found by
/// instances of the plugin running in other vaults.
///
const VAULT_LOCAL_SHARED_SETTINGS_FILE_PATH = ".vault-nickname";

export default class VaultNicknamePlugin extends Plugin {

    /// Is the plugin is enabled. Used by `onload` to reliably check the
    /// plugin's state as a workaround for `this.app.plugins.enabledPlugins`
    /// omitting plugins that are actively loading.
    ///
    isEnabled = false;

    settings: VaultNicknamePluginSettings;

    sharedSettings: VaultNicknameSharedPluginSettings;

    /// The vault switcher (desktop-only). Cached so callbacks can check if
    /// it's context menu is visible: `hasClass('has-active - menu')`
    ///
    desktopVaultSwitcherElement: Element | null;

    /// A callback invoked whenever the user clicks an item in the file tree.
    /// Ensures the app title correctly updates to show the vault's nickname.
    ///
    vaultItemRenamedCallback: (_: TAbstractFile | null) => void;

    /// A callback invoked whenever the user clicks an item in the file tree.
    /// Ensures the app title correctly updates to show the vault's nickname.
    ///
    activeLeafChangeCallback: (_: WorkspaceLeaf | null) => void;

    async onload() {
        this.isEnabled = true;

        // Create bound callbacks for access to `this` pointer.
        this.vaultItemRenamedCallback = this.onVaultItemRenamed.bind(this);
        this.activeLeafChangeCallback = this.onActiveLeafChange.bind(this);

        await this.loadSettings();

        const settingsFilePath = this.getSharedSettingsFilePath();

        let saveSettingsExist = false;

        await this.app.vault.adapter.exists(settingsFilePath)
            .then(
                (exists) => {
                    saveSettingsExist = exists;
                },
                (rejectReason) => {
                    saveSettingsExist = false;
                }
            );

        if (!saveSettingsExist) {
            // Ensure the nickname file exists so other vaults can immediately
            // display its nickname.
            await this.saveSettings();
        }

        this.addSettingTab(new VaultNicknameSettingTab(this.app, this));
        this.app.workspace.onLayoutReady(this.onLayoutReady.bind(this));
        this.registerEvent(this.app.vault.on('rename', this.vaultItemRenamedCallback));
        this.registerEvent(this.app.workspace.on('active-leaf-change', this.activeLeafChangeCallback));
    }

    onunload() {
        this.isEnabled = false;

        this.useVaultSwitcherCallbacks(false);
        this.refreshVaultDisplayName();

        if (this.desktopVaultSwitcherElement) {
            this.desktopVaultSwitcherElement.remove();
            this.desktopVaultSwitcherElement = null;
        }
    }

    /// Creates an invisible 'interceptor' element over the vault switcher
    /// element. This is used to catch click events and recreate Obsidian's
    /// normal menus, but displaying the vault nicknames. This was necessary
    /// to make the plugin work on macOS where these context menus are rendered
    /// natively and otherwise couldn't be modified.
    ///
    onLayoutReady() {
        const originalDesktopVaultSwitcherElement =
            window.activeDocument.querySelector('.workspace-drawer-vault-switcher');

        if (!originalDesktopVaultSwitcherElement) {
            console.error('Vault switcher element not found. Cannot create element to intercept its events.');
        }
        else {
            // Necessary to make the interceptor element fit to the vault
            // switcher's size.
            originalDesktopVaultSwitcherElement.style.position = 'relative';

            this.desktopVaultSwitcherElement =
                originalDesktopVaultSwitcherElement.createDiv('.workspace-drawer-vault-switcher-vault-nickname-interceptor');

            Object.assign(
                this.desktopVaultSwitcherElement.style,
                {
                    position:        'absolute',
                    top:             '0',
                    left:            '0',
                    width:           '100%',
                    height:          '100%',
                    backgroundColor: 'transparent',
                    display:         'none',
                }
            );

            this.desktopVaultSwitcherElement.addEventListener('click', this.onVaultSwitcherClicked.bind(this));
            this.desktopVaultSwitcherElement.addEventListener('contextmenu', this.onVaultSwitcherContextMenu.bind(this));

            this.useVaultSwitcherCallbacks(true);
        }

        this.refreshVaultDisplayName();
    }

    useVaultSwitcherCallbacks(use: boolean) {
        if (Platform.isMobile) {
            return;
        }

        if (this.desktopVaultSwitcherElement) {
            this.desktopVaultSwitcherElement.style.display = use ? 'block' : 'hidden';
        }
    }

    /// Query for a selector. If not found, try observing for
    /// `timeoutMilliseconds` for it to be added, otherwise return `null`.
    ///
    async waitForSelector(searchFrom: Document | Element , selector: string, timeoutMilliseconds: number) : Promise<Element|null> {
        return new Promise<Element | null>(resolve => {
            const element = searchFrom.querySelector(selector);

            if (element) {
                // Already exists.
                return resolve(element);
            }

            // Wait for it appear.
            const timeout = setTimeout(() => resolve(null), timeoutMilliseconds);

            const observer = new MutationObserver(mutations => {
                const element = searchFrom.querySelector(selector);
                if (element) {
                    clearTimeout(timeout);
                    observer.disconnect();
                    resolve(element);
                }
            });

            observer.observe(searchFrom, {
                childList: true,
                subtree: true
            });
        });
    }

    /// Invoked when a vault item is renamed. Applies the vault's nickname to
    /// the window title.
    ///
    onVaultItemRenamed(_: TAbstractFile | null) {
        this.refreshVaultDisplayName();
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
    onVaultSwitcherClicked(event: Event) {
        if (event.shiftKey) {
            // Allow holding the shift key to call the original behavior.
            return;
        }

        event.stopPropagation();

        // TODO: This is at least one API that prevents support on mobile
        //       (thanks @joethei for identifying). Need to find a
        //       mobile - friendly alternative.
        const vaults = electron.ipcRenderer.sendSync("vault-list");

        const menu = new Menu();

        for (let vaultKey in vaults) {
            const vault = vaults[vaultKey];

            const vaultPath = normalizePath(vault.path);

            let vaultName = vaultPath.substring(vaultPath.lastIndexOf('/') + 1);

            // We could use the following undocumented function kindly shared
            // by @mnaoumov (https://forum.obsidian.md/t/sharing-plugin-data-between-vaults-stumped-by-override-config-folder/92570/2),
            // to learn a vault's config folder. However, we would still need
            // a fallback '.obsidian' literal to handle the default case of a
            // vault using the normal config folder (because in those cases,
            // the function returns `null`). Having a string literal for the
            // default config folder causes trouble with ObsidianReviewBot on
            // github.
            //const vaultConfigFolderName = App.getOverrideConfigDir(vaultKey);

            const vaultPluginSettingsFilePath = normalizePath([
                vault.path,
                VAULT_LOCAL_SHARED_SETTINGS_FILE_PATH
            ].join(PATH_SEPARATOR));

            if (this.filePathExistsSync(vaultPluginSettingsFilePath)) {
                const vaultPluginSettingsJson =
                    this.readUtf8FileSync(vaultPluginSettingsFilePath);

                if (vaultPluginSettingsJson) {
                    const vaultPluginSettings = JSON.parse(vaultPluginSettingsJson);

                    if (vaultPluginSettings && vaultPluginSettings.nickname && vaultPluginSettings.nickname.trim()) {
                        vaultName = vaultPluginSettings.nickname.trim();
                    }
                }
            }

            menu.addItem((item) =>
                item
                    .setTitle(vaultName)
                    .setChecked(vault.path === this.app.vault.adapter.basePath)
                    .onClick(() =>
                        window.open(`obsidian://open?vault=${vaultKey}`)
                    )
            );
        }

        menu.addSeparator();

        menu.addItem((item) =>
            item
                .setTitle(window.OBSIDIAN_DEFAULT_I18N.interface.manageVaults)
                .setIcon('open-vault')
                .onClick(() =>
                    this.app.commands.executeCommandById('app:open-vault')
                )
        );

        menu.showAtMouseEvent(event);
    }

    /// Invoked when the user context-clicks on the vault switcher drop down.
    /// Adds a "Set nickname" item to the spawned menu as a shortcut to the
    /// plugin's settings page.
    ///
    async onVaultSwitcherContextMenu() {
        if (Platform.isMobile) {
            // Feature doesn't exist on mobile.
            return;
        }

        if (event.shiftKey) {
            // Allow holding the shift key to call the original behavior.
            return;
        }

        event.stopPropagation();

        const menu = new Menu();

        const showInFolderText =
            Platform.isMacOS ?
                window.OBSIDIAN_DEFAULT_I18N.plugins.openWithDefaultApp.actionShowInFolderMac :
                window.OBSIDIAN_DEFAULT_I18N.plugins.openWithDefaultApp.actionShowInFolder;

        menu.addItem((item) =>
            item
                .setTitle(`${showInFolderText}...`)
                .setIcon('lucide-arrow-up-right')
                .onClick(() =>
                    this.app.showInFolder("")
                )
        );

        menu.addSeparator();

        menu.addItem((item) =>
            item
                .setTitle('Vault Nickname settings')
                .setIcon('settings')
                .onClick(() => this.openVaultNicknameSettings())
        );

        menu.showAtMouseEvent(event);
    }

    /// Invoked by the custom "Set nickname" menu item added to the vault
    /// switcher's context menu. Opens the plugins setting page for quick
    /// access to nickname field.
    ///
    async openVaultNicknameSettings() {
        // Open the settings window.
        this.app.commands.executeCommandById('app:open-settings');

        const settingsMenu =
            await this.waitForSelector(window.activeDocument, '.mod-settings', 200);

        if (!settingsMenu) {
            console.error('The vault settings menu was not found after the timeout.');
            return;
        }

        // Wait for any tab item to appear to know when it's go-time to find
        // tab for this plugin.
        const anyTab =
            await this.waitForSelector(window.activeDocument, '.vertical-tab-nav-item', 200);

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
            (this.isEnabled && this.sharedSettings && this.sharedSettings.nickname && this.sharedSettings.nickname.trim()) ?
                this.sharedSettings.nickname.trim() :
                this.app.vault.getName();

        this.setVaultDisplayName(currentVaultName);
    }

    /// Change the display name of the active vault in the workspace's vault
    /// switcher drawer and the app window's title.
    ///
    async setVaultDisplayName(vaultDisplayName: string) {
        const selectedVaultNameElement = await this.getVaultTitleElement();

        if (!selectedVaultNameElement) {
            console.error('Vault name element not found. Cannot apply nickname.');
            return;
        }

        if (selectedVaultNameElement) {
            selectedVaultNameElement.textContent = vaultDisplayName;
        }

        this.setAppTitle(vaultDisplayName);
    }

    /// Change the app's title. This applies the provided vault name and
    /// optionally switches the order of the vault and document names.
    ///
    setAppTitle(vaultDisplayName: string) {
        if (Platform.isMobileApp) {
            return;
        }

        if (this.settings.overrideAppTitle === 'override-app-title:off') {
            this.app.workspace.updateTitle();
            return;
        }

        const titleSeparator = ' - ';

        // Extract Obsidian version from title: "<Vault Name> - Obsidian v.1.7.7"
        const appTitle = this.app.title;
        if (!appTitle) {
            console.error("no this.app.title");
            return;
        }

        const titleParts = appTitle.split(titleSeparator);
        if (!titleParts || titleParts.length < 2) {
            console.error("unexpected title format: " + appTitle);
            return;
        }

        const obsidianVersion = titleParts[titleParts.length - 1];

        // Get the document title
        const documentTitle = (() => {
            const activeEditor = this.app.workspace.activeEditor;
            if (activeEditor && activeEditor.titleEl) {
                return activeEditor.titleEl.textContent;
            }

            // Had tried grabbing this from ".workspace-leaf.mod-active"'s
            // ".view-header-title" for more robus localization support, but
            // encountered timing issues.
            return 'New tab';
        })();

        // Apply the title
        if (this.settings.overrideAppTitle === 'override-app-title:vault-first') {
            window.activeDocument.title = [
                vaultDisplayName,
                documentTitle,
                obsidianVersion
            ].join(titleSeparator);
        }
        else {
            window.activeDocument.title = [
                documentTitle,
                vaultDisplayName,
                obsidianVersion
            ].join(titleSeparator);
        }
    }

    /// Load the vault's nickname. Currently, a hidden file in the root of the
    /// vault is used because it simplifies sharing vault nicknames between
    /// other instances of the plugin.
    ///
    async loadSettings() {
        // Default the nickname to the parent folder's name.
        const loadedSharedSettings: VaultNicknameSharedPluginSettings =
            Object.assign({}, DEFAULT_SHARED_SETTINGS);

        const parentFolderName = this.getVaultParentFolderName();
        if (parentFolderName) {
            loadedSharedSettings.nickname = parentFolderName;
        }

        // Overwrite default nickname with previously saved value.
        const sharedSettingsFilePath = this.getSharedSettingsFilePath();

        if (this.filePathExistsSync(sharedSettingsFilePath)) {
            const settingsJson = this.readUtf8FileSync(sharedSettingsFilePath);

            loadedSharedSettings
                Object.assign(loadedSharedSettings, JSON.parse(settingsJson));
        }

        // Apply the loaded nickname settings.
        this.sharedSettings = loadedSharedSettings;

        this.settings = Object.assign({}, DEFAULT_PLUGIN_SETTINGS, await this.loadData());

        this.refreshVaultDisplayName();
    }

    /// Write the vault's nickname to disk. Currently, a hidden file in the
    /// root of the vault is used because it simplifies sharing vault nicknames
    /// between other instances of the plugin.
    ///
    async saveSettings() {
        const sharedSettingsFilePath = this.getSharedSettingsFilePath();

        if (sharedSettingsFilePath) {
            const sharedSettingsJson = JSON.stringify(this.sharedSettings, null, 2);

            this.writeUtf8FileSync(sharedSettingsFilePath, sharedSettingsJson);
        }

        await this.saveData(this.settings);

        this.refreshVaultDisplayName();
    }

    async getVaultTitleElement(): Promise<Element | null> {
        // A timeout is necessary to reliably grab the title on mobile startup.
        return await this.waitForSelector(
            window.activeDocument,
            Platform.isDesktop ? '.workspace-drawer-vault-name' : '.workspace-drawer-header-name-text',
            200
        );
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
    getSharedSettingsFilePath(): string {
        // Ideally we would use a Vault API to get the TFile of the settings
        // file. However, that API does not support hidden files.
        return [
            this.app.vault.adapter.getBasePath(),
            VAULT_LOCAL_SHARED_SETTINGS_FILE_PATH
        ].join(PATH_SEPARATOR);
    }

    // Using synchronous calls because they prevent momentary flicker when
    // vault nicknames are applied.

    filePathExistsSync(absoluteFilePath : string) : boolean {
        return this.app.vault.adapter.fs.existsSync(absoluteFilePath);
    }

    readUtf8FileSync(absoluteFilePath: string) : string {
        return this.app.vault.adapter.fs.readFileSync(absoluteFilePath, 'utf8');
    }

    writeUtf8FileSync(absoluteFilePath: string, content: string) {
        this.app.vault.adapter.fs.writeFileSync(absoluteFilePath, content, 'utf8');
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
            .setTooltip(
                Platform.isDesktop ?
                    "A vault nickname controls the text shown in the workspace's vault switcher. The 'Manage Vaults' window will continue showing the true vault name as these may be disambiguated by their visible path." :
                    "A vault nickname controls the text shown in the workspace's side panel."
            )
            .addText((textComponent) => {
                // A text field to assign the vault's nickname.
                textComponent
                    .setPlaceholder('No nickname')
                    .setValue(this.plugin.sharedSettings.nickname)
                    .onChange(async newValue => {
                        this.plugin.sharedSettings.nickname = newValue;
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

                        this.plugin.sharedSettings.nickname = parentFolderName;

                        // Refresh the nickname field in the settings window.
                        this.display();

                        await this.plugin.saveSettings();
                    });
            });

        if (Platform.isDesktopApp) {
            new Setting(containerEl)
                .setName('Nickname in app title')
                .setDesc('Position and use of vault nickname in the app title.')
                .addDropdown(dropdownComponent => {
                    dropdownComponent.addOption('override-app-title:off', 'Off');
                    dropdownComponent.addOption('override-app-title:vault-first', 'Vault name first');
                    dropdownComponent.addOption('override-app-title:file-first', 'File name first');

                    dropdownComponent.setValue(this.plugin.settings.overrideAppTitle);

                    dropdownComponent.onChange(async newValue => {
                        this.plugin.settings.overrideAppTitle = newValue;

                        this.plugin.refreshVaultDisplayName();

                        await this.plugin.saveSettings();
                    });
                });
        }
    }
}

