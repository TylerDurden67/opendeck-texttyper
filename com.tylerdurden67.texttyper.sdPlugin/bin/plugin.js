// Text Typer - backend Node.js pour OpenDeck
// Tape un texte (avec delai reglable entre chaque caractere), appuie
// eventuellement sur une touche avant de taper (ex: "T" pour ouvrir un chat
// de jeu), et valide avec Entree si demande. Tout se passe dans UNE SEULE
// action, executee sequentiellement par ce process - contrairement a une
// Multi Action OpenDeck (qui n'attend pas qu'une etape finisse avant de
// lancer la suivante), ce qui evite les frappes qui se melangent.

const WebSocket = require("ws");
const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");
const os = require("os");

const ACTION_UUID = "com.tylerdurden67.texttyper.type";

function getArg(name) {
	const idx = process.argv.indexOf(name);
	return idx !== -1 ? process.argv[idx + 1] : null;
}

const port = getArg("-port");
const pluginUUID = getArg("-pluginUUID");
const registerEvent = getArg("-registerEvent");

if (!port || !pluginUUID || !registerEvent) {
	console.error("Arguments manquants (-port / -pluginUUID / -registerEvent). Ce script est lance par OpenDeck, pas manuellement.");
	process.exit(1);
}

const ws = new WebSocket(`ws://127.0.0.1:${port}`);

const settingsByContext = new Map();
const busyContexts = new Set(); // evite deux frappes simultanees sur le meme bouton

function send(payload) {
	if (ws.readyState === WebSocket.OPEN) {
		ws.send(JSON.stringify(payload));
	}
}

function logMessage(message) {
	send({ event: "logMessage", payload: { message: String(message) } });
}

function showOk(context) {
	send({ event: "showOk", context });
}

function showAlert(context) {
	send({ event: "showAlert", context });
}

function setSettings(context, settings) {
	send({ event: "setSettings", context, payload: settings });
}

function sendToPropertyInspector(context, payload) {
	send({ event: "sendToPropertyInspector", context, payload });
}

function openUrl(url) {
	send({ event: "openUrl", payload: { url } });
}

ws.on("open", () => {
	send({ event: registerEvent, uuid: pluginUUID });
});

ws.on("error", (err) => {
	console.error("Erreur WebSocket:", err);
});

ws.on("close", () => {
	process.exit(0);
});

ws.on("message", (data) => {
	let msg;
	try {
		msg = JSON.parse(data.toString());
	} catch (e) {
		return;
	}

	const { event, context, payload, action } = msg;
	if (action && action !== ACTION_UUID) return;

	switch (event) {
		case "willAppear": {
			settingsByContext.set(context, (payload && payload.settings) || {});
			break;
		}
		case "willDisappear": {
			settingsByContext.delete(context);
			break;
		}
		case "didReceiveSettings": {
			settingsByContext.set(context, (payload && payload.settings) || {});
			break;
		}
		case "keyDown": {
			const settings = (payload && payload.settings) || settingsByContext.get(context) || {};
			handleKeyDown(context, settings);
			break;
		}
		case "sendToPlugin": {
			if (payload && payload.command === "openUrl" && payload.url) {
				openUrl(payload.url);
			}
			break;
		}
		case "propertyInspectorDidAppear": {
			const settings = settingsByContext.get(context) || {};
			sendToPropertyInspector(context, { command: "currentSettings", settings });
			break;
		}
		default:
			break;
	}
});

// ---- Table des touches speciales -> code VK (virtual-key Windows) ----
const VK = {
	enter: 0x0D, return: 0x0D,
	tab: 0x09,
	esc: 0x1B, escape: 0x1B,
	space: 0x20,
	backspace: 0x08, bs: 0x08,
	delete: 0x2E, del: 0x2E,
	home: 0x24, end: 0x23,
	up: 0x26, down: 0x28, left: 0x25, right: 0x27,
	pageup: 0x21, pagedown: 0x22,
	insert: 0x2D,
	f1: 0x70, f2: 0x71, f3: 0x72, f4: 0x73, f5: 0x74, f6: 0x75,
	f7: 0x76, f8: 0x77, f9: 0x78, f10: 0x79, f11: 0x7A, f12: 0x7B
};
const VK_CTRL = 0x11;
const VK_V = 0x56;

// Resout le champ "touche avant" en code VK Windows. Une lettre/chiffre simple
// est mappe sur son code VK (A-Z = 0x41-0x5A, 0-9 = 0x30-0x39).
function resolveVkCode(rawKey) {
	if (!rawKey) return null;
	const key = rawKey.trim();
	if (key.length === 0) return null;
	const lower = key.toLowerCase();
	if (VK[lower] !== undefined) return VK[lower];
	if (key.length === 1) {
		const c = key.toUpperCase().charCodeAt(0);
		if (c >= 0x30 && c <= 0x39) return c; // 0-9
		if (c >= 0x41 && c <= 0x5A) return c; // A-Z
	}
	return null;
}

