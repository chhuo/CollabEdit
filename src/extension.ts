import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import { CollabServer } from './server';
import { CollabClient } from './client';
import { FileSync } from './fileSync';
import { FileWatcher, FileChangeType } from './fileWatcher';
import { DocumentSync } from './documentSync';
import { CursorDecorator } from './cursorDecorator';
import { UserTreeDataProvider, UserTreeItem } from './userTreeView';
import {
    MessageType, UserInfo,
    CursorUpdateMessage, ActiveFileChangeMessage,
    DocEditMessage, FileCreateMessage, FileDeleteMessage,
    FileRenameMessage, FileSaveMessage, FileManifestMessage,
    FileContentMessage,
} from './protocol';
import { toRelativePath, throttle } from './utils';

/** 当前会话模式 */
type SessionMode = 'none' | 'host' | 'client';

/** 插件全局状态 */
let mode: SessionMode = 'none';
let server: CollabServer | null = null;
let client: CollabClient | null = null;
let fileSync: FileSync | null = null;
let fileWatcher: FileWatcher | null = null;
let documentSync: DocumentSync | null = null;
let cursorDecorator: CursorDecorator | null = null;
let userTreeProvider: UserTreeDataProvider;
let followingUserId: string | null = null;
let statusBarItem: vscode.StatusBarItem;
let disposables: vscode.Disposable[] = [];

export function activate(context: vscode.ExtensionContext) {
    console.log('CollabEdit 插件已激活');

    // 创建侧边栏视图
    userTreeProvider = new UserTreeDataProvider();
    const treeView = vscode.window.createTreeView('collabEditUsers', {
        treeDataProvider: userTreeProvider,
    });
    context.subscriptions.push(treeView);

    // 创建状态栏
    statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    statusBarItem.text = '$(organization) CollabEdit: 未连接';
    statusBarItem.show();
    context.subscriptions.push(statusBarItem);

    // 注册命令
    context.subscriptions.push(
        vscode.commands.registerCommand('collabEdit.startHost', startHost),
        vscode.commands.registerCommand('collabEdit.joinSession', joinSession),
        vscode.commands.registerCommand('collabEdit.disconnect', disconnect),
        vscode.commands.registerCommand('collabEdit.followUser', followUser),
        vscode.commands.registerCommand('collabEdit.unfollowUser', unfollowUser),
        vscode.commands.registerCommand('collabEdit.gotoUser', gotoUser),
    );
}

/** 获取工作区根目录 */
function getWorkspaceRoot(): string | null {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) {
        vscode.window.showErrorMessage('请先打开一个文件夹/工作区');
        return null;
    }
    return folders[0].uri.fsPath;
}

/** 获取用户名（始终弹出输入框，预填上次保存的值） */
async function getUsername(): Promise<string | null> {
    const config = vscode.workspace.getConfiguration('collabEdit');
    const savedUsername = config.get<string>('username', '') || os.userInfo().username || 'User';

    const username = await vscode.window.showInputBox({
        prompt: '请输入你的协作用户名',
        value: savedUsername,
        validateInput: (value) => {
            if (!value || value.trim().length === 0) {
                return '用户名不能为空';
            }
            return null;
        },
    });

    if (!username) {
        return null; // 用户取消了输入
    }

    // 保存用户名供下次使用
    await config.update('username', username, vscode.ConfigurationTarget.Global);
    return username;
}

// ============================================================
// Host 模式
// ============================================================

