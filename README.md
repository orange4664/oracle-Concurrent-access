# Oracle Concurrent Access

让 Oracle (ChatGPT browser automation) 支持多并发。提供两种方案，均为本仓库的修改，非 Oracle 内置功能。

| | 方案一：多标签页 | 方案二：多 Worker + Dispatcher |
|---|---|---|
| 内存 | ~550MB（1 个 Chrome） | ~2GB+（3 个 Chrome） |
| 最低内存 | 1GB | 4GB |
| 并发方式 | 标签页共享 profile lock（提交串行，等待并行） | 完全独立 |
| 排队 | 内置队列，最多 25 人，NDJSON 进度更新 | Dispatcher 队列，最多 20 人，NDJSON 进度更新 |
| 部署复杂度 | 覆盖 1 个文件 + 打补丁 | 4 个 systemd 服务 |

**推荐方案一**，除非你内存充足（4GB+）且需要完全独立的 worker。

---

## 方案一：多标签页（推荐）

单个 Chrome 进程，多个隔离标签页，内置排队。

```
Client --POST /runs--> Oracle serve (:3080, --max-concurrent 3)
                         |-- Tab 1 -> chatgpt.com
                         |-- Tab 2 -> chatgpt.com
                         +-- Tab 3 -> chatgpt.com
                         +-- Queue (max 25, FIFO)
```

### 原理

修改 Oracle 的 `server.ts` 和 `oracle-cli.ts`（非内置功能，需覆盖编译文件部署）：

- `busy` 布尔值替换为 `activeRuns` 计数器 + `maxConcurrent` 上限
- 新增 `--max-concurrent <number>` CLI 参数
- 每个请求通过 CDP `connectWithNewTab` 打开隔离标签页
- Profile lock 只锁提交阶段（输入 + 发送），等待回复阶段并行
- 满并发时进入 FIFO 队列（最多 25），客户端收到 NDJSON 排队进度
- 队列满时返回 503 `queue_full`

### 排队机制

| NDJSON 事件 | 含义 |
|-------------|------|
| `{"type":"queue","position":1,"totalSlots":3}` | 进入队列，显示排队位置 |
| `{"type":"queue_update","position":N,"total":M}` | 队列推进，位置更新 |
| `{"type":"queue_done"}` | 轮到你了，开始处理 |
| HTTP 503 `queue_full` | 队列已满（25），请稍后重试 |

### 部署

```bash
# 1. 安装 oracle
npm install -g git+https://github.com/orange4664/oracle.git

# 2. 用修改版 server.js 覆盖安装的版本
git clone https://github.com/orange4664/oracle-Concurrent-access.git
cp oracle-Concurrent-access/oracle-multi-tab/dist/src/remote/server.js \
   /usr/lib/node_modules/@steipete/oracle/dist/src/remote/server.js

# 3. Linux 服务器补丁（用 python3，不要用 sed，见 BUGFIX.md）
python3 << 'PATCH'
p = '/usr/lib/node_modules/@steipete/oracle/dist/src/remote/server.js'
c = open(p).read()
# 强制 preferManualLogin = true（Linux 上必须）
c = c.replace(
    'const preferManualLogin = options.manualLoginDefault || process.platform === "win32" || isWsl();',
    'const preferManualLogin = true;'
)
# Chrome 加 --no-sandbox（root 用户必须）
c = c.replace(
    '"--no-first-run",\n                "--no-default-browser-check",',
    '"--no-first-run",\n                "--no-default-browser-check",\n                "--no-sandbox",'
)
# 如果需要代理，取消下面的注释：
# c = c.replace('"--no-sandbox",', '"--no-sandbox",\n                "--proxy-server=socks5://127.0.0.1:1080",')
open(p, 'w').write(c)
print('Patched')
PATCH

# 4. 准备 cookies
mkdir -p ~/.oracle/browser-profile
# 把 cookies.json 放到 ~/.oracle/

# 5. 启动（3 并发，排队最多 25）
oracle serve --port 3080 --token YOUR_TOKEN --max-concurrent 3
```