function handleKeyDown(context, settings) {
	if (busyContexts.has(context)) {
		return; // une frappe est deja en cours pour ce bouton, on ignore le double-appui
	}

	const text = settings.text || "";
	const pressEnter = !!settings.pressEnter;
	const preKeyRaw = settings.preKey || "";
	const delayBeforeTyping = clampInt(settings.delayBeforeTyping, 0, 5000, 300);
	const delayPerChar = clampInt(settings.delayPerChar, 0, 500, 15);
	const useClipboard = settings.useClipboard !== false; // true par defaut

	if (!text && !preKeyRaw) {
		logMessage("Text Typer: rien a taper (texte vide et aucune touche configuree).");
		showAlert(context);
		return;
	}

	const preKeyVk = resolveVkCode(preKeyRaw);

	busyContexts.add(context);

	if (useClipboard) {
		runClipboardPaste(preKeyVk, text, pressEnter, delayBeforeTyping, (err) => {
			busyContexts.delete(context);
			if (err) {
				logMessage(`Text Typer: erreur - ${err.message}`);
				showAlert(context);
			} else {
				showOk(context);
			}
		});
	} else {
		runPowerShell(preKeyVk, text, pressEnter, delayBeforeTyping, delayPerChar, (err) => {
			busyContexts.delete(context);
			if (err) {
				logMessage(`Text Typer: erreur - ${err.message}`);
				showAlert(context);
			} else {
				showOk(context);
			}
		});
	}
}

function clampInt(value, min, max, fallback) {
	const n = parseInt(value, 10);
	if (Number.isNaN(n)) return fallback;
	return Math.min(max, Math.max(min, n));
}

function buildPowerShellScript(tmpDir, preKeyVk, text, pressEnter, delayBeforeTyping, delayPerChar) {
	const csFile = path.join(tmpDir, "InputSim.cs");
	fs.writeFileSync(csFile, INPUT_SIM_CSHARP, "utf8");

	const lines = [`Add-Type -Path '${psEscape(csFile)}'`, "Add-Type -AssemblyName System.Windows.Forms"];

	if (preKeyVk !== null) {
		lines.push(`[InputSim]::KeyDown(${preKeyVk})`);
		lines.push("Start-Sleep -Milliseconds 40");
		lines.push(`[InputSim]::KeyUp(${preKeyVk})`);
		if (delayBeforeTyping > 0) {
			lines.push(`Start-Sleep -Milliseconds ${delayBeforeTyping}`);
		}
	}

	const chars = Array.from(text).map(escapeSendKeysChar);
	for (const ch of chars) {
		lines.push(`[System.Windows.Forms.SendKeys]::SendWait('${psEscape(ch)}')`);
		if (delayPerChar > 0) {
			lines.push(`Start-Sleep -Milliseconds ${delayPerChar}`);
		}
	}

	if (pressEnter) {
		lines.push(`[InputSim]::KeyPress(${VK.enter})`);
	}

	return lines.join("\r\n");
}

// Echappe un caractere pour la syntaxe SendKeys ( + ^ % ~ ( ) { } [ ] sont speciaux)
function escapeSendKeysChar(ch) {
	if ("+^%~(){}[]".includes(ch)) {
		return "{" + ch + "}";
	}
	return ch;
}

