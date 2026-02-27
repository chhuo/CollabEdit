import * as vscode from 'vscode';
import WebSocket from 'ws';
import { EventEmitter } from 'events';
import {
    CollabMessage, MessageType, UserInfo,
    serializeMessage, deserializeMessage,
} from './protocol';
import { generateUserId } from './utils';

/** CollabEdit WebSocket 客户端 */
export class CollabClient extends EventEmitter {
    private ws: WebSocket | null = null;
    private heartbeatTimer: NodeJS.Timeout | null = null;
    private reconnectTimer: NodeJS.Timeout | null = null;
    private url: string;
    private userId: string;
    private username: string;
    private color: string = '';
    private users: UserInfo[] = [];
    private connected: boolean = false;
    private shouldReconnect: boolean = true;
    private reconnectAttempts: number = 0;
    private maxReconnectAttempts: number = 10;

    constructor(url: string, username: string) {
        super();
        this.url = url;
        this.username = username;
        this.userId = generateUserId();
    }

    /** 获取用户 ID */
    getUserId(): string {
        return this.userId;
    }

    /** 获取用户名 */
    getUsername(): string {
        return this.username;
    }

    /** 获取用户颜色 */
    getColor(): string {
        return this.color;
    }

    /** 获取当前用户列表 */
    getUsers(): UserInfo[] {
        return this.users;
    }

    /** 是否已连接 */
    isConnected(): boolean {
        return this.connected;
    }

    /** 连接到服务器 */
    async connect(): Promise<void> {
        return new Promise((resolve, reject) => {
            try {
                // 将 http/https 转换为 ws/wss
                let wsUrl = this.url;
                if (wsUrl.startsWith('https://')) {
                    wsUrl = 'wss://' + wsUrl.slice(8);
                } else if (wsUrl.startsWith('http://')) {
                    wsUrl = 'ws://' + wsUrl.slice(7);
                } else if (!wsUrl.startsWith('ws://') && !wsUrl.startsWith('wss://')) {
                    wsUrl = 'ws://' + wsUrl;
                }

                this.ws = new WebSocket(wsUrl, {
                    rejectUnauthorized: false, // 允许自签名证书
                });

                this.ws.on('open', () => {
                    this.connected = true;
                    this.reconnectAttempts = 0;

                    // 发送加入消息
                    this.send({
                        type: MessageType.Join,
                        userId: this.userId,
                        username: this.username,
                    });

                    this.startHeartbeat();
                    vscode.window.showInformationMessage('已连接到协作服务器');
                });

                this.ws.on('message', (data: Buffer | string) => {
                    const rawData = typeof data === 'string' ? data : data.toString();
                    const msg = deserializeMessage(rawData);
                    if (!msg) { return; }
                    this.handleMessage(msg, resolve);
                });

                this.ws.on('close', (code, reason) => {
                    this.connected = false;
                    this.stopHeartbeat();
                    this.emit('disconnected', code, reason.toString());

                    if (this.shouldReconnect && this.reconnectAttempts < this.maxReconnectAttempts) {
                        this.scheduleReconnect();
                    }
                });

                this.ws.on('error', (error) => {
                    console.error('WebSocket 客户端错误:', error);
                    if (!this.connected) {
                        reject(error);
                    }
                    this.emit('error', error);
                });

            } catch (error) {
                reject(error);
            }
        });
    }

    /** 处理接收到的消息 */
    private handleMessage(msg: CollabMessage, resolveConnect?: (value: void) => void): void {
        switch (msg.type) {
            case MessageType.JoinAck: {
                this.color = msg.color;
                this.users = msg.users;
                this.emit('joined', msg);
                this.emit('usersChanged', this.users);
                if (resolveConnect) {
                    resolveConnect();
                }
                break;
            }
            case MessageType.UserJoined: {
                this.users.push(msg.user);
                this.emit('userJoined', msg.user);
                this.emit('usersChanged', this.users);
                vscode.window.showInformationMessage(`用户 ${msg.user.username} 加入了协作`);
                break;
            }
            case MessageType.UserLeft: {
                this.users = this.users.filter(u => u.userId !== msg.userId);
                this.emit('userLeft', msg.userId);
                this.emit('usersChanged', this.users);
                break;
            }
            case MessageType.UserList: {
                this.users = msg.users;
                this.emit('usersChanged', this.users);
                break;
            }
            case MessageType.HeartbeatAck: {
                // 心跳回复，连接正常
                break;
            }
            case MessageType.FileManifest: {
                this.emit('fileManifest', msg);
                break;
            }
            case MessageType.FileContent: {
                this.emit('fileContent', msg);
                break;
            }
            case MessageType.FileCreate: {
                this.emit('fileCreate', msg);
                break;
            }
            case MessageType.FileDelete: {
                this.emit('fileDelete', msg);
                break;
            }
            case MessageType.FileRename: {
                this.emit('fileRename', msg);
                break;
            }
            case MessageType.FileSave: {
                this.emit('fileSave', msg);
                break;
            }
            case MessageType.SyncComplete: {
                this.emit('syncComplete');
                break;
            }
            case MessageType.DocEdit: {
                this.emit('docEdit', msg);
                break;
            }
            case MessageType.DocFullContent: {
                this.emit('docFullContent', msg);
                break;
            }
            case MessageType.CursorUpdate: {
                // 更新本地用户列表中的光标信息
                const user = this.users.find(u => u.userId === msg.userId);
                if (user) {
                    user.cursor = msg.cursor;
                    user.selections = msg.selections;
                }
                this.emit('cursorUpdate', msg);
                break;
            }
            case MessageType.ActiveFileChange: {
                const user2 = this.users.find(u => u.userId === msg.userId);
                if (user2) {
                    user2.activeFile = msg.path;
                }
                this.emit('activeFileChange', msg);
                this.emit('usersChanged', this.users);
                break;
            }
            case MessageType.Error: {
                vscode.window.showErrorMessage(`协作错误: ${msg.message}`);
                break;
            }
        }
    }

    /** 发送消息 */
    send(msg: CollabMessage): void {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(serializeMessage(msg));
        }
    }

    /** 启动心跳 */
    private startHeartbeat(): void {
        this.heartbeatTimer = setInterval(() => {
            this.send({ type: MessageType.Heartbeat });
        }, 25000);
    }

    /** 停止心跳 */
    private stopHeartbeat(): void {
        if (this.heartbeatTimer) {
            clearInterval(this.heartbeatTimer);
            this.heartbeatTimer = null;
        }
    }

    /** 计划重连 */
    private scheduleReconnect(): void {
        this.reconnectAttempts++;
        const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30000);

        vscode.window.showWarningMessage(
            `连接断开，${delay / 1000}秒后重试 (${this.reconnectAttempts}/${this.maxReconnectAttempts})`
        );

        this.reconnectTimer = setTimeout(async () => {
            try {
                await this.connect();
            } catch {
                // 重连失败，会在 close 事件中再次尝试
            }
        }, delay);
    }

    /** 断开连接 */
    disconnect(): void {
        this.shouldReconnect = false;

        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }

        this.stopHeartbeat();

        if (this.ws) {
            this.ws.close(1000, 'User disconnect');
            this.ws = null;
        }

        this.connected = false;
        this.users = [];
        this.emit('disconnected', 1000, 'User disconnect');
    }
}