### systemd 服务示例

```ini
[Unit]
Description=Oracle serve
After=network.target

[Service]
ExecStartPre=/bin/rm -f /root/.oracle/browser-profile/DevToolsActivePort
ExecStart=/usr/bin/oracle serve --port 3080 --token YOUR_TOKEN --max-concurrent 3
ExecStartPost=/opt/inject-cookies-auto.sh
Environment=DISPLAY=:99
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

### Cookie 注入

```bash
PORT=$(cat ~/.oracle/browser-profile/DevToolsActivePort 2>/dev/null | head -1)
node scripts/inject-cookies.js "$PORT" ~/.oracle/cookies.json
```

---

## 方案二：多 Worker + Dispatcher

多个 Chrome 实例，前面放一个负载均衡 dispatcher + 请求队列。同样是本仓库自行实现，非 Oracle 内置。

```
Client -> Dispatcher (:3080) -> Worker 1 (:3081) -> Chrome + ChatGPT
                              -> Worker 2 (:3082) -> Chrome + ChatGPT
                              -> Worker 3 (:3083) -> Chrome + ChatGPT
                              -> Queue (max 20, FIFO)
```

> **Warning:** 每个 Chrome 实例 ~600-800MB 内存，至少需要 4GB RAM。

### 部署

```bash
# 1. 安装 oracle
npm install -g git+https://github.com/orange4664/oracle.git

# 2. 克隆本仓库
git clone https://github.com/orange4664/oracle-Concurrent-access.git /opt/oracle-concurrent
cd /opt/oracle-concurrent

# 3. 设置 token
export ORACLE_TOKEN=your-token-here

# 4. 运行 setup（创建 3 个 worker 目录 + 4 个 systemd 服务）
bash scripts/setup.sh
```

### 前置条件

- Oracle CLI 已安装
- Xvfb 运行中（headed Chrome 需要）
- 如需代理则配置 SOCKS proxy
- ChatGPT cookies 在 `/root/.oracle/cookies.json`

### Cookie 更新

```bash
for i in 1 2 3; do
  cp /root/.oracle/cookies.json /opt/oracle-worker-$i/.oracle/cookies.json
done
bash /opt/oracle-concurrent/scripts/inject-all.sh
```

### 服务管理

```bash
systemctl status oracle-dispatcher oracle-worker-{1,2,3}
systemctl restart oracle-worker-{1,2,3} oracle-dispatcher
journalctl -u oracle-dispatcher -f
```

### Dispatcher API

| Endpoint | Auth | Description |
|----------|------|-------------|
| `GET /status` | No | 存活检查 |
| `GET /queue` | No | 队列和 worker 状态 |
| `GET /health` | Bearer | 认证健康检查 |
| `POST /runs` | Bearer | 提交请求（代理到 worker 或排队） |

### 排队机制

1. 所有 worker 忙 -> 进入队列，客户端收到 NDJSON: `{"type":"queue","position":1,...}`
2. 队列推进 -> 客户端收到: `{"type":"queue_update","position":N,...}`
3. worker 空闲 -> 请求被代理，NDJSON 响应直接透传
4. 队列满（默认 20）-> HTTP 503
5. 排队超时（默认 5 分钟）-> 超时错误

### Dispatcher 配置

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `DISPATCH_PORT` | 3080 | Dispatcher 端口 |
| `WORKER_PORTS` | 3081,3082,3083 | Worker 端口列表 |
| `ORACLE_TOKEN` | (空) | Bearer token |
| `MAX_QUEUE` | 20 | 最大排队数 |
| `WORKER_TIMEOUT` | 180000 | 单请求超时 (ms) |
| `QUEUE_TIMEOUT` | 300000 | 排队超时 (ms) |

---

## 踩坑记录

部署过程中遇到的所有坑和修复方法见 [BUGFIX.md](BUGFIX.md)。

## License

MIT
