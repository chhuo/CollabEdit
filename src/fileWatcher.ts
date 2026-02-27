import * as vscode from 'vscode';
import * as fs from 'fs';
import { EventEmitter } from 'events';
import { shouldIgnore, toRelativePath, isBinaryFile } from './utils';

/** 文件变更事件类型 */
export enum FileChangeType {
    Created = 'created',
    Changed = 'changed',
    Deleted = 'deleted',
}

/** 文件变更事件 */
export interface FileChangeEvent {
    type: FileChangeType;
    relativePath: string;
    absolutePath: string;
}

/** 文件系统监控器 */
export class FileWatcher extends EventEmitter {
    private watcher: vscode.FileSystemWatcher | null = null;
    private workspaceRoot: string;
    private disposables: vscode.Disposable[] = [];

    constructor(workspaceRoot: string) {
        super();
        this.workspaceRoot = workspaceRoot;
    }

    /** 开始监控 */
    start(): void {
        // 监控工作区内所有文件
        this.watcher = vscode.workspace.createFileSystemWatcher(
            new vscode.RelativePattern(this.workspaceRoot, '**/*')
        );

        this.disposables.push(
            this.watcher.onDidCreate((uri) => {
                this.handleFileChange(uri, FileChangeType.Created);
            })
        );

        this.disposables.push(
            this.watcher.onDidChange((uri) => {
                this.handleFileChange(uri, FileChangeType.Changed);
            })
        );

        this.disposables.push(
            this.watcher.onDidDelete((uri) => {
                this.handleFileChange(uri, FileChangeType.Deleted);
            })
        );
    }

    /** 处理文件变更 */
    private handleFileChange(uri: vscode.Uri, type: FileChangeType): void {
        const absolutePath = uri.fsPath;
        const relativePath = toRelativePath(absolutePath, this.workspaceRoot);

        // 忽略不需要同步的文件
        if (shouldIgnore(relativePath)) {
            return;
        }

        const event: FileChangeEvent = {
            type,
            relativePath,
            absolutePath,
        };

        this.emit('fileChange', event);
    }

    /** 读取文件内容 */
    async readFileContent(absolutePath: string): Promise<{ content: string; encoding: 'utf8' | 'base64' } | null> {
        try {
            const buffer = await fs.promises.readFile(absolutePath);
            const binary = isBinaryFile(buffer);
            return {
                content: binary ? buffer.toString('base64') : buffer.toString('utf8'),
                encoding: binary ? 'base64' : 'utf8',
            };
        } catch {
            return null;
        }
    }

    /** 停止监控 */
    stop(): void {
        for (const disposable of this.disposables) {
            disposable.dispose();
        }
        this.disposables = [];

        if (this.watcher) {
            this.watcher.dispose();
            this.watcher = null;
        }
    }
}
