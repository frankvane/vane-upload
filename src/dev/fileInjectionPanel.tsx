import React, { useState } from "react";

/**
 * 仅开发环境启用的「测试文件注入口」。
 *
 * 为什么需要它：浏览器自动化（CDP / OS 层）无法操作原生文件选择框，
 * `<input type="file">` 的 files 只能由用户在系统对话框中选择。
 * 本面板用 DataTransfer 构造 File 后写回 input 并派发 change 事件，
 * 效果等价于用户手动选中文件，从而让「选择文件 → 校验 → 入队 → 上传」
 * 全链路可在浏览器模式下自动回归。
 *
 * 生效范围：仅 `src/main.tsx` 在 `import.meta.env.DEV` 下动态引入；
 * 库构建（vite.lib.config.ts，入口 src/index.ts）与生产 demo 构建均不含本文件。
 */

interface FixtureSpec {
  name: string;
  size: number;
  seed: number;
}

let modifiedSeq = 0;

/** 生成确定内容的 File：同 name+seed 得到同 md5（用于秒传用例）。 */
const makeFile = ({ name, size, seed }: FixtureSpec): File => {
  const bytes = new Uint8Array(size);
  for (let i = 0; i < size; i += 1) {
    bytes[i] = (i * 31 + seed) & 0xff;
  }
  // lastModified 每次注入都不同，避免被「同文件重复选择」的内容指纹去重拦掉
  modifiedSeq += 1;
  return new File([bytes], name, {
    type: "application/octet-stream",
    lastModified: Date.now() + modifiedSeq,
  });
};

const injectFiles = (files: File[]): boolean => {
  const input = document.querySelector<HTMLInputElement>('input[type="file"]');
  if (!input) {
    return false;
  }
  const dt = new DataTransfer();
  for (const file of files) {
    dt.items.add(file);
  }
  input.files = dt.files;
  input.dispatchEvent(new Event("change", { bubbles: true }));
  return true;
};

const PRESETS: Array<{ label: string; name: string; size: number; seed: number }> = [
  { label: "小 512KB", name: "小-512KB.bin", size: 512 * 1024, seed: 7 },
  { label: "中 3MB", name: "中-3MB.bin", size: 3 * 1024 * 1024, seed: 13 },
  { label: "大 12MB", name: "大-12MB.bin", size: 12 * 1024 * 1024, seed: 29 },
  { label: "中文名+空格 64KB", name: "中文名称 空格 文档.txt", size: 64 * 1024, seed: 41 },
  { label: "含 test 名 4KB", name: "test-被拦截示例.txt", size: 4 * 1024, seed: 53 },
];

const panelStyle: React.CSSProperties = {
  position: "fixed",
  left: 8,
  bottom: 8,
  zIndex: 9999,
  width: 214,
  padding: "8px 10px",
  borderRadius: 10,
  border: "1px dashed #94a3b8",
  background: "rgba(255,255,255,0.96)",
  boxShadow: "0 6px 18px rgba(15,23,42,0.12)",
  fontSize: 12,
  lineHeight: 1.5,
  color: "#0f172a",
};

const btnStyle: React.CSSProperties = {
  margin: "2px 4px 2px 0",
  padding: "3px 6px",
  fontSize: 11,
  borderRadius: 6,
  border: "1px solid #cbd5e1",
  background: "#f8fafc",
  cursor: "pointer",
};

/** 随机内容 ⇒ 每次注入都是新 md5（用于首次上传）；固定内容 ⇒ 复用同 md5（用于秒传）。 */
const resolveSeed = (base: number, randomContent: boolean): number =>
  randomContent ? Math.floor(Math.random() * 100000) : base;

const FileInjectionPanel: React.FC = () => {
  const [randomContent, setRandomContent] = useState(true);
  const [customMb, setCustomMb] = useState(25);
  const [lastMsg, setLastMsg] = useState("就绪");

  const seedOf = (base: number) => resolveSeed(base, randomContent);

  const doInject = (specs: FixtureSpec[], msg: string) => {
    const ok = injectFiles(specs.map(makeFile));
    setLastMsg(ok ? `${msg} ✓` : "未找到文件输入框 ✗");
  };

  const onPreset = (preset: (typeof PRESETS)[number]) => {
    doInject(
      [{ name: preset.name, size: preset.size, seed: seedOf(preset.seed) }],
      `注入 ${preset.label}`,
    );
  };

  return (
    <div style={panelStyle} data-testid="dev-file-injection-panel">
      <div style={{ fontWeight: 600, marginBottom: 4 }}>
        测试注入口（仅开发环境）
      </div>
      <div style={{ display: "flex", flexWrap: "wrap" }}>
        {PRESETS.map((preset) => (
          <button
            key={preset.label}
            type="button"
            style={btnStyle}
            onClick={() => onPreset(preset)}
          >
            {preset.label}
          </button>
        ))}
        <button
          type="button"
          style={btnStyle}
          onClick={() => {
            const files: FixtureSpec[] = Array.from({ length: 11 }, (_, i) => ({
              name: `批量-${i + 1}.bin`,
              size: 64 * 1024,
              seed: seedOf(100 + i),
            }));
            doInject(files, "注入 11 个小文件");
          }}
        >
          11 个小文件
        </button>
        <button
          type="button"
          style={btnStyle}
          onClick={() => {
            // 多文件队列：用于「文件并发=2」下的排队/上传中窗口观察
            // （单个大文件在本机约 2s 完成，来不及点暂停/取消/删除）。
            const files: FixtureSpec[] = Array.from({ length: 3 }, (_, i) => ({
              name: `队列-${i + 1}-40MB.bin`,
              size: 40 * 1024 * 1024,
              seed: seedOf(200 + i),
            }));
            doInject(files, "注入 3×40MB 队列");
          }}
        >
          3×40MB 队列
        </button>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 4 }}>
        <label style={{ display: "flex", alignItems: "center", gap: 4 }}>
          <input
            type="checkbox"
            checked={randomContent}
            onChange={(e) => setRandomContent(e.target.checked)}
          />
          内容随机
        </label>
        <input
          type="number"
          min={1}
          max={200}
          value={customMb}
          onChange={(e) => setCustomMb(Number(e.target.value) || 1)}
          style={{ width: 48, fontSize: 11, padding: "1px 4px" }}
        />
        <button
          type="button"
          style={btnStyle}
          onClick={() =>
            doInject(
              [
                {
                  name: `自定义-${customMb}MB.bin`,
                  size: customMb * 1024 * 1024,
                  seed: seedOf(77),
                },
              ],
              `注入 ${customMb}MB`,
            )
          }
        >
          MB
        </button>
      </div>
      <div style={{ color: "#64748b", marginTop: 2 }}>
        内容随机={String(randomContent)}｜{lastMsg}
      </div>
    </div>
  );
};

export default FileInjectionPanel;
