# Bugfix Notes

## Bug 1: payload.options undefined
payload.options.verbose crashes when client omits options field. Fix: use optional chaining payload.options?.verbose (3 places). Already fixed in oracle-multi-tab/.

## Bug 2: preferManualLogin not set on Linux
On bare Linux, preferManualLogin is false. Oracle tries cookie extraction instead of reusing Chrome profile. Fix: patch compiled JS to force preferManualLogin = true.

## Bug 3: Chrome needs --no-sandbox on Linux
launchManualLoginChrome has its own chromeFlags array without --no-sandbox. Fix: add it.

## Bug 4: Proxy flag
If server needs proxy, add --proxy-server=socks5://127.0.0.1:1080 to same chromeFlags.

## Bug 5: Use python3 not sed
sed breaks on complex JS strings. Use python3 str.replace() for all compiled JS patches.

## Bug 6: OOM with multiple Chrome instances
Each Chrome ~600-800MB. Use multi-tab (single Chrome, multiple tabs via CDP) instead. ~550MB total.

## Bug 7: Cookie injection timing
ExecStartPost must wait for DevToolsActivePort file before injecting cookies.

## Bug 8: pnpm/npm build failures
node-pty needs native build tools. Workaround: npm install -g oracle normally, then overwrite compiled server.js.

## Quick Deploy
1. npm install -g git+https://github.com/orange4664/oracle.git
2. cp oracle-multi-tab/dist/src/remote/server.js over installed one
3. Patch: preferManualLogin=true, --no-sandbox, proxy (use python3)
4. oracle serve --port 3080 --token YOUR_TOKEN --max-concurrent 3
