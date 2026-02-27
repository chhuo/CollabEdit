// ============================================================
// CollabEdit 通信协议定义
// ============================================================

/** 用户颜色列表 */
export const USER_COLORS = [
    '#FF6B6B', '#4ECDC4', '#45B7D1', '#96CEB4',
    '#FFEAA7', '#DDA0DD', '#98D8C8', '#F7DC6F',
    '#BB8FCE', '#85C1E9', '#F0B27A', '#82E0AA',
];

/** 用户信息 */
export interface UserInfo {
    userId: string;
    username: string;
    color: string;
    activeFile: string | null;
    cursor: CursorPosition | null;
    selections: SelectionRange[];
}

/** 光标位置 */
export interface CursorPosition {
    line: number;
    character: number;
}

/** 选区范围 */
export interface SelectionRange {
    startLine: number;
    startCharacter: number;
    endLine: number;
    endCharacter: number;
}

/** 文件信息（用于清单） */
export interface FileInfo {
    path: string;
    hash: string;
    size: number;
}

/** 文本变更 */
export interface TextChange {
    rangeOffset: number;
    rangeLength: number;
    text: string;
    startLine: number;
    startCharacter: number;
    endLine: number;
    endCharacter: number;
}

// ============================================================
// 消息类型枚举
// ============================================================

export enum MessageType {
    // 连接管理
    Join = 'join',
    JoinAck = 'join_ack',
    UserJoined = 'user_joined',
    UserLeft = 'user_left',
    UserList = 'user_list',
    Heartbeat = 'heartbeat',
    HeartbeatAck = 'heartbeat_ack',

    // 文件同步
    FileManifest = 'file_manifest',
    FileManifestRequest = 'file_manifest_request',
    FileRequest = 'file_request',
    FileContent = 'file_content',
    FileCreate = 'file_create',
    FileDelete = 'file_delete',
    FileRename = 'file_rename',
    FileSave = 'file_save',
    SyncComplete = 'sync_complete',

    // 文档编辑同步
    DocEdit = 'doc_edit',
    DocFullContent = 'doc_full_content',

    // 光标和选区
    CursorUpdate = 'cursor_update',
    ActiveFileChange = 'active_file_change',

    // 错误
    Error = 'error',
}

// ============================================================
// 消息定义
// ============================================================

/** 加入会话 */
export interface JoinMessage {
    type: MessageType.Join;
    userId: string;
    username: string;
}

/** 加入确认 */
export interface JoinAckMessage {
    type: MessageType.JoinAck;
    userId: string;
    color: string;
    users: UserInfo[];
}

/** 用户加入通知 */
export interface UserJoinedMessage {
    type: MessageType.UserJoined;
    user: UserInfo;
}

/** 用户离开通知 */
export interface UserLeftMessage {
    type: MessageType.UserLeft;
    userId: string;
}

/** 用户列表 */
export interface UserListMessage {
    type: MessageType.UserList;
    users: UserInfo[];
}

/** 心跳 */
export interface HeartbeatMessage {
    type: MessageType.Heartbeat;
}

/** 心跳回复 */
export interface HeartbeatAckMessage {
    type: MessageType.HeartbeatAck;
}

/** 文件清单 */
export interface FileManifestMessage {
    type: MessageType.FileManifest;
    files: FileInfo[];
}

/** 请求文件清单 */
export interface FileManifestRequestMessage {
    type: MessageType.FileManifestRequest;
}

/** 请求文件内容 */
export interface FileRequestMessage {
    type: MessageType.FileRequest;
    paths: string[];
}

/** 文件内容 */
export interface FileContentMessage {
    type: MessageType.FileContent;
    path: string;
    content: string;
    encoding: 'utf8' | 'base64';
}

/** 文件创建 */
export interface FileCreateMessage {
    type: MessageType.FileCreate;
    path: string;
    content: string;
    encoding: 'utf8' | 'base64';
    userId: string;
}

/** 文件删除 */
export interface FileDeleteMessage {
    type: MessageType.FileDelete;
    path: string;
    userId: string;
}

/** 文件重命名 */
export interface FileRenameMessage {
    type: MessageType.FileRename;
    oldPath: string;
    newPath: string;
    userId: string;
}

/** 文件保存 */
export interface FileSaveMessage {
    type: MessageType.FileSave;
    path: string;
    userId: string;
}

/** 同步完成 */
export interface SyncCompleteMessage {
    type: MessageType.SyncComplete;
}

/** 文档编辑 */
export interface DocEditMessage {
    type: MessageType.DocEdit;
    path: string;
    changes: TextChange[];
    version: number;
    userId: string;
}

/** 文档完整内容（用于冲突恢复） */
export interface DocFullContentMessage {
    type: MessageType.DocFullContent;
    path: string;
    content: string;
    version: number;
}

/** 光标更新 */
export interface CursorUpdateMessage {
    type: MessageType.CursorUpdate;
    userId: string;
    path: string;
    cursor: CursorPosition;
    selections: SelectionRange[];
}

/** 活跃文件变更 */
export interface ActiveFileChangeMessage {
    type: MessageType.ActiveFileChange;
    userId: string;
    path: string | null;
}

/** 错误消息 */
export interface ErrorMessage {
    type: MessageType.Error;
    message: string;
}

/** 所有消息类型联合 */
export type CollabMessage =
    | JoinMessage
    | JoinAckMessage
    | UserJoinedMessage
    | UserLeftMessage
    | UserListMessage
    | HeartbeatMessage
    | HeartbeatAckMessage
    | FileManifestMessage
    | FileManifestRequestMessage
    | FileRequestMessage
    | FileContentMessage
    | FileCreateMessage
    | FileDeleteMessage
    | FileRenameMessage
    | FileSaveMessage
    | SyncCompleteMessage
    | DocEditMessage
    | DocFullContentMessage
    | CursorUpdateMessage
    | ActiveFileChangeMessage
    | ErrorMessage;

/** 序列化消息 */
export function serializeMessage(msg: CollabMessage): string {
    return JSON.stringify(msg);
}

/** 反序列化消息 */
export function deserializeMessage(data: string): CollabMessage | null {
    try {
        return JSON.parse(data) as CollabMessage;
    } catch {
        return null;
    }
}
