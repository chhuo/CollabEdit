import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

/** 忽略的目录和文件模式 */
const IGNORE_PATTERNS = [
    'node_modules',
    '.git',
    '.vscode',
    '.DS_Store',
    'out',
    'dist',
    '.collab-edit',
    '__pycache__',
    '.pytest_cache',
    '*.pyc',
    'thumbs.db',
];

/** 检查路径是否应被忽略 */
export function shouldIgnore(filePath: string): boolean {
    const parts = filePath.split(/[/\\]/);
    for (const part of parts) {
        for (const pattern of IGNORE_PATTERNS) {
            if (pattern.startsWith('*')) {
                // 通配符匹配（如 *.pyc）
                const ext = pattern.slice(1);
                if (part.endsWith(ext)) {
                    return true;
                }
            } else if (part === pattern) {
                return true;
            }
        }
    }
    return false;
}

/** 计算文件内容的 MD5 哈希 */
export function computeHash(content: Buffer): string {
    return crypto.createHash('md5').update(content).digest('hex');
}

/** 生成唯一用户 ID */
export function generateUserId(): string {
    return crypto.randomBytes(8).toString('hex');
}

/** 获取相对于工作区的路径（使用正斜杠） */
export function toRelativePath(absolutePath: string, workspaceRoot: string): string {
    return path.relative(workspaceRoot, absolutePath).replace(/\\/g, '/');
}

/** 获取绝对路径 */
export function toAbsolutePath(relativePath: string, workspaceRoot: string): string {
    return path.join(workspaceRoot, relativePath);
}

/** 递归获取目录中所有文件 */
export async function getAllFiles(dir: string, workspaceRoot: string): Promise<string[]> {
    const results: string[] = [];

    async function walk(currentDir: string) {
        let entries: fs.Dirent[];
        try {
            entries = await fs.promises.readdir(currentDir, { withFileTypes: true });
        } catch {
            return;
        }

        for (const entry of entries) {
            const fullPath = path.join(currentDir, entry.name);
            const relativePath = toRelativePath(fullPath, workspaceRoot);

            if (shouldIgnore(relativePath)) {
                continue;
            }

            if (entry.isDirectory()) {
                await walk(fullPath);
            } else if (entry.isFile()) {
                results.push(relativePath);
            }
        }
    }

    await walk(dir);
    return results;
}

/** 确保目录存在 */
export async function ensureDir(dirPath: string): Promise<void> {
    try {
        await fs.promises.mkdir(dirPath, { recursive: true });
    } catch {
        // 目录已存在
    }
}

/** 安全写入文件（确保目录存在） */
export async function safeWriteFile(filePath: string, content: Buffer | string): Promise<void> {
    await ensureDir(path.dirname(filePath));
    await fs.promises.writeFile(filePath, content);
}

/** 安全读取文件 */
export async function safeReadFile(filePath: string): Promise<Buffer | null> {
    try {
        return await fs.promises.readFile(filePath);
    } catch {
        return null;
    }
}

/** 安全删除文件 */
export async function safeDeleteFile(filePath: string): Promise<void> {
    try {
        await fs.promises.unlink(filePath);
    } catch {
        // 文件不存在
    }
}

/** 检查文件是否为二进制文件 */
export function isBinaryFile(buffer: Buffer): boolean {
    // 检查前 8192 字节中是否有 null 字符
    const length = Math.min(buffer.length, 8192);
    for (let i = 0; i < length; i++) {
        if (buffer[i] === 0) {
            return true;
        }
    }
    return false;
}

/** 延迟执行 */
export function delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/** 节流函数 */
export function throttle<T extends (...args: any[]) => void>(func: T, limit: number): T {
    let inThrottle = false;
    return ((...args: any[]) => {
        if (!inThrottle) {
            func(...args);
            inThrottle = true;
            setTimeout(() => (inThrottle = false), limit);
        }
    }) as T;
}

/** 防抖函数 */
export function debounce<T extends (...args: any[]) => void>(func: T, wait: number): T {
    let timeout: NodeJS.Timeout | undefined;
    return ((...args: any[]) => {
        if (timeout) {
            clearTimeout(timeout);
        }
        timeout = setTimeout(() => func(...args), wait);
    }) as T;
}
