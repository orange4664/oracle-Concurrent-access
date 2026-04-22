# Cookie 管理指南

Oracle 通过 Chrome 浏览器操控 ChatGPT，需要有效的登录 cookies 才能正常工作。

---

## 获取 cookies

### 方法一：从浏览器导出

1. 在本地电脑用 Chrome 登录 https://chatgpt.com
2. 安装浏览器扩展 [EditThisCookie](https://chromewebstore.google.com/detail/editthiscookie) 或 [Cookie-Editor](https://chromewebstore.google.com/detail/cookie-editor)
3. 打开 chatgpt.com，点击扩展图标，导出为 JSON
4. 保存为 `cookies.json`

### 方法二：从 Oracle 本地 profile 导出

如果你本地已经用 Oracle 登录过 ChatGPT：

```bash
# Oracle 的 cookies 存在 browser profile 里
# 用 CDP 从运行中的 Chrome 导出
node -e "
const http = require('http');
http.get('http://127.0.0.1:PORT/json', res => {
  let d = '';
  res.on('data', c => d += c);
  res.on('end', () => {
    const ws = JSON.parse(d)[0].webSocketDebuggerUrl;
    // 用 ws 连接然后调用 Network.getAllCookies
    console.log('WebSocket:', ws);
  });
});
"
```

> 最简单的方式还是方法一，直接从浏览器扩展导出。

---

## cookies.json 格式

Oracle 使用的 cookies.json 是一个数组，每个 cookie 包含以下字段：

```json
[
  {
    "name": "__Secure-next-auth.session-token",
    "value": "eyJhbGc...",
    "domain": ".chatgpt.com",
    "path": "/",
    "secure": true,
    "httpOnly": true,
    "sameSite": "Lax"
  },
  {
    "name": "__cf_bm",
    "value": "abc123...",
    "domain": ".chatgpt.com",
    "path": "/",
    "secure": true,
    "httpOnly": false
  }
]
```

关键 cookie：
- `__Secure-next-auth.session-token` — 登录态，最重要
- `__Secure-next-auth.callback-url` — 回调地址
- `__cf_bm` / `cf_clearance` — Cloudflare 验证

---

## 注入 cookies 到服务器

### 上传到服务器

```bash
scp -i ~/.ssh/your_key cookies.json root@YOUR_SERVER:/root/.oracle/cookies.json
```

### 注入到运行中的 Chrome

```bash
# 找到 Chrome 的 DevTools 端口
PORT=$(cat /root/.oracle/browser-profile/DevToolsActivePort 2>/dev/null | head -1)

# 用注入脚本注入
node /opt/oracle-concurrent/scripts/inject-cookies.js "$PORT" /root/.oracle/cookies.json
```

### inject-cookies.js 原理

脚本通过 Chrome DevTools Protocol (CDP) 的 WebSocket 连接：
1. 连接到 `ws://127.0.0.1:PORT/devtools/page/TARGET_ID`
2. 对每个 cookie 调用 `Network.setCookie`
3. 调用 `Page.navigate` 跳转到 chatgpt.com 使 cookies 生效

---

## 自动注入（systemd）

在 systemd 服务中配置 ExecStartPost，Oracle 启动后自动注入：

```ini
[Service]
ExecStartPost=/opt/inject-cookies-auto.sh
```

`/opt/inject-cookies-auto.sh` 内容：

```bash
#!/bin/bash
# 等 Chrome 启动并写入 DevTools 端口
sleep 5
PORT=$(cat /root/.oracle/browser-profile/DevToolsActivePort 2>/dev/null | head -1)
if [ -z "$PORT" ]; then
    echo "Could not find DevTools port"
    exit 0
fi
node /opt/oracle-concurrent/scripts/inject-cookies.js "$PORT" /root/.oracle/cookies.json
echo "Injected cookies on port $PORT"
```

```bash
chmod +x /opt/inject-cookies-auto.sh
```

---

## Cookie 过期与更新

### 什么时候需要更新

- Oracle 日志出现 `Login check failed` 或 `domLoginCta=true`
- 请求返回错误 `not logged in` 或跳转到登录页
- 一般 session-token 有效期约 1-2 周

### 更新步骤

```bash
# 1. 本地浏览器重新登录 chatgpt.com，导出 cookies

# 2. 上传到服务器
scp -i ~/.ssh/your_key cookies.json root@YOUR_SERVER:/root/.oracle/cookies.json

# 3. 注入到运行中的 Chrome（不需要重启服务）
ssh root@YOUR_SERVER 'PORT=$(cat /root/.oracle/browser-profile/DevToolsActivePort 2>/dev/null | head -1) && node /opt/oracle-concurrent/scripts/inject-cookies.js "$PORT" /root/.oracle/cookies.json'
```

> 注入后不需要重启 Oracle 服务，Chrome 会立即使用新 cookies。

### 如果注入无效

```bash
# 重启 Oracle 服务（会重启 Chrome）
systemctl restart oracle-serve

# 服务启动后会自动通过 ExecStartPost 注入 cookies
```

---

## 方案二（多 Worker）的 Cookie 更新

多 Worker 模式下每个 worker 有独立的 browser profile：

```bash
# 复制 cookies 到所有 worker
for i in 1 2 3; do
  cp /root/.oracle/cookies.json /opt/oracle-worker-$i/.oracle/cookies.json
done

# 注入到所有运行中的 Chrome
bash /opt/oracle-concurrent/scripts/inject-all.sh
```

---

## 常见问题

**Q: 导出的 cookies 里有几十个，都需要吗？**
A: 全部导入即可，inject-cookies.js 会全部注入。关键是 `__Secure-next-auth.session-token`。

**Q: 能不能直接在服务器上登录 ChatGPT？**
A: 可以，但服务器一般没有图形界面。如果有 VNC/Xvfb + 浏览器，可以直接在服务器上登录，Oracle 会自动使用 browser profile 中的登录态。

**Q: 注入 cookies 后还是提示没登录？**
A: 检查 cookies.json 格式是否正确（必须是 JSON 数组），以及 session-token 是否过期。重新从浏览器导出一份最新的。
