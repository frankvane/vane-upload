import path from "path";
import { fileURLToPath } from "url";

/**
 * VU-63：E2E 专用的固定目录布局。
 *
 * 关键约束：playwright.config.ts 的顶层代码在单次运行里可能被求值多次，
 * 若用 `pid + Date.now()` 生成「每次运行唯一」目录，不同求值会得到不同路径，
 * 导致 webServer 后端写到一个目录、测试 worker 却去扫另一个目录 → 断言失败。
 *
 * 因此这里用「相对项目根的固定路径」，保证 config / globalSetup / webServer / 测试用例
 * 四侧算出的路径完全一致，与求值次数无关。跨运行污染（上次已合并的文件被秒传命中）
 * 由 globalSetup 在 webServer 启动前统一 rm 清空解决。
 */
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, "..");

export const E2E_ROOT = path.join(PROJECT_ROOT, ".e2e-tmp");
export const E2E_UPLOADS_DIR = path.join(E2E_ROOT, "uploads");
export const E2E_DATA_DIR = path.join(E2E_ROOT, "data");
export const E2E_TMP_UPLOAD_DIR = path.join(E2E_ROOT, "tmp-upload");
