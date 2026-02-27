import * as vscode from 'vscode';
import * as path from 'path';
import { UserInfo } from './protocol';

/** 树节点类型 */
type TreeNode = UserTreeItem | FileInfoItem;

/** 用户树节点（父节点，可展开） */
export class UserTreeItem extends vscode.TreeItem {
    public readonly type = 'user' as const;

    constructor(
        public readonly user: UserInfo,
        public readonly isCurrentUser: boolean,
    ) {
        super(
            isCurrentUser ? `${user.username} (你)` : user.username,
            vscode.TreeItemCollapsibleState.Expanded
        );

        // 设置工具提示
        this.tooltip = new vscode.MarkdownString(
            `**${user.username}**\n\n` +
            `- 颜色: ${user.color}\n` +
            `- 文件: ${user.activeFile || '无'}`
        );

        // 设置图标
        this.iconPath = new vscode.ThemeIcon(
            isCurrentUser ? 'account' : 'person',
            new vscode.ThemeColor('charts.foreground')
        );

        // 设置上下文值
        this.contextValue = isCurrentUser ? 'currentUser' : 'user';
    }
}

/** 文件信息节点（子节点） */
export class FileInfoItem extends vscode.TreeItem {
    public readonly type = 'fileInfo' as const;

    constructor(
        public readonly user: UserInfo,
        public readonly isCurrentUser: boolean,
    ) {
        const fileName = user.activeFile ? path.basename(user.activeFile) : '未打开文件';
        const filePath = user.activeFile || '';

        super(fileName, vscode.TreeItemCollapsibleState.None);

        // 描述显示完整路径
        this.description = filePath;

        // 设置工具提示
        const cursorInfo = user.cursor
            ? `光标: 行 ${user.cursor.line + 1}, 列 ${user.cursor.character + 1}`
            : '无光标信息';
        this.tooltip = new vscode.MarkdownString(
            `📄 **${filePath || '未打开文件'}**\n\n` +
            `- ${cursorInfo}`
        );

        // 设置图标
        if (user.activeFile) {
            this.iconPath = new vscode.ThemeIcon('file');
        } else {
            this.iconPath = new vscode.ThemeIcon('circle-slash');
        }

        // 点击跳转到用户位置
        if (!isCurrentUser && user.activeFile) {
            this.command = {
                command: 'collabEdit.gotoUser',
                title: '跳转到用户位置',
                arguments: [user.userId],
            };
        }

        this.contextValue = 'fileInfo';
    }
}

/** 用户列表 TreeDataProvider */
export class UserTreeDataProvider implements vscode.TreeDataProvider<TreeNode> {
    private _onDidChangeTreeData = new vscode.EventEmitter<TreeNode | undefined | null | void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    private users: UserInfo[] = [];
    private currentUserId: string = '';

    /** 更新用户列表 */
    updateUsers(users: UserInfo[], currentUserId: string): void {
        this.users = users;
        this.currentUserId = currentUserId;
        this._onDidChangeTreeData.fire();
    }

    /** 清空用户列表 */
    clear(): void {
        this.users = [];
        this.currentUserId = '';
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element: TreeNode): vscode.TreeItem {
        return element;
    }

    getChildren(element?: TreeNode): Thenable<TreeNode[]> {
        if (!element) {
            // 根级别：显示用户列表
            if (this.users.length === 0) {
                return Promise.resolve([]);
            }

            const items = this.users.map(user =>
                new UserTreeItem(user, user.userId === this.currentUserId)
            );

            // 当前用户排在最前面
            items.sort((a, b) => {
                if (a.isCurrentUser) { return -1; }
                if (b.isCurrentUser) { return 1; }
                return a.user.username.localeCompare(b.user.username);
            });

            return Promise.resolve(items);
        }

        if (element instanceof UserTreeItem) {
            // 用户子节点：显示文件信息
            const fileItem = new FileInfoItem(element.user, element.isCurrentUser);
            return Promise.resolve([fileItem]);
        }

        return Promise.resolve([]);
    }

    /** 获取用户 ID 列表（除当前用户外） */
    getOtherUserIds(): string[] {
        return this.users
            .filter(u => u.userId !== this.currentUserId)
            .map(u => u.userId);
    }

    /** 通过 ID 获取用户信息 */
    getUserById(userId: string): UserInfo | undefined {
        return this.users.find(u => u.userId === userId);
    }
}