async function startHost() {
    if (mode !== 'none') {
        vscode.window.showWarningMessage('请先断开当前连接');
        return;
    }

    const workspaceRoot = getWorkspaceRoot();
    if (!workspaceRoot) { return; }

    const username = await getUsername();
    if (!username) { return; }

    const config = vscode.workspace.getConfiguration('collabEdit');
    const port = config.get<number>('port', 18520);

    try {
        // 创建服务器
        server = new CollabServer(port, username);
        await server.start();
        mode = 'host';

        const hostUser = server.getHostUser();

        // 初始化文件同步
        fileSync = new FileSync(workspaceRoot);

        // 初始化文件监控
        fileWatcher = new FileWatcher(workspaceRoot);
        fileWatcher.start();

        // 初始化文档同步
        documentSync = new DocumentSync(workspaceRoot, hostUser.userId);
        documentSync.start();

        // 初始化光标装饰
        cursorDecorator = new CursorDecorator(workspaceRoot);

        // 更新 UI
        statusBarItem.text = `$(broadcast) Host: ${port} | ${username}`;
        userTreeProvider.updateUsers(server.getAllUsers(), hostUser.userId);

        // 绑定服务器事件
        setupHostEvents(workspaceRoot, hostUser);

        // 绑定本地编辑器事件
        setupLocalEditorEvents(workspaceRoot, hostUser.userId);

        vscode.window.showInformationMessage(
            `协作服务器已启动！端口: ${port}。请使用 frp 映射此端口供其他人连接。`
        );

        // 发送当前活跃文件（如果有）
        const activeEditor = vscode.window.activeTextEditor;
        if (activeEditor && activeEditor.document.uri.scheme === 'file') {
            const relativePath = toRelativePath(activeEditor.document.uri.fsPath, workspaceRoot);
            server.updateHostUser({ activeFile: relativePath });
            userTreeProvider.updateUsers(server.getAllUsers(), hostUser.userId);
        }

    } catch (error: any) {
        vscode.window.showErrorMessage(`启动失败: ${error.message}`);
        await cleanup();
    }
}

/** 设置 Host 模式的事件绑定 */
function setupHostEvents(workspaceRoot: string, hostUser: UserInfo) {
    if (!server || !fileSync || !documentSync || !cursorDecorator || !fileWatcher) { return; }

    // 用户列表变化
    server.on('usersChanged', (users: UserInfo[]) => {
        userTreeProvider.updateUsers(users, hostUser.userId);
    });

    // 新用户加入：注册光标装饰
    server.on('userJoined', (user: UserInfo) => {
        cursorDecorator!.registerUser(user);
    });

    // 用户离开：移除光标装饰
    server.on('userLeft', (user: UserInfo) => {
        cursorDecorator!.removeUser(user.userId);
        if (followingUserId === user.userId) {
            followingUserId = null;
        }
    });

    // 客户端请求文件清单
    server.on('fileManifestRequest', async (clientId: string) => {
        const manifest = await fileSync!.generateManifest();
        server!.sendTo(clientId, {
            type: MessageType.FileManifest,
            files: manifest,
        });
    });

    // 客户端请求文件内容
    server.on('fileRequest', async (clientId: string, paths: string[]) => {
        for (const filePath of paths) {
            const fileContent = await fileSync!.readFileForSend(filePath);
            if (fileContent) {
                server!.sendTo(clientId, fileContent);
            }
        }
    });

    // 收到远程光标更新
    server.on('cursorUpdate', (msg: CursorUpdateMessage) => {
        cursorDecorator!.updateCursor(msg);
        if (followingUserId === msg.userId) {
            cursorDecorator!.gotoUser(msg.userId);
        }
    });

    // 收到远程活跃文件变更
    server.on('activeFileChange', (_msg: ActiveFileChangeMessage) => {
        // 用户列表已通过 usersChanged 更新
    });

    // 收到远程文档编辑
    server.on('docEdit', (msg: DocEditMessage) => {
        documentSync!.applyRemoteEdit(msg);
    });

    // 收到远程文件创建
    server.on('fileCreate', async (msg: FileCreateMessage) => {
        await fileSync!.createFile(msg.path, msg.content, msg.encoding);
    });

    // 收到远程文件删除
    server.on('fileDelete', async (msg: FileDeleteMessage) => {
        await fileSync!.deleteFile(msg.path);
    });

    // 收到远程文件重命名
    server.on('fileRename', async (msg: FileRenameMessage) => {
        await fileSync!.renameFile(msg.oldPath, msg.newPath);
    });

    // 收到远程文件保存
    server.on('fileSave', async (msg: FileSaveMessage) => {
        await documentSync!.applyRemoteSave(msg.path);
    });

    // 本地文档编辑 → 广播给所有客户端
    documentSync.on('docEdit', (msg: DocEditMessage) => {
        server!.broadcast(msg);
    });

    // 本地文件保存 → 广播
    documentSync.on('fileSave', (msg: FileSaveMessage) => {
        server!.broadcast(msg);
    });

    // 本地文件系统变更 → 广播
    fileWatcher.on('fileChange', async (event: { type: FileChangeType; relativePath: string; absolutePath: string }) => {
        if (fileSync!.isSuppressed(event.relativePath)) {
            return; // 跳过远程触发的变更
        }

        switch (event.type) {
            case FileChangeType.Created: {
                const data = await fileWatcher!.readFileContent(event.absolutePath);
                if (data) {
                    server!.broadcast({
                        type: MessageType.FileCreate,
                        path: event.relativePath,
                        content: data.content,
                        encoding: data.encoding,
                        userId: hostUser.userId,
                    });
                }
                break;
            }
            case FileChangeType.Deleted: {
                server!.broadcast({
                    type: MessageType.FileDelete,
                    path: event.relativePath,
                    userId: hostUser.userId,
                });
                break;
            }
            // Changed 事件由 documentSync 处理（编辑器内的变更）
        }
    });
}

