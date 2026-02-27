# CollabEdit - 多人协作编程 VSCode 插件

通过 WebSocket 实现多人协作编程，支持文件同步、光标共享、实时编辑同步。

## 功能特性

- 📂 **完整文件同步**：客户端加入时自动同步所有项目文件
- ✏️ **实时编辑同步**：文档编辑实时同步到所有协作者
- 🖱️ **光标和选区共享**：不同颜色显示其他用户的光标位置和选区
- 👥 **侧边栏用户列表**：显示所有协作用户及其正在编辑的文件
- 🔗 **一键跳转**：点击用户可跳转到对方正在编辑的位置
- 👁️ **跟随模式**：自动跟随某个用户的视角
- 📁 **文件变更同步**：文件创建、删除、重命名自动同步
- 💾 **保存同步**：一方保存文件，另一方自动保存

## 使用方式

### Host 端（项目持有者）

1. 在 VSCode 中打开你的项目文件夹
2. 按 `Ctrl+Shift+P` 打开命令面板
3. 执行 `CollabEdit: 开启协作 (Host)`
4. 输入你的用户名
5. 服务器将在默认端口 `18520` 启动
6. 使用 frp 将端口映射到公网：

```ini
# frpc.toml 配置示例
[[proxies]]
name = "collab-edit"
type = "tcp"
localIP = "127.0.0.1"
localPort = 18520
remotePort = 18520
```

### Client 端（协作者）

1. 在 VSCode 中打开一个空文件夹（或已有项目副本的文件夹）
2. 按 `Ctrl+Shift+P` 打开命令面板
3. 执行 `CollabEdit: 加入协作 (Client)`
4. 输入你的用户名
5. 输入服务器地址，如 `ws://hostname:18520`
6. 等待文件同步完成后即可开始协作编辑

### 其他命令

| 命令 | 说明 |
|------|------|
| `CollabEdit: 断开连接` | 断开当前协作连接 |
| `CollabEdit: 跟随用户` | 自动跟随选定用户的视角 |
| `CollabEdit: 取消跟随` | 停止跟随 |

## 配置选项

| 配置项 | 默认值 | 说明 |
|--------|--------|------|
| `collabEdit.port` | `18520` | Host 模式下 WebSocket 服务器端口 |
| `collabEdit.username` | `""` | 协作时显示的用户名（首次使用时会提示输入） |

## 使用 frp + HTTPS

如果你要通过 HTTPS 访问，可以在 frp 服务端配置 TLS：

```ini
# frps.toml (服务端)
bindPort = 7000
vhostHTTPSPort = 443

# frpc.toml (客户端 - Host 端)
[[proxies]]
name = "collab-edit"
type = "https"
localIP = "127.0.0.1"
localPort = 18520
customDomains = ["collab.yourdomain.com"]
```

然后 Client 端连接地址为：`wss://collab.yourdomain.com`

## 开发

```bash
# 安装依赖
npm install

# 编译
npm run compile

# 监听模式编译
npm run watch
```

### 调试

1. 在 VSCode 中打开此项目
2. 按 `F5` 启动扩展开发宿主窗口
3. 在宿主窗口中测试插件功能

## 架构

```
Host 端 (VSCode)                          Client 端 (VSCode)
┌─────────────────┐                        ┌─────────────────┐
│  WebSocket Server│◄── frp 端口映射 ──────│  WebSocket Client│
│  文件监控        │                        │  文件监控        │
│  文档同步        │◄── 实时编辑同步 ──────►│  文档同步        │
│  光标装饰        │◄── 光标/选区同步 ────►│  光标装饰        │
│  用户列表视图    │◄── 用户状态同步 ────►│  用户列表视图    │
└─────────────────┘                        └─────────────────┘
```

## 注意事项

- 插件会自动忽略 `node_modules`、`.git`、`out`、`dist` 等目录
- 二进制文件使用 base64 编码传输
- 心跳检测间隔 30 秒，断线自动重连（最多 10 次）
- 建议在稳定的网络环境下使用
