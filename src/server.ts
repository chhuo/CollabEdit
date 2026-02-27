import * as http from 'http';
import * as vscode from 'vscode';
import { WebSocketServer, WebSocket } from 'ws';
import { EventEmitter } from 'events';
import {
    CollabMessage, MessageType, UserInfo, USER_COLORS,
    serializeMessage, deserializeMessage,
} from './protocol';
import { generateUserId } from './utils';

/** 客户端连接信息 */
interface ClientConnection {
    ws: WebSocket;
    user: UserInfo;
    isAlive: boolean;
}

/** CollabEdit WebSocket 服务器（Host端） */
export class CollabServer extends EventEmitter {
    private httpServer: http.Server | null = null;
    private wss: WebSocketServer | null = null;
    private clients: Map<string, ClientConnection> = new Map();
    private heartbeatInterval: NodeJS.Timeout | null = null;
    private colorIndex = 0;
    private port: number;
    private hostUser: UserInfo;

    constructor(port: number, username: string) {
        super();
        this.port = port;
        this.hostUser = {
            userId: generateUserId(),
            username: username,
            color: USER_COLORS[0],
            activeFile: null,
            cursor: null,
            selections: [],
        };
        this.colorIndex = 1;
    }

    /** 获取 Host 用户信息 */
    getHostUser(): UserInfo {
        return this.hostUser;
    }

    /** 获取所有用户（包括 Host） */
    getAllUsers(): UserInfo[] {
        const users = [this.hostUser];
        for (const client of this.clients.values()) {
            users.push(client.user);
        }
        return users;
    }