// ============================================================
// Client 模式
// ============================================================

async function joinSession() {
    if (mode !== 'none') {
        vscode.window.showWarningMessage('请先断开当前连接');
        return;
    }

    const workspaceRoot = getWorkspaceRoot();
    if (!workspaceRoot) { return; }

    const username = await getUsername();
    if (!username) { return; }

    const url = await vscode.window.showInputBox({
        prompt: '请输入协作服务器地址',
        placeHolder: 'ws://hostname:18520 或 wss://hostname:443',
        validateInput: (value) => {
            if (!value || value.trim().length === 0) {
                return '地址不能为空';
            }
            return null;
        },
    });

    if (!url) { return; }

    try {
        // 创建客户端
        client = new CollabClient(url, username);

        // 初始化文件同步
        fileSync = new FileSync(workspaceRoot);

        // 初始化文件监控
        fileWatcher = new FileWatcher(workspaceRoot);

        // 初始化光标装饰
        cursorDecorator = new CursorDecorator(workspaceRoot);

        const userId = client.getUserId();

        // 初始化文档同步
        documentSync = new DocumentSync(workspaceRoot, userId);

        // 先绑定事件，再连接（确保不错过 JoinAck 事件）
        setupClientEvents(workspaceRoot, userId);
        setupLocalEditorEvents(workspaceRoot, userId);

        // 连接到服务器
        await client.connect();
        mode = 'client';

        // 更新 UI
        statusBarItem.text = `$(plug) Client: ${username}`;

        // 连接成功后立即更新用户列表
        userTreeProvider.updateUsers(client.getUsers(), userId);

        // 请求文件清单进行初始同步
        client.send({ type: MessageType.FileManifestRequest });

        // 发送当前活跃文件（如果有）
        const activeEditor = vscode.window.activeTextEditor;
        if (activeEditor && activeEditor.document.uri.scheme === 'file') {
            const relativePath = toRelativePath(activeEditor.document.uri.fsPath, workspaceRoot);
            const activeMsg: ActiveFileChangeMessage = {
                type: MessageType.ActiveFileChange,
                userId: userId,
                path: relativePath,
            };
            client.send(activeMsg);
            // 更新本地用户信息
            const users = client.getUsers();
            const self = users.find(u => u.userId === userId);
            if (self) {
                self.activeFile = relativePath;
                userTreeProvider.updateUsers(users, userId);
            }
        }

    } catch (error: any) {
        vscode.window.showErrorMessage(`连接失败: ${error.message}`);
        await cleanup();
    }
}

