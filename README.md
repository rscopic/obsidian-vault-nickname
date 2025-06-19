# Vault Nickname, a plugin for [Obsidian](https://obsidian.md/)

<img src="https://media.githubusercontent.com/media/rscopic/obsidian-vault-nickname/master/docs/media/vault-nickname-feature.png" style="vertical-align: middle;"/>

## Features:
* Customize a vault's display name without renaming its folder.
* Choice to change the app's title to display vault names before the active document's name.
  * E.g., "**\<Vault\>** - **\<Document\>**" rather than the default "**\<Document\>** - **\<Vault\>**"
* A "Set nickname" shortcut found in the vault switcher's context menu provides quick access to the settings (PC-only).  
   <img src="https://media.githubusercontent.com/media/rscopic/obsidian-vault-nickname/master/docs/media/vault-nickname-settings-quick-access.png" />

## Motive:
This plugin is intended to help disambiguate vaults that share the same folder name. This is common for users who adhere to a standard file structure between multiple projects. E.g., "docs/", "Obsidian/", etc.

## Supporters:

Big thank you to [@claremacrae](https://github.com/claremacrae) for her generous github sponsorship! ❤️

## Install guide:
1. Open Obsidian's **Settings**.
2. Choose **Community plugins** from the left side bar.
3. If Restricted Mode is enabled, tap **Turn on community plugins** to disable it. Otherwise, skip this step.
4. Tap **Browse**.
5. Type `Vault Nickname` in the search bar.
6. Tap the **Vault Nickname** plugin.
7. Tap **Install**.
8. Tap **Enable**.
9. Tap **Options** to enter your custom nickname.
10. Done!

> [!IMPORTANT]  
> 🚨 Vault Nickname must be installed in each vault where you wish to see other vault nicknames from.
>
> This is required because plugins can only affect the user interface of vaults where they're installed. If a vault doesn't need a nickname itself, but needs to see other vaults' nicknames, you may still install the plugin and simply clear the nickname field for the already-correct vault.

## Plugin settings:
<img src="https://media.githubusercontent.com/media/rscopic/obsidian-vault-nickname/master/docs/media/vault-nickname-settings.png" />

### Vault nickname

The name to display instead of the vault's folder name. When this is blank, the vault's display name will fallback to its default value (its folder name). The button next to this setting assigns the vault's parent folder's name as the nickname. The parent folder's name is treated as the default nickname when the plugin is installed.

### Nickname in app title

Choose how the nickname is applied to the app's title. The default value is "File name first" which is consistent with Obsidian's default behavior except the vault's nickname will be used.
