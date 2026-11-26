# 部署拓扑与远程访问（公网服务器 / Tailscale / 反向隧道）

默认情况下，Tycho 只监听本机回环地址 `127.0.0.1:8787`。根据你的网络条件，Tycho 原生支持四种部署拓扑，从单机试用到 24×7 公网多机编排无缝切换。

## 方案速选

| 方案 | 适用场景 | 需要公网服务器？ | 手机 PWA / 跨网节点 |
| --- | --- | :---: | :---: |
| **方案 1：公网云服务器 / VPS 直接部署（推荐主力）** | 24×7 在线中枢，连接办公 PC、家用 Mac、云端 GPU 与手机 | 是（任意 1 核 Linux VPS） | ✅ 原生 HTTPS 随时连 |
| **方案 2：Tailscale / WireGuard / 局域网直连** | 零公网暴露的私有组网或可信内网 | 否 | ✅ 组网内直接连 |
| **方案 3：NAT 反向隧道门牌（SSH / WSS :443）** | 主机必须留在公司内网或家用 NAS（无公网 IP） | 是（仅作轻量转发） | ✅ 零入站端口穿透 |

---

## 方案 1：公网云服务器 / VPS 直接部署（推荐 24×7 方案）

将 Tycho 主机直接部署在一台带公网 IP 和域名的 Linux 云服务器（如 Ubuntu / Debian）上，所有工作站、笔记本和手机均作为客户端/节点接入。

### 第 1 步：在云主机以普通用户安装并设为后台常驻

> [!IMPORTANT]
> 请使用普通 Linux 用户（如 `ubuntu`、`lighthouse` 等），**不要使用 `root`**。

```bash
curl -fsSL https://github.com/XaineChaeson/tycho/releases/latest/download/install.sh | bash
tycho service install           # 装为 systemd 用户服务，默认监听 127.0.0.1:8787
loginctl enable-linger "$USER"  # 确保退出 SSH 后服务 24×7 常驻
tycho status                    # 确认状态为「正在运行」
```

### 第 2 步：配置 Nginx（或 Caddy）HTTPS 反向代理

主机继续只监听 `127.0.0.1:8787`，由同机 Nginx 终结 TLS（证书可用 Certbot / acme.sh 自动签发）：

```nginx
server {
    listen 80;
    listen [::]:80;
    server_name tycho.example.com;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl;
    listen [::]:443 ssl;
    server_name tycho.example.com;

    ssl_certificate     /etc/letsencrypt/live/tycho.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/tycho.example.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:8787;
        proxy_http_version 1.1;
        proxy_set_header Connection "";
        proxy_set_header Host              $host;
        proxy_set_header X-Forwarded-For   $remote_addr;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_buffering off;   # SSE 实时流必需
        proxy_cache off;
        proxy_read_timeout 1h;
        proxy_send_timeout 1h;
        client_max_body_size 10m;
    }
}
```

重载配置：

```bash
sudo nginx -t && sudo systemctl reload nginx
```

### 第 3 步：首次登录并绑定对外 HTTPS 地址

1. 在云主机终端取一条一次性登录链接：
   ```bash
   tycho open --print
   ```
2. 把输出的 `http://127.0.0.1:8787/login#<凭据>` 前缀替换成你的域名 `https://tycho.example.com/login#<凭据>`，在本地电脑或手机浏览器打开并点 **「进入」**。
3. 打开 **「设置 › 服务」**，将 **对外地址（`http.publicUrl`）** 设为 `https://tycho.example.com` 并保存（立即生效；之后企微、`tycho open --print` 和节点接入命令都会自动带这个域名）。

### 第 4 步：从任意网络接入你的执行机器与多端客户端

- **接入你的 Windows / macOS / Linux 工作机**：
  ```bash
  # 在工作机安装 Tycho 后执行：
  tycho node join --to https://tycho.example.com
  ```
  在已登录的控制台左下角点击 **「放行」** 输入屏幕上的 6 位验证码；成功后执行 `tycho node service install` 设为开机自启。
- **云主机自身也可以兼任执行节点**：在云主机上再执行一次 `tycho node join --to http://127.0.0.1:8787 && tycho node service install`。
- **手机与桌面端**：用手机 Safari / Chrome 打开 `https://tycho.example.com` 安装为全屏 PWA，或下载 3.6 MB 桌面壳填入该域名即可（详见 [客户端指南](../clients.md)）。

---

## 方案 2：Tailscale / WireGuard 或局域网直连

不想把控制台暴露到公网时，在主机登录控制台打开 **「设置 › 服务」**：

1. **监听地址（`http.host`）**：改为 `0.0.0.0`（确保主机防火墙仅放行局域网或 Tailscale 网卡）。
2. **对外地址（`http.publicUrl`）**：填组网地址，例如 `https://my-host.tailnet.ts.net` 或 `http://192.168.1.10:8787`（不带路径）。
3. 重启主机服务（`tycho stop && tycho service start`）。
4. 其他设备打开对外地址，点击 **「在这台设备上登录」** 获取 6 位码并在已登录设备放行即可。

---

## 方案 3：NAT 反向隧道门牌（主机留在内网，零入站端口）

当主机必须跑在公司内网工作站或家用 NAS（无公网 IP、无法直连）时，可借一台轻量公网中转机做「门牌」，主机主动外连建立加密隧道，**主机侧零入站端口**。

> [!TIP]
> **公司防火墙封锁 22 端口怎么办？** Tycho 内置了基于 RFC 6455 的 **SSH-over-WebSocket (`:443`) 桥接器**（`service/gateway-ws-bridge.ts`），支持直接走 `443` TLS 端口或穿透公司 `HTTPS_PROXY` 代理，同时完整保留 OpenSSH `authorized_keys` 最小权限边界。

### 1. 公网中转机配置专用受限 SSH 用户

在 `/etc/ssh/sshd_config` 追加并重载（`sudo sshd -t && sudo systemctl reload sshd`）：

```text
Match User tycho-gw
    AuthenticationMethods publickey
    AllowTcpForwarding remote
    AllowStreamLocalForwarding no
    MaxSessions 0
    ClientAliveInterval 15
    ClientAliveCountMax 2
```

### 2. 主机生成专用私钥并在中转机锁定监听端口

在主机运行 `ssh-keygen -t ed25519 -f ~/.tycho/gateway_ed25519 -N ""`，将 `.pub` 内容写入中转机 `~tycho-gw/.ssh/authorized_keys` 并加上最小权限限制：

```text
restrict,port-forwarding,permitlisten="127.0.0.1:18787" ssh-ed25519 AAAA... tycho-host
```

中转机 Nginx 按方案 1 配置，仅将 `proxy_pass` 改为 `http://127.0.0.1:18787;`。

### 3. 在控制台启用门牌

1. **「设置 › 服务」**：`http.publicUrl` 设为 `https://tycho.example.com`（监听地址保持 `127.0.0.1`）。
2. **「设置 › 门牌」**：填入私钥路径 `gateway.keyFile`、`gateway.remotePort` (`18787`)、`gateway.localPort` (`8788`)，最后填 `gateway.ssh`（`tycho-gw@your-relay`）并保存（无需重启服务）。
3. **成功标志**：运行 `tycho doctor` 看到门牌状态为 **已连接**。

### 误改配置把自己锁在外面怎么办？

SSH 登录主机运行 `tycho open --print` 取本机回环链接；若主机无浏览器，在本地电脑做一次临时端口转发后打开：

```bash
ssh -N -L 127.0.0.1:18788:127.0.0.1:8787 user@your-host
```

把链接前缀换成 `http://127.0.0.1:18788` 登录后即可恢复配置。
