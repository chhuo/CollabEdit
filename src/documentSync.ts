import * as vscode from 'vscode';
import { EventEmitter } from 'events';
import { MessageType, DocEditMessage, TextChange } from './protocol';
import { toRelativePath, shouldIgnore } from './utils';

/** 文档同步管理器 - 处理实时编辑同步 */
export class DocumentSync extends EventEmitter {
    private workspaceRoot: string;
    private disposables: vscode.Disposable[] = [];
    /** 文档版本号映射 */
    private documentVersions: Map<string, number> = new Map();
    /** 正在应用远程编辑的标记，避免循环 */
    private applyingRemoteEdit: boolean = false;
    /** 本地用户 ID */
    private userId: string;

    constructor(workspaceRoot: string, userId: string) {
        super();
        this.workspaceRoot = workspaceRoot;
        this.userId = userId;
    }

    /** 开始监听文档变更 */
    start(): void {
        // 监听文档内容变更
        this.disposables.push(
            vscode.workspace.onDidChangeTextDocument((event) => {
                this.handleDocumentChange(event);
            })
        );

        // 监听文档保存
        this.disposables.push(
            vscode.workspace.onDidSaveTextDocument((document) => {
                this.handleDocumentSave(document);
            })
        );
    }

    /** 处理本地文档变更 */
    private handleDocumentChange(event: vscode.TextDocumentChangeEvent): void {
        // 如果正在应用远程编辑，跳过
        if (this.applyingRemoteEdit) {
            return;
        }

        // 跳过非文件 scheme（如 output、debug 等）
        if (event.document.uri.scheme !== 'file') {
            return;
        }

        // 如果没有实际变更，跳过
        if (event.contentChanges.length === 0) {
            return;
        }

        const relativePath = toRelativePath(event.document.uri.fsPath, this.workspaceRoot);

        // 忽略不需要同步的文件
        if (shouldIgnore(relativePath)) {
            return;
        }

        // 获取或初始化版本号
        let version = this.documentVersions.get(relativePath) || 0;
        version++;
        this.documentVersions.set(relativePath, version);

        // 转换变更为协议格式
        const changes: TextChange[] = event.contentChanges.map(change => ({
            rangeOffset: change.rangeOffset,
            rangeLength: change.rangeLength,
            text: change.text,
            startLine: change.range.start.line,
            startCharacter: change.range.start.character,
            endLine: change.range.end.line,
            endCharacter: change.range.end.character,
        }));

        const msg: DocEditMessage = {
            type: MessageType.DocEdit,
            path: relativePath,
            changes: changes,
            version: version,
            userId: this.userId,
        };

        this.emit('docEdit', msg);
    }

    /** 处理文档保存 */
    private handleDocumentSave(document: vscode.TextDocument): void {
        if (document.uri.scheme !== 'file') {
            return;
        }

        const relativePath = toRelativePath(document.uri.fsPath, this.workspaceRoot);
        if (shouldIgnore(relativePath)) {
            return;
        }

        this.emit('fileSave', {
            type: MessageType.FileSave,
            path: relativePath,
            userId: this.userId,
        });
    }

    /** 应用远程编辑到本地文档 */
    async applyRemoteEdit(msg: DocEditMessage): Promise<void> {
        if (msg.userId === this.userId) {
            return; // 忽略自己的编辑
        }

        const absolutePath = vscode.Uri.file(
            require('path').join(this.workspaceRoot, msg.path)
        );

        // 查找或打开文档
        let document: vscode.TextDocument;
        try {
            document = await vscode.workspace.openTextDocument(absolutePath);
        } catch {
            // 文件可能不存在
            return;
        }

        this.applyingRemoteEdit = true;

        try {
            const edit = new vscode.WorkspaceEdit();

            for (const change of msg.changes) {
                const range = new vscode.Range(
                    new vscode.Position(change.startLine, change.startCharacter),
                    new vscode.Position(change.endLine, change.endCharacter)
                );
                edit.replace(absolutePath, range, change.text);
            }

            await vscode.workspace.applyEdit(edit);

            // 更新版本号
            this.documentVersions.set(msg.path, msg.version);
        } catch (error) {
            console.error('应用远程编辑失败:', error);
        } finally {
            // 使用短延时确保事件完全处理
            setTimeout(() => {
                this.applyingRemoteEdit = false;
            }, 50);
        }
    }

    /** 应用远程文件保存 */
    async applyRemoteSave(path: string): Promise<void> {
        const absolutePath = vscode.Uri.file(
            require('path').join(this.workspaceRoot, path)
        );

        try {
            const document = await vscode.workspace.openTextDocument(absolutePath);
            if (document.isDirty) {
                await document.save();
            }
        } catch {
            // 文件可能未打开
        }
    }

    /** 获取文档版本号 */
    getVersion(relativePath: string): number {
        return this.documentVersions.get(relativePath) || 0;
    }

    /** 停止监听 */
    stop(): void {
        for (const disposable of this.disposables) {
            disposable.dispose();
        }
        this.disposables = [];
        this.documentVersions.clear();
    }
}
