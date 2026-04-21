import { rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import os from "node:os";
import net from "node:net";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import CDP from "chrome-remote-interface";
import { launch, Launcher } from "chrome-launcher";
import { cleanupStaleProfileState } from "./profileState.js";
import { delay } from "./utils.js";
const execFileAsync = promisify(execFile);
export async function launchChrome(config, userDataDir, logger) {
    const connectHost = resolveRemoteDebugHost();
    const debugBindAddress = connectHost && connectHost !== "127.0.0.1" ? "0.0.0.0" : connectHost;
    const debugPort = config.debugPort ?? parseDebugPortEnv();
    const chromeFlags = buildChromeFlags(config.headless ?? false, debugBindAddress);
    const usePatchedLauncher = Boolean(connectHost && connectHost !== "127.0.0.1");
    const launcher = usePatchedLauncher
        ? await launchWithCustomHost({
            chromeFlags,
            chromePath: config.chromePath ?? undefined,
            userDataDir,
            host: connectHost ?? "127.0.0.1",
            requestedPort: debugPort ?? undefined,
        })
        : await launch({
            chromePath: config.chromePath ?? undefined,
            chromeFlags,
            userDataDir,
            handleSIGINT: false,
            port: debugPort ?? undefined,
        });
    const pidLabel = typeof launcher.pid === "number" ? ` (pid ${launcher.pid})` : "";
    const hostLabel = connectHost ? ` on ${connectHost}` : "";
    logger(`Launched Chrome${pidLabel} on port ${launcher.port}${hostLabel}`);
    return Object.assign(launcher, { host: connectHost ?? "127.0.0.1" });
}
export function registerTerminationHooks(chrome, userDataDir, keepBrowser, logger, opts) {
    const signals = ["SIGINT", "SIGTERM", "SIGQUIT"];
    let handling;
    const handleSignal = (signal) => {
        if (handling) {
            return;
        }
        handling = true;
        const inFlight = opts?.isInFlight?.() ?? false;
        const leaveRunning = keepBrowser || inFlight;
        if (leaveRunning) {
            logger(`Received ${signal}; leaving Chrome running${inFlight ? " (assistant response pending)" : ""}`);
        }
        else {
            logger(`Received ${signal}; terminating Chrome process`);
        }
        void (async () => {
            if (leaveRunning) {
                // Ensure reattach hints are written before we exit.
                await opts?.emitRuntimeHint?.().catch(() => undefined);
                if (inFlight) {
                    logger('Session still in flight; reattach with "oracle session <slug>" to continue.');
                }
            }
            else {
                try {
                    await chrome.kill();
                }
                catch {
                    // ignore kill failures
                }
                if (opts?.preserveUserDataDir) {
                    // Preserve the profile directory (manual login), but clear reattach hints so we don't
                    // try to reuse a dead DevTools port on the next run.
                    await cleanupStaleProfileState(userDataDir, logger, { lockRemovalMode: "never" }).catch(() => undefined);
                }
                else {
                    await rm(userDataDir, { recursive: true, force: true }).catch(() => undefined);
                }
            }
        })().finally(() => {
            const exitCode = signal === "SIGINT" ? 130 : 1;
            // Vitest treats any `process.exit()` call as an unhandled failure, even if mocked.
            // Keep production behavior (hard-exit on signals) while letting tests observe state changes.
            process.exitCode = exitCode;
            const isTestRun = process.env.VITEST === "1" || process.env.NODE_ENV === "test";
            if (!isTestRun) {
                process.exit(exitCode);
            }
        });
    };
    for (const signal of signals) {
        process.on(signal, handleSignal);
    }
    return () => {
        for (const signal of signals) {
            process.removeListener(signal, handleSignal);
        }
    };
}
export async function hideChromeWindow(chrome, logger) {
    if (process.platform !== "darwin") {
        logger("Window hiding is only supported on macOS");
        return;
    }
    if (!chrome.pid) {
        logger("Unable to hide window: missing Chrome PID");
        return;
    }
    const script = `tell application "System Events"
    try
      set visible of (first process whose unix id is ${chrome.pid}) to false
    end try
  end tell`;
    try {
        await execFileAsync("osascript", ["-e", script]);
        logger("Chrome window hidden (Cmd-H)");
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger(`Failed to hide Chrome window: ${message}`);
    }
}
export async function connectToChrome(port, logger, host) {
    const client = await CDP({ port, host });
    logger("Connected to Chrome DevTools protocol");
    return client;
}
export async function connectToRemoteChrome(host, port, logger, targetUrl) {
    if (targetUrl) {
        const targetConnection = await connectToNewTarget(host, port, targetUrl, logger, {
            opened: () => `Opened dedicated remote Chrome tab targeting ${targetUrl}`,
            openFailed: (message) => `Failed to open dedicated remote Chrome tab (${message}); falling back to first target.`,
            attachFailed: (targetId, message) => `Failed to attach to dedicated remote Chrome tab ${targetId} (${message}); falling back to first target.`,
            closeFailed: (targetId, message) => `Failed to close unused remote Chrome tab ${targetId}: ${message}`,
        });
        if (targetConnection) {
            return { client: targetConnection.client, targetId: targetConnection.targetId };
        }
    }
    const fallbackClient = await CDP({ host, port });
    logger(`Connected to remote Chrome DevTools protocol at ${host}:${port}`);
    return { client: fallbackClient };
}
export async function closeRemoteChromeTarget(host, port, targetId, logger) {
    if (!targetId) {
        return;
    }
    try {
        await CDP.Close({ host, port, id: targetId });
        if (logger.verbose) {
            logger(`Closed remote Chrome tab ${targetId}`);
        }
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger(`Failed to close remote Chrome tab ${targetId}: ${message}`);
    }
}
async function connectToNewTarget(host, port, url, logger, messages) {
    try {
        const target = await CDP.New({ host, port, url });
        try {
            const client = await CDP({ host, port, target: target.id });
            if (messages.opened) {
                logger(messages.opened(target.id));
            }
            return { client, targetId: target.id };
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            logger(messages.attachFailed(target.id, message));
            try {
                await CDP.Close({ host, port, id: target.id });
            }
            catch (closeError) {
                const closeMessage = closeError instanceof Error ? closeError.message : String(closeError);
                logger(messages.closeFailed(target.id, closeMessage));
            }
        }
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger(messages.openFailed(message));
    }
    return null;
}
export async function connectWithNewTab(port, logger, initialUrl, host, options) {
    const effectiveHost = host ?? "127.0.0.1";
    const url = initialUrl ?? "about:blank";
    const fallbackToDefault = options?.fallbackToDefault ?? true;
    const retries = Math.max(0, options?.retries ?? 0);
    const retryDelayMs = Math.max(0, options?.retryDelayMs ?? 250);
    const fallbackLabel = fallbackToDefault
        ? "falling back to default target."
        : "strict mode: not falling back.";
    let attempt = 0;
    while (attempt <= retries) {
        const targetConnection = await connectToNewTarget(effectiveHost, port, url, logger, {
            opened: (targetId) => `Opened isolated browser tab (target=${targetId})`,
            openFailed: (message) => `Failed to open isolated browser tab (${message}); ${fallbackLabel}`,
            attachFailed: (targetId, message) => `Failed to attach to isolated browser tab ${targetId} (${message}); ${fallbackLabel}`,
            closeFailed: (targetId, message) => `Failed to close unused browser tab ${targetId}: ${message}`,
        });
        if (targetConnection) {
            return targetConnection;
        }
        if (attempt >= retries) {
            break;
        }
        attempt += 1;
        await delay(retryDelayMs * attempt);
    }
    if (!fallbackToDefault) {
        throw new Error("Failed to open isolated browser tab; refusing to attach to default target.");
    }
    const client = await connectToChrome(port, logger, effectiveHost);
    return { client };
}
export async function closeTab(port, targetId, logger, host) {
    const effectiveHost = host ?? "127.0.0.1";
    try {
        await CDP.Close({ host: effectiveHost, port, id: targetId });
        logger(`Closed isolated browser tab (target=${targetId})`);
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger(`Failed to close browser tab ${targetId}: ${message}`);
    }
}
function buildChromeFlags(headless, debugBindAddress) {
    const flags = [
        "--disable-background-networking",
        "--disable-background-timer-throttling",
        "--disable-breakpad",
        "--disable-client-side-phishing-detection",
        "--disable-default-apps",
        "--disable-hang-monitor",
        "--disable-popup-blocking",
        "--disable-prompt-on-repost",
        "--disable-sync",
        "--disable-translate",
        "--metrics-recording-only",
        "--no-first-run",
        "--safebrowsing-disable-auto-update",
        "--disable-features=TranslateUI,AutomationControlled",
        "--mute-audio",
        "--window-size=1280,720",
        "--lang=en-US",
        "--accept-lang=en-US,en",
    ];
    if (process.platform !== "win32" && !isWsl()) {
        flags.push("--password-store=basic", "--use-mock-keychain");
    }
    if (debugBindAddress) {
        flags.push(`--remote-debugging-address=${debugBindAddress}`);
    }
    if (headless) {
        flags.push("--headless=new");
    }
    return flags;
}
function parseDebugPortEnv() {
    const raw = process.env.ORACLE_BROWSER_PORT ?? process.env.ORACLE_BROWSER_DEBUG_PORT;
    if (!raw)
        return null;
    const value = Number.parseInt(raw, 10);
    if (!Number.isFinite(value) || value <= 0 || value > 65535) {
        return null;
    }
    return value;
}
function resolveRemoteDebugHost() {
    const override = process.env.ORACLE_BROWSER_REMOTE_DEBUG_HOST?.trim() || process.env.WSL_HOST_IP?.trim();
    if (override) {
        return override;
    }
    if (!isWsl()) {
        return null;
    }
    try {
        const resolv = readFileSync("/etc/resolv.conf", "utf8");
        for (const line of resolv.split("\n")) {
            const match = line.match(/^nameserver\s+([0-9.]+)/);
            if (match?.[1]) {
                return match[1];
            }
        }
    }
    catch {
        // ignore; fall back to localhost
    }
    return null;
}
function isWsl() {
    if (process.platform !== "linux") {
        return false;
    }
    if (process.env.WSL_DISTRO_NAME) {
        return true;
    }
    const release = os.release();
    return release.toLowerCase().includes("microsoft");
}
async function launchWithCustomHost({ chromeFlags, chromePath, userDataDir, host, requestedPort, }) {
    const launcher = new Launcher({
        chromePath: chromePath ?? undefined,
        chromeFlags,
        userDataDir,
        handleSIGINT: false,
        port: requestedPort ?? undefined,
    });
    if (host) {
        const patched = launcher;
        patched.isDebuggerReady = function patchedIsDebuggerReady() {
            const debugPort = this.port ?? 0;
            if (!debugPort) {
                return Promise.reject(new Error("Missing Chrome debug port"));
            }
            return new Promise((resolve, reject) => {
                const client = net.createConnection({ port: debugPort, host });
                const cleanup = () => {
                    client.removeAllListeners();
                    client.end();
                    client.destroy();
                    client.unref();
                };
                client.once("error", (err) => {
                    cleanup();
                    reject(err);
                });
                client.once("connect", () => {
                    cleanup();
                    resolve();
                });
            });
        };
    }
    await launcher.launch();
    const kill = async () => launcher.kill();
    return {
        pid: launcher.pid ?? undefined,
        port: launcher.port ?? 0,
        process: launcher.chromeProcess,
        kill,
        host: host ?? undefined,
        remoteDebuggingPipes: launcher.remoteDebuggingPipes,
    };
}
