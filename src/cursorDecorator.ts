import * as vscode from 'vscode';
import * as path from 'path';
import { UserInfo, CursorUpdateMessage, CursorPosition, SelectionRange } from './protocol';

/** 单个用户的光标装饰信息 */
interface UserDecoration {
    userId: string;
    username: string;
    color: string;
    cursorDecorationType: vscode.TextEditorDecorationType;
    selectionDecorationType: vscode.TextEditorDecorationType;
    labelDecorationType: vscode.TextEditorDecorationType;
    currentPath: string | null;
    cursor: CursorPosition | null;
    selections: SelectionRange[];
}

/** 光标装饰管理器 */
export class CursorDecorator {
    private workspaceRoot: string;
    private userDecorations: Map<string, UserDecoration> = new Map();
    private disposables: vscode.Disposable[] = [];

    constructor(workspaceRoot: string) {
        this.workspaceRoot = workspaceRoot;

        // 当活跃编辑器变化时刷新装饰
        this.disposables.push(
            vscode.window.onDidChangeActiveTextEditor(() => {
                this.refreshDecorations();
            })
        );
    }

    /** 为用户创建装饰类型 */
    private createUserDecoration(userId: string, username: string, color: string): UserDecoration {
        // 光标装饰（竖线）
        const cursorDecorationType = vscode.window.createTextEditorDecorationType({
            borderColor: color,
            borderStyle: 'solid',
            borderWidth: '2px 0 0 2px',
            after: {
                contentText: '',
                color: color,
                margin: '0 0 0 0',
            },
        });

        // 选区装饰（半透明背景）
        const selectionDecorationType = vscode.window.createTextEditorDecorationType({
            backgroundColor: color + '30', // 30 = ~19% opacity
            borderColor: color + '50',
            borderStyle: 'solid',
            borderWidth: '1px',
        });

        // 用户名标签装饰
        const labelDecorationType = vscode.window.createTextEditorDecorationType({
            after: {
                contentText: ` ${username}`,
                color: color,
                backgroundColor: color + '20',
                fontStyle: 'italic',
                fontWeight: 'bold',
                margin: '0 0 0 4px',
                border: `1px solid ${color}50`,
            },
        });

        return {
            userId,
            username,
            color,
            cursorDecorationType,
            selectionDecorationType,
            labelDecorationType,
            currentPath: null,
            cursor: null,
            selections: [],
        };
    }

    /** 更新用户光标 */
    updateCursor(msg: CursorUpdateMessage): void {
        let decoration = this.userDecorations.get(msg.userId);

        if (!decoration) {
            // 不应该到这里，但以防万一
            return;
        }

        decoration.currentPath = msg.path;
        decoration.cursor = msg.cursor;
        decoration.selections = msg.selections;

        this.refreshDecorations();
    }

    /** 注册用户装饰（用户加入时调用） */
    registerUser(user: UserInfo): void {
        if (this.userDecorations.has(user.userId)) {
            return;
        }

        const decoration = this.createUserDecoration(user.userId, user.username, user.color);
        this.userDecorations.set(user.userId, decoration);
    }

    /** 移除用户装饰（用户离开时调用） */
    removeUser(userId: string): void {
        const decoration = this.userDecorations.get(userId);
        if (decoration) {
            decoration.cursorDecorationType.dispose();
            decoration.selectionDecorationType.dispose();
            decoration.labelDecorationType.dispose();
            this.userDecorations.delete(userId);
            this.refreshDecorations();
        }
    }

    /** 刷新当前编辑器的所有装饰 */
    refreshDecorations(): void {
        const editor = vscode.window.activeTextEditor;
        if (!editor) { return; }

        const currentFilePath = this.getRelativePath(editor.document.uri.fsPath);

        for (const decoration of this.userDecorations.values()) {
            if (decoration.currentPath !== currentFilePath || !decoration.cursor) {
                // 用户不在当前文件，清除装饰
                editor.setDecorations(decoration.cursorDecorationType, []);
                editor.setDecorations(decoration.selectionDecorationType, []);
                editor.setDecorations(decoration.labelDecorationType, []);
                continue;
            }

            // 设置光标装饰
            const cursorPos = new vscode.Position(decoration.cursor.line, decoration.cursor.character);
            const cursorRange = new vscode.Range(cursorPos, cursorPos);
            editor.setDecorations(decoration.cursorDecorationType, [cursorRange]);

            // 设置用户名标签
            editor.setDecorations(decoration.labelDecorationType, [cursorRange]);

            // 设置选区装饰
            const selectionRanges: vscode.Range[] = decoration.selections.map(sel =>
                new vscode.Range(
                    new vscode.Position(sel.startLine, sel.startCharacter),
                    new vscode.Position(sel.endLine, sel.endCharacter)
                )
            ).filter(range => !range.isEmpty);

            editor.setDecorations(decoration.selectionDecorationType, selectionRanges);
        }
    }

    /** 跳转到指定用户的光标位置 */
    async gotoUser(userId: string): Promise<void> {
        const decoration = this.userDecorations.get(userId);
        if (!decoration || !decoration.currentPath || !decoration.cursor) {
            vscode.window.showWarningMessage('无法跳转：用户没有打开文件');
            return;
        }

        const absolutePath = path.join(this.workspaceRoot, decoration.currentPath);
        const uri = vscode.Uri.file(absolutePath);

        try {
            const document = await vscode.workspace.openTextDocument(uri);
            const editor = await vscode.window.showTextDocument(document);

            const position = new vscode.Position(decoration.cursor.line, decoration.cursor.character);
            editor.selection = new vscode.Selection(position, position);
            editor.revealRange(
                new vscode.Range(position, position),
                vscode.TextEditorRevealType.InCenter
            );
        } catch (error) {
            vscode.window.showErrorMessage(`无法打开文件: ${decoration.currentPath}`);
        }
    }

    /** 获取相对路径 */
    private getRelativePath(absolutePath: string): string {
        return path.relative(this.workspaceRoot, absolutePath).replace(/\\/g, '/');
    }

    /** 销毁所有装饰 */
    dispose(): void {
        for (const decoration of this.userDecorations.values()) {
            decoration.cursorDecorationType.dispose();
            decoration.selectionDecorationType.dispose();
            decoration.labelDecorationType.dispose();
        }
        this.userDecorations.clear();

        for (const disposable of this.disposables) {
            disposable.dispose();
        }
        this.disposables = [];
    }
}