/** 设置 Client 模式的事件绑定 */
function setupClientEvents(workspaceRoot: string, userId: string) {
    if (!client || !fileSync || !cursorDecorator) { return; }

    // 用户列表变化
    client.on('usersChanged', (users: UserInfo[]) => {
        userTreeProvider.updateUsers(users, userId);

        // 注册所有用户的光标装饰
        for (const user of users) {
            if (user.userId !== userId) {
                cursorDecorator!.registerUser(user);
            }
        }
    });

    // 用户离开
    client.on('userLeft', (leftUserId: string) => {
        cursorDecorator!.removeUser(leftUserId);
        if (followingUserId === leftUserId) {
            followingUserId = null;
        }
    });

    // 收到文件清单
    client.on('fileManifest', async (msg: FileManifestMessage) => {
        await fileSync!.startInitialSync(
            msg,
            (requestMsg) => client!.send(requestMsg),
            () => {
                // 同步完成，开始实时同步
                vscode.window.showInformationMessage('文件同步完成！');
                documentSync!.start();
                fileWatcher!.start();

                // 绑定本地变更事件
                setupClientLocalChanges(workspaceRoot, userId);
            }
        );
    });

    // 收到文件内容
    client.on('fileContent', async (msg: FileContentMessage) => {
        await fileSync!.writeReceivedFile(msg);
    });

    // 收到远程光标更新
    client.on('cursorUpdate', (msg: CursorUpdateMessage) => {
        cursorDecorator!.updateCursor(msg);
        if (followingUserId === msg.userId) {
            cursorDecorator!.gotoUser(msg.userId);
        }
    });

    // 收到远程文档编辑
    client.on('docEdit', (msg: DocEditMessage) => {
        documentSync?.applyRemoteEdit(msg);
    });

    // 收到远程文件创建
    client.on('fileCreate', async (msg: FileCreateMessage) => {
        await fileSync!.createFile(msg.path, msg.content, msg.encoding);
    });

    // 收到远程文件删除
    client.on('fileDelete', async (msg: FileDeleteMessage) => {
        await fileSync!.deleteFile(msg.path);
    });

    // 收到远程文件重命名
    client.on('fileRename', async (msg: FileRenameMessage) => {
        await fileSync!.renameFile(msg.oldPath, msg.newPath);
    });

    // 收到远程文件保存
    client.on('fileSave', async (msg: FileSaveMessage) => {
        await documentSync?.applyRemoteSave(msg.path);
    });

    // 断开连接
    client.on('disconnected', () => {
        statusBarItem.text = '$(warning) CollabEdit: 已断开';
    });
}

/** 设置客户端本地变更的事件绑定 */
function setupClientLocalChanges(workspaceRoot: string, userId: string) {
    if (!client || !documentSync || !fileWatcher || !fileSync) { return; }

    // 本地文档编辑 → 发送到服务器
    documentSync.on('docEdit', (msg: DocEditMessage) => {
        client!.send(msg);
    });

    // 本地文件保存 → 发送到服务器
    documentSync.on('fileSave', (msg: FileSaveMessage) => {
        client!.send(msg);
    });

    // 本地文件系统变更 → 发送到服务器
    fileWatcher.on('fileChange', async (event: { type: FileChangeType; relativePath: string; absolutePath: string }) => {
        if (fileSync!.isSuppressed(event.relativePath)) {
            return;
        }

        switch (event.type) {
            case FileChangeType.Created: {
                const data = await fileWatcher!.readFileContent(event.absolutePath);
                if (data) {
                    client!.send({
                        type: MessageType.FileCreate,
                        path: event.relativePath,
                        content: data.content,
                        encoding: data.encoding,
                        userId: userId,
                    });
                }
                break;
            }
            case FileChangeType.Deleted: {
                client!.send({
                    type: MessageType.FileDelete,
                    path: event.relativePath,
                    userId: userId,
                });
                break;
            }
        }
    });
}

// ============================================================
// 本地编辑器事件（Host 和 Client 通用）
// ============================================================

function setupLocalEditorEvents(workspaceRoot: string, userId: string) {
    // 光标位置变化 → 发送光标更新（节流）
    const sendCursorUpdate = throttle((editor: vscode.TextEditor) => {
        if (editor.document.uri.scheme !== 'file') { return; }

        const relativePath = toRelativePath(editor.document.uri.fsPath, workspaceRoot);
        const cursor = editor.selection.active;
        const selections = editor.selections.map(sel => ({
            startLine: sel.start.line,
            startCharacter: sel.start.character,
            endLine: sel.end.line,
            endCharacter: sel.end.character,
        }));

        const msg: CursorUpdateMessage = {
            type: MessageType.CursorUpdate,
            userId: userId,
            path: relativePath,
            cursor: { line: cursor.line, character: cursor.character },
            selections: selections,
        };

        if (mode === 'host' && server) {
            server.broadcast(msg);
            server.updateHostUser({ cursor: msg.cursor, selections: msg.selections });
        } else if (mode === 'client' && client) {
            client.send(msg);
        }
    }, 100);

    disposables.push(
        vscode.window.onDidChangeTextEditorSelection((event) => {
            sendCursorUpdate(event.textEditor);
        })
    );

    // 活跃编辑器变化 → 发送活跃文件变更
    disposables.push(
        vscode.window.onDidChangeActiveTextEditor((editor) => {
            if (!editor || editor.document.uri.scheme !== 'file') { return; }

            const relativePath = toRelativePath(editor.document.uri.fsPath, workspaceRoot);
            const msg: ActiveFileChangeMessage = {
                type: MessageType.ActiveFileChange,
                userId: userId,
                path: relativePath,
            };

            if (mode === 'host' && server) {
                server.broadcast(msg);
                server.updateHostUser({ activeFile: relativePath });
                userTreeProvider.updateUsers(server.getAllUsers(), userId);
            } else if (mode === 'client' && client) {
                client.send(msg);
                // 更新本地用户信息中自己的 activeFile
                const users = client.getUsers();
                const self = users.find(u => u.userId === userId);
                if (self) {
                    self.activeFile = relativePath;
                    userTreeProvider.updateUsers(users, userId);
                }
            }
        })
    );
}

