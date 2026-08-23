# Text Typer — OpenDeck Plugin

Type text with a configurable per-character delay, an optional key press before typing (e.g. to open a game's chat), and an optional Enter at the end — all in a single, reliable action.

Built to solve a common problem with OpenDeck Multi Actions: chained steps (hotkey → text → enter) don't reliably wait for each other, causing garbled or out-of-order input. This plugin runs the whole sequence in one action, controlled entirely by the plugin itself.

## Features

- Optional key press before typing (e.g. `T` to open a game chat), simulated at the **hardware input level** via the Windows `SendInput` API — works even in games that use DirectInput/RawInput and ignore standard simulated keystrokes (tested with the RAGE engine / GTA V / FiveM)
- Text typed via **clipboard paste** by default (reliable, no dropped/duplicated characters), or via simulated keystrokes with a configurable per-character delay
- Optional Enter after typing
- Configurable delay between the key press and the typed text
- Original clipboard content is automatically restored after typing

## Requirements

- Windows 10/11
- [OpenDeck](https://openaction.io) with Node.js support (Node.js must be installed natively on the system — OpenDeck spawns Node.js plugins using the system installation)

Also confirmed working with **Soomfon's Stream Controller** software (same OpenAction-compatible plugin format).

## Installation

1. Download the latest release zip from the [Releases](../../releases) page.
2. In OpenDeck, go to **Plugins → Install from file**, and select the downloaded zip.
3. Fully restart OpenDeck (quit from the system tray, not just close the window).
4. The **Text Typer** category will appear in the action list. Drag **Type Text** onto a button.
5. Open the button's property inspector, fill in your text and options.

## Building from source

```bash
git clone https://github.com/<your-username>/opendeck-texttyper.git
cd opendeck-texttyper/com.tylerdurden67.texttyper.sdPlugin
npm install --omit=dev
```
Then copy the whole `com.tylerdurden67.texttyper.sdPlugin` folder (including `node_modules`) into your OpenDeck plugins directory.

## How it works

The plugin backend is a small Node.js process (`bin/plugin.js`) that connects to OpenDeck over WebSocket using the Stream Deck-compatible SDK protocol. On key press, it spawns a short PowerShell script (STA mode, for reliable clipboard access) that:

1. Optionally simulates a key press via a small inline C# helper calling `user32.dll`'s `SendInput` — a real hardware-level keyboard event, unlike `SendKeys` (which sends ordinary Windows messages that many games simply don't listen to).
2. Waits a configurable delay.
3. Sets the clipboard to the configured text and simulates Ctrl+V (also via `SendInput`).
4. Optionally presses Enter.
5. Restores the clipboard to whatever it contained before.

## License

MIT — see [LICENSE](LICENSE).

## Support

If this saved you some clicks, you can [buy me a coffee](https://paypal.me/TylerDurden67) ☕.