    /** 启动服务器 */
    async start(): Promise<void> {
        return new Promise((resolve, reject) => {
            this.httpServer = http.createServer((req, res) => {
                // 简单的 HTTP 健康检查端点
                if (req.url === '/health') {
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({
                        status: 'ok',
                        users: this.getAllUsers().length,
                    }));
                } else {
                    res.writeHead(200, { 'Content-Type': 'text/plain' });
                    res.end('CollabEdit Server Running');
                }
            });

            this.wss = new WebSocketServer({ server: this.httpServer });

            this.wss.on('connection', (ws: WebSocket) => {
                this.handleConnection(ws);
            });

            this.wss.on('error', (error) => {
                vscode.window.showErrorMessage(`WebSocket 服务器错误: ${error.message}`);
            });

            this.httpServer.listen(this.port, () => {
                vscode.window.showInformationMessage(
                    `CollabEdit 服务器已启动，端口: ${this.port}`
                );
                this.startHeartbeat();
                resolve();
            });

            this.httpServer.on('error', (error: NodeJS.ErrnoException) => {
                if (error.code === 'EADDRINUSE') {
                    reject(new Error(`端口 ${this.port} 已被占用，请更换端口`));
                } else {
                    reject(error);
                }
            });
        });
    }

    /** 处理新连接 */
    private handleConnection(ws: WebSocket): void {
        let clientId: string | null = null;

        ws.on('message', (data: Buffer | string) => {
            const rawData = typeof data === 'string' ? data : data.toString();
            const msg = deserializeMessage(rawData);
            if (!msg) { return; }

            if (msg.type === MessageType.Join) {
                // 新用户加入
                const color = USER_COLORS[this.colorIndex % USER_COLORS.length];
                this.colorIndex++;

                const user: UserInfo = {
                    userId: msg.userId,
                    username: msg.username,
                    color: color,
                    activeFile: null,
                    cursor: null,
                    selections: [],
                };

                clientId = msg.userId;
                this.clients.set(clientId, { ws, user, isAlive: true });

                // 发送加入确认
                this.sendTo(clientId, {
                    type: MessageType.JoinAck,
                    userId: msg.userId,
                    color: color,
                    users: this.getAllUsers(),
                });

                // 广播新用户加入
                this.broadcastExcept(clientId, {
                    type: MessageType.UserJoined,
                    user: user,
                });

                // 通知 Host
                this.emit('userJoined', user);
                this.emit('usersChanged', this.getAllUsers());

                vscode.window.showInformationMessage(`用户 ${msg.username} 加入了协作`);

            } else if (msg.type === MessageType.Heartbeat) {
                if (clientId && this.clients.has(clientId)) {
                    this.clients.get(clientId)!.isAlive = true;
                    this.sendTo(clientId, { type: MessageType.HeartbeatAck });
                }
            } else {
                // 处理其他消息
                this.handleClientMessage(clientId, msg);
            }
        });

        ws.on('close', () => {
            if (clientId) {
                this.removeClient(clientId);
            }
        });

        ws.on('error', (error) => {
            console.error(`WebSocket error for client ${clientId}:`, error);
            if (clientId) {
                this.removeClient(clientId);
            }
        });
    }

    /** 处理客户端消息 */
    private handleClientMessage(clientId: string | null, msg: CollabMessage): void {
        if (!clientId) { return; }

        switch (msg.type) {
            case MessageType.CursorUpdate: {
                // 更新用户光标并广播
                const client = this.clients.get(clientId);
                if (client) {
                    client.user.cursor = msg.cursor;
                    client.user.selections = msg.selections;
                }
                this.broadcastExcept(clientId, msg);
                this.emit('cursorUpdate', msg);
                break;
            }
            case MessageType.ActiveFileChange: {
                const client = this.clients.get(clientId);
                if (client) {
                    client.user.activeFile = msg.path;
                }
                this.broadcastExcept(clientId, msg);
                this.emit('activeFileChange', msg);
                this.emit('usersChanged', this.getAllUsers());
                break;
            }
            case MessageType.DocEdit: {
                // 转发文档编辑到所有其他客户端和 Host
                this.broadcastExcept(clientId, msg);
                this.emit('docEdit', msg);
                break;
            }
            case MessageType.FileCreate: {
                this.broadcastExcept(clientId, msg);
                this.emit('fileCreate', msg);
                break;
            }
            case MessageType.FileDelete: {
                this.broadcastExcept(clientId, msg);
                this.emit('fileDelete', msg);
                break;
            }
            case MessageType.FileRename: {
                this.broadcastExcept(clientId, msg);
                this.emit('fileRename', msg);
                break;
            }
            case MessageType.FileSave: {
                this.broadcastExcept(clientId, msg);
                this.emit('fileSave', msg);
                break;
            }
            case MessageType.FileManifestRequest: {
                this.emit('fileManifestRequest', clientId);
                break;
            }
            case MessageType.FileRequest: {
                this.emit('fileRequest', clientId, msg.paths);
                break;
            }
            default:
                // 转发到其他客户端
                this.broadcastExcept(clientId, msg);
                break;
        }
    }

    /** 移除客户端 */
    private removeClient(clientId: string): void {
        const client = this.clients.get(clientId);
        if (client) {
            this.clients.delete(clientId);

            // 广播用户离开
            this.broadcast({
                type: MessageType.UserLeft,
                userId: clientId,
            });

            this.emit('userLeft', client.user);
            this.emit('usersChanged', this.getAllUsers());

            vscode.window.showInformationMessage(`用户 ${client.user.username} 离开了协作`);
        }
    }

    /** 发送消息到指定客户端 */
    sendTo(userId: string, msg: CollabMessage): void {
        const client = this.clients.get(userId);
        if (client && client.ws.readyState === WebSocket.OPEN) {
            client.ws.send(serializeMessage(msg));
        }
    }

    /** 广播消息到所有客户端 */
    broadcast(msg: CollabMessage): void {
        const data = serializeMessage(msg);
        for (const client of this.clients.values()) {
            if (client.ws.readyState === WebSocket.OPEN) {
                client.ws.send(data);
            }
        }
    }

    /** 广播消息到除指定客户端外的所有客户端 */
    broadcastExcept(excludeUserId: string, msg: CollabMessage): void {
        const data = serializeMessage(msg);
        for (const [userId, client] of this.clients.entries()) {
            if (userId !== excludeUserId && client.ws.readyState === WebSocket.OPEN) {
                client.ws.send(data);
            }
        }
    }

    /** 启动心跳检测 */
    private startHeartbeat(): void {
        this.heartbeatInterval = setInterval(() => {
            for (const [userId, client] of this.clients.entries()) {
                if (!client.isAlive) {
                    client.ws.terminate();
                    this.removeClient(userId);
                    continue;
                }
                client.isAlive = false;
                if (client.ws.readyState === WebSocket.OPEN) {
                    client.ws.ping();
                }
            }
        }, 30000);
    }

    /** 更新 Host 用户信息 */
    updateHostUser(update: Partial<UserInfo>): void {
        Object.assign(this.hostUser, update);
    }

    /** 停止服务器 */
    async stop(): Promise<void> {
        if (this.heartbeatInterval) {
            clearInterval(this.heartbeatInterval);
            this.heartbeatInterval = null;
        }

        // 关闭所有客户端连接
        for (const client of this.clients.values()) {
            client.ws.close(1000, 'Server shutting down');
        }
        this.clients.clear();

        return new Promise((resolve) => {
            if (this.wss) {
                this.wss.close(() => {
                    if (this.httpServer) {
                        this.httpServer.close(() => {
                            resolve();
                        });
                    } else {
                        resolve();
                    }
                });
            } else {
                resolve();
            }
        });
    }

    /** 服务器是否正在运行 */
    isRunning(): boolean {
        return this.httpServer !== null && this.httpServer.listening;
    }
}
