import {
    App,
    Plugin,
    PluginSettingTab,
    Setting,
    normalizePath,
} from "obsidian";

// Needed for reading nicknames from other vaults.
import {
    existsSync,
    readFileSync,
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

export default class VaultNicknamePlugin extends Plugin {
    settings: VaultNicknamePluginSettings;

    /// The callback invoked whenever the vault switcher is clicked. It is a
    /// bound function and is therefore cached so it can be removed when the
    /// addon is disabled.
    ///
    vaultSwitcherCallback: () => Promise<void>;

    async onload() {
        // Create (but don't register) the vault switcher callback.
        this.vaultSwitcherCallback = this.onVaultSwitcherClicked.bind(this);
        await this.loadSettings();

        this.addSettingTab(new VaultNicknameSettingTab(this.app, this));
        this.app.workspace.onLayoutReady(this.onLayoutReady.bind(this));
    }

    onunload() {
        this.useVaultSwitcherCallback(false);
        this.setSelectedVaultDisplayName(this.app.vault.getName());
    }

    onLayoutReady() {
        this.useVaultSwitcherCallback(true);
        this.refreshSelectedVaultName();
    }

    useVaultSwitcherCallback(use: boolean) {
        const vaultSwitcherElement =
            window.activeDocument.querySelector('.workspace-drawer-vault-switcher');

        if (!vaultSwitcherElement) {
            console.error('Vault switcher element not found. Cannot update its click event.');
            return;
        }

        // Unsubscribe, even when `use` is true to guard against duplicate
        // listeners.
        vaultSwitcherElement.removeEventListener('click', this.vaultSwitcherCallback);

        // Install the vault switcher callback.
        if (use) {
            vaultSwitcherElement.addEventListener('click', this.vaultSwitcherCallback);
        }
    }

    /// Query for a selector. If not found, try observing for
    /// `timeoutMilliseconds` for it to be added, otherwise return `null`.
    ///
    async waitForSelector(selector: string, timeoutMilliseconds: number) : Promise<Element|null> {
        return new Promise<Element|null>(resolve => {
            if (window.activeDocument.querySelector(selector)) {
                return resolve(document.querySelector(selector));
            }

            const timeout = setTimeout(() => {
                resolve(null);
            }, timeoutMilliseconds);

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
        const vaultList = electron.ipcRenderer.sendSync("vault-list");
        if (!vaultList) {
            console.error('Failed to retrieve list of known vaults.');
        }

        // Determine the correct path separator used by this system.
        const platformPathSeparator = function () {
            const platform = window.navigator.platform;
            return (platform === "Win32" || platform === "Win64") ?  '\\' : '/';
        }();

        // Pair each vault to its menu item and apply its nickname.
        // This applies the vault's nickname even if the nickname plugin is
        // disabled in that value.
        const vaults = Object.values(vaultList);
        const menuItems = vaultSwitcherMenu.querySelectorAll('.menu-item');
        const min = Math.min(menuItems.length, vaults.length);
        for (let i = 0; i < min; ++i) {
            const vault = vaults[i];

            const titleElement = menuItems[i].querySelector('.menu-item-title');
            if (!titleElement) {
                console.error('No title element for this vault: ' + vault.path);
                continue;
            }

            const vaultPluginSettingsFilePath = normalizePath([
                vault.path,
                '.obsidian',
                'plugins',
                this.manifest.id,
                'data.json'
            ].join(platformPathSeparator));

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

    /// Refresh the text for the active vault in the workspace's vault switcher
    /// drawer. If no nickname exists for the active vault, the label will
    /// fallback to the vault's folder name.
    ///
    refreshSelectedVaultName() {
        const currentVaultName =
            (this.settings.nickname && this.settings.nickname.trim()) ?
                this.settings.nickname.trim() :
                this.app.vault.getName();

        this.setSelectedVaultDisplayName(currentVaultName);
    }

    /// Change the display name of the active vault in the workspace's vault
    /// switcher drawer.
    ///
    setSelectedVaultDisplayName(displayName: string) {
        const selectedVaultNameElement = window.activeDocument.querySelector('.workspace-drawer-vault-name');

        if (selectedVaultNameElement) {
            selectedVaultNameElement.textContent = displayName;
        }
    }

    async loadSettings() {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());

        this.refreshSelectedVaultName();
    }

    async saveSettings() {
        await this.saveData(this.settings);

        this.refreshSelectedVaultName();
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
                textComponent
                    .setPlaceholder('No nickname')
                    .setValue(this.plugin.settings.nickname)
                    .onChange(async newValue => {
                        this.plugin.settings.nickname = newValue;
                        await this.plugin.saveSettings();
                    })
            });
    }
}