// Echappe une simple quote pour l'inserer dans une chaine PowerShell entre quotes simples
function psEscape(s) {
	return s.replace(/'/g, "''");
}

// Classe C# compilee a la volee par PowerShell : simule des frappes au niveau
// materiel via l'API Windows SendInput, plutot que les messages Windows
// classiques de SendKeys. Les jeux qui lisent le clavier en DirectInput/
// RawInput (comme le moteur RAGE de GTA V/FiveM) ignorent SendKeys mais
// reagissent a SendInput, qui simule un vrai evenement clavier materiel.
const INPUT_SIM_CSHARP = `
using System;
using System.Runtime.InteropServices;

public class InputSim {
    [DllImport("user32.dll", SetLastError = true)]
    static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);

    [DllImport("user32.dll")]
    static extern uint MapVirtualKey(uint uCode, uint uMapType);

    [StructLayout(LayoutKind.Sequential)]
    struct INPUT { public uint type; public KEYBDINPUT ki; public ulong padding; }

    [StructLayout(LayoutKind.Sequential)]
    struct KEYBDINPUT {
        public ushort wVk;
        public ushort wScan;
        public uint dwFlags;
        public uint time;
        public IntPtr dwExtraInfo;
    }

    const uint INPUT_KEYBOARD = 1;
    const uint KEYEVENTF_KEYUP = 0x0002;
    const uint KEYEVENTF_SCANCODE = 0x0008;
    const uint MAPVK_VK_TO_VSC = 0;

    // Envoie un evenement clavier via son scan code materiel (obtenu depuis le
    // virtual-key avec MapVirtualKey), et non juste le virtual-key seul :
    // certains jeux (RAGE/GTA V-FiveM notamment) lisent le clavier au niveau
    // scan code brut pour leurs raccourcis globaux et ignorent un evenement
    // qui ne porte qu'un virtual-key sans scan code associe.
    static void KeyEvent(ushort vk, bool keyUp) {
        ushort scan = (ushort)MapVirtualKey(vk, MAPVK_VK_TO_VSC);
        INPUT[] inputs = new INPUT[1];
        inputs[0].type = INPUT_KEYBOARD;
        uint flags = KEYEVENTF_SCANCODE | (keyUp ? KEYEVENTF_KEYUP : 0);
        inputs[0].ki = new KEYBDINPUT { wVk = 0, wScan = scan, dwFlags = flags, time = 0, dwExtraInfo = IntPtr.Zero };
        SendInput(1, inputs, Marshal.SizeOf(typeof(INPUT)));
    }

    public static void KeyDown(ushort vk) { KeyEvent(vk, false); }
    public static void KeyUp(ushort vk) { KeyEvent(vk, true); }

    public static void KeyPress(ushort vk) {
        KeyDown(vk);
        KeyUp(vk);
    }
}
`;

function runClipboardPaste(preKeyVk, text, pressEnter, delayBeforeTyping, callback) {
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "texttyper-"));
	const textFile = path.join(tmpDir, "text.txt");
	const csFile = path.join(tmpDir, "InputSim.cs");
	const scriptFile = path.join(tmpDir, "paste.ps1");

	fs.writeFileSync(textFile, text, "utf8");
	fs.writeFileSync(csFile, INPUT_SIM_CSHARP, "utf8");

	const lines = [];
	lines.push(`Add-Type -Path '${psEscape(csFile)}'`);
	lines.push("Add-Type -AssemblyName System.Windows.Forms");
	lines.push("$prevClip = $null");
	lines.push("try { $prevClip = Get-Clipboard -Raw -ErrorAction SilentlyContinue } catch {}");

	if (preKeyVk !== null) {
		lines.push(`[InputSim]::KeyDown(${preKeyVk})`);
		lines.push("Start-Sleep -Milliseconds 40");
		lines.push(`[InputSim]::KeyUp(${preKeyVk})`);
		if (delayBeforeTyping > 0) {
			lines.push(`Start-Sleep -Milliseconds ${delayBeforeTyping}`);
		}
	}

	lines.push(`Get-Content -Raw -LiteralPath '${psEscape(textFile)}' | Set-Clipboard`);
	lines.push("Start-Sleep -Milliseconds 120");
	// Ctrl+V simule via SendInput (chord: Ctrl down, V, Ctrl up)
	lines.push(`[InputSim]::KeyDown(${VK_CTRL})`);
	lines.push("Start-Sleep -Milliseconds 25");
	lines.push(`[InputSim]::KeyPress(${VK_V})`);
	lines.push("Start-Sleep -Milliseconds 25");
	lines.push(`[InputSim]::KeyUp(${VK_CTRL})`);
	lines.push("Start-Sleep -Milliseconds 150");

	if (pressEnter) {
		lines.push(`[InputSim]::KeyPress(${VK.enter})`);
		lines.push("Start-Sleep -Milliseconds 80");
	}

	// Restaure le presse-papier d'origine pour ne pas polluer ce que l'utilisateur avait copie
	lines.push("if ($null -ne $prevClip) { Set-Clipboard -Value $prevClip } else { Set-Clipboard -Value '' }");

	fs.writeFileSync(scriptFile, lines.join("\r\n"), "utf8");

	const child = spawn("powershell.exe", [
		"-NoProfile",
		"-STA",
		"-WindowStyle", "Hidden",
		"-ExecutionPolicy", "Bypass",
		"-File", scriptFile
	], { windowsHide: true });

	child.on("error", (err) => {
		cleanup();
		callback(err);
	});

	child.on("close", (code) => {
		cleanup();
		if (code !== 0) {
			callback(new Error(`PowerShell a quitte avec le code ${code}`));
		} else {
			callback(null);
		}
	});

	function cleanup() {
		try {
			fs.rmSync(tmpDir, { recursive: true, force: true });
		} catch (e) {
			// ignore
		}
	}
}

function runPowerShell(preKeyVk, text, pressEnter, delayBeforeTyping, delayPerChar, callback) {
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "texttyper-"));
	const scriptFile = path.join(tmpDir, "type.ps1");
	const script = buildPowerShellScript(tmpDir, preKeyVk, text, pressEnter, delayBeforeTyping, delayPerChar);
	fs.writeFileSync(scriptFile, script, "utf8");

	const child = spawn("powershell.exe", [
		"-NoProfile",
		"-WindowStyle", "Hidden",
		"-ExecutionPolicy", "Bypass",
		"-File", scriptFile
	], { windowsHide: true });

	child.on("error", (err) => {
		cleanup();
		callback(err);
	});

	child.on("close", (code) => {
		cleanup();
		if (code !== 0) {
			callback(new Error(`PowerShell a quitte avec le code ${code}`));
		} else {
			callback(null);
		}
	});

	function cleanup() {
		try {
			fs.rmSync(tmpDir, { recursive: true, force: true });
		} catch (e) {
			// ignore
		}
	}
}
