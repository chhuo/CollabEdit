import * as fs from 'fs';
import * as vscode from 'vscode';
import {
    MessageType, FileInfo, FileManifestMessage,
    FileContentMessage, FileRequestMessage,
} from './protocol';
import {
    getAllFiles, computeHash, toAbsolutePath,
    safeReadFile, safeWriteFile, safeDeleteFile, isBinaryFile,
} from './utils';

/** 文件同步管理器 */
export class FileSync {
    private workspaceRoot: string;
    /** 标记正在被远程同步操作的文件，避免触发本地文件监控的循环 */
    private suppressedPaths: Set<string> = new Set();
    /** 等待接收的文件队列 */
    private pendingFiles: Set<string> = new Set();
    /** 同步完成回调 */
    private syncCompleteCallback: (() => void) | null = null;

    constructor(workspaceRoot: string) {
        this.workspaceRoot = workspaceRoot;
    }

    /** 检查路径是否正在被抑制（不触发文件监控） */
    isSuppressed(relativePath: string): boolean {
        return this.suppressedPaths.has(relativePath);
    }

    /** 临时抑制路径（写入远程文件时使用） */
    suppressPath(relativePath: string): void {
        this.suppressedPaths.add(relativePath);
        // 3秒后自动移除抑制
        setTimeout(() => {
            this.suppressedPaths.delete(relativePath);
        }, 3000);
    }

    /** 生成本地文件清单 */
    async generateManifest(): Promise<FileInfo[]> {
        const files = await getAllFiles(this.workspaceRoot, this.workspaceRoot);
        const manifest: FileInfo[] = [];

        for (const relativePath of files) {
            const absolutePath = toAbsolutePath(relativePath, this.workspaceRoot);
            try {
                const content = await fs.promises.readFile(absolutePath);
                const stat = await fs.promises.stat(absolutePath);
                manifest.push({
                    path: relativePath,
                    hash: computeHash(content),
                    size: stat.size,
                });
            } catch {
                // 文件可能在扫描过程中被删除
            }
        }

        return manifest;
    }

    /** 对比本地和远程清单，返回需要请求的文件列表 */
    async compareManifest(remoteManifest: FileInfo[]): Promise<{
        toDownload: string[];
        toDelete: string[];
    }> {
        const localManifest = await this.generateManifest();
        const localMap = new Map(localManifest.map(f => [f.path, f]));
        const remoteMap = new Map(remoteManifest.map(f => [f.path, f]));

        const toDownload: string[] = [];
        const toDelete: string[] = [];

        // 找出需要下载的文件（远程有但本地没有，或哈希不同）
        for (const [path, remoteFile] of remoteMap.entries()) {
            const localFile = localMap.get(path);
            if (!localFile || localFile.hash !== remoteFile.hash) {
                toDownload.push(path);
            }
        }

        // 找出需要删除的文件（本地有但远程没有）
        for (const path of localMap.keys()) {
            if (!remoteMap.has(path)) {
                toDelete.push(path);
            }
        }

        return { toDownload, toDelete };
    }

    /** 读取文件内容用于发送 */
    async readFileForSend(relativePath: string): Promise<FileContentMessage | null> {
        const absolutePath = toAbsolutePath(relativePath, this.workspaceRoot);
        const content = await safeReadFile(absolutePath);

        if (!content) {
            return null;
        }

        const binary = isBinaryFile(content);
        return {
            type: MessageType.FileContent,
            path: relativePath,
            content: binary ? content.toString('base64') : content.toString('utf8'),
            encoding: binary ? 'base64' : 'utf8',
        };
    }

    /** 写入接收到的文件 */
    async writeReceivedFile(msg: FileContentMessage): Promise<void> {
        const absolutePath = toAbsolutePath(msg.path, this.workspaceRoot);
        this.suppressPath(msg.path);

        if (msg.encoding === 'base64') {
            await safeWriteFile(absolutePath, Buffer.from(msg.content, 'base64'));
        } else {
            await safeWriteFile(absolutePath, msg.content);
        }

        // 从待处理队列移除
        this.pendingFiles.delete(msg.path);

        // 检查是否所有文件都已接收
        if (this.pendingFiles.size === 0 && this.syncCompleteCallback) {
            this.syncCompleteCallback();
            this.syncCompleteCallback = null;
        }
    }

    /** 创建远程文件到本地 */
    async createFile(relativePath: string, content: string, encoding: 'utf8' | 'base64'): Promise<void> {
        const absolutePath = toAbsolutePath(relativePath, this.workspaceRoot);
        this.suppressPath(relativePath);

        if (encoding === 'base64') {
            await safeWriteFile(absolutePath, Buffer.from(content, 'base64'));
        } else {
            await safeWriteFile(absolutePath, content);
        }
    }

    /** 删除本地文件 */
    async deleteFile(relativePath: string): Promise<void> {
        const absolutePath = toAbsolutePath(relativePath, this.workspaceRoot);
        this.suppressPath(relativePath);
        await safeDeleteFile(absolutePath);
    }

    /** 重命名本地文件 */
    async renameFile(oldPath: string, newPath: string): Promise<void> {
        const oldAbsolute = toAbsolutePath(oldPath, this.workspaceRoot);
        const newAbsolute = toAbsolutePath(newPath, this.workspaceRoot);
        this.suppressPath(oldPath);
        this.suppressPath(newPath);

        try {
            // 确保目标目录存在
            const dir = require('path').dirname(newAbsolute);
            await fs.promises.mkdir(dir, { recursive: true });
            await fs.promises.rename(oldAbsolute, newAbsolute);
        } catch (error) {
            console.error('重命名文件失败:', error);
        }
    }

    /** 开始初始同步（客户端收到清单后调用） */
    async startInitialSync(
        manifest: FileManifestMessage,
        requestFiles: (msg: FileRequestMessage) => void,
        onComplete: () => void
    ): Promise<void> {
        const { toDownload, toDelete } = await this.compareManifest(manifest.files);

        // 删除多余的文件
        for (const filePath of toDelete) {
            await this.deleteFile(filePath);
        }

        if (toDownload.length === 0) {
            onComplete();
            return;
        }

        // 设置待接收文件队列
        this.pendingFiles = new Set(toDownload);
        this.syncCompleteCallback = onComplete;

        // 分批请求文件（每批 10 个）
        const batchSize = 10;
        for (let i = 0; i < toDownload.length; i += batchSize) {
            const batch = toDownload.slice(i, i + batchSize);
            requestFiles({
                type: MessageType.FileRequest,
                paths: batch,
            });
        }

        // 显示进度
        vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: '正在同步文件...',
                cancellable: false,
            },
            async (progress) => {
                const total = toDownload.length;
                return new Promise<void>((resolve) => {
                    const checkInterval = setInterval(() => {
                        const remaining = this.pendingFiles.size;
                        const done = total - remaining;
                        progress.report({
                            message: `${done}/${total}`,
                            increment: (1 / total) * 100,
                        });
                        if (remaining === 0) {
                            clearInterval(checkInterval);
                            resolve();
                        }
                    }, 500);
                });
            }
        );
    }

    /** 读取文件内容为文本 */
    async readFileAsText(relativePath: string): Promise<string | null> {
        const absolutePath = toAbsolutePath(relativePath, this.workspaceRoot);
        try {
            return await fs.promises.readFile(absolutePath, 'utf8');
        } catch {
            return null;
        }
    }
}