// ============================================================
// 跟随用户
// ============================================================

async function followUser(arg?: string | UserTreeItem) {
    if (mode === 'none') {
        vscode.window.showWarningMessage('请先连接到协作会话');
        return;
    }

    // 从 TreeItem 中提取 userId
    let userId: string | undefined;
    if (arg instanceof UserTreeItem) {
        userId = arg.user.userId;
    } else {
        userId = arg;
    }

    if (!userId) {
        // 显示用户选择列表
        const otherUsers = userTreeProvider.getOtherUserIds();
        if (otherUsers.length === 0) {
            vscode.window.showWarningMessage('没有其他用户可以跟随');
            return;
        }

        const items = otherUsers.map(id => {
            const user = userTreeProvider.getUserById(id);
            return {
                label: user?.username || id,
                description: user?.activeFile || '未打开文件',
                userId: id,
            };
        });

        const selected = await vscode.window.showQuickPick(items, {
            placeHolder: '选择要跟随的用户',
        });

        if (!selected) { return; }
        userId = selected.userId;
    }

    followingUserId = userId;
    const user = userTreeProvider.getUserById(userId);
    vscode.window.showInformationMessage(`正在跟随用户: ${user?.username || userId}`);

    // 立即跳转
    if (cursorDecorator) {
        await cursorDecorator.gotoUser(userId);
    }
}

async function unfollowUser() {
    if (followingUserId) {
        const user = userTreeProvider.getUserById(followingUserId);
        vscode.window.showInformationMessage(`已取消跟随用户: ${user?.username || followingUserId}`);
        followingUserId = null;
    }
}

async function gotoUser(arg?: string | UserTreeItem) {
    // 从 TreeItem 中提取 userId
    let userId: string | undefined;
    if (arg instanceof UserTreeItem) {
        userId = arg.user.userId;
    } else {
        userId = arg;
    }

    if (!userId) { return; }
    if (cursorDecorator) {
        await cursorDecorator.gotoUser(userId);
    }
}

// ============================================================
// 断开连接和清理
// ============================================================

async function disconnect() {
    if (mode === 'none') {
        vscode.window.showInformationMessage('当前没有活跃的协作连接');
        return;
    }

    await cleanup();
    vscode.window.showInformationMessage('已断开协作连接');
}

async function cleanup() {
    // 停止文件监控
    if (fileWatcher) {
        fileWatcher.stop();
        fileWatcher = null;
    }

    // 停止文档同步
    if (documentSync) {
        documentSync.stop();
        documentSync = null;
    }

    // 销毁光标装饰
    if (cursorDecorator) {
        cursorDecorator.dispose();
        cursorDecorator = null;
    }

    // 关闭客户端
    if (client) {
        client.disconnect();
        client = null;
    }

    // 关闭服务器
    if (server) {
        await server.stop();
        server = null;
    }

    // 清理文件同步
    fileSync = null;

    // 清理跟随
    followingUserId = null;

    // 清理事件监听
    for (const d of disposables) {
        d.dispose();
    }
    disposables = [];

    // 重置 UI
    mode = 'none';
    statusBarItem.text = '$(organization) CollabEdit: 未连接';
    userTreeProvider.clear();
}

export function deactivate() {
    cleanup();
}
