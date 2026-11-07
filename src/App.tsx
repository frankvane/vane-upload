import {
  CSSProperties,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { API_BASE_URL, API_PATHS } from "./config/api";
import ZustandFileUpload from "./components/ZustandFileUpload";
import type { UploadFile } from "./components/ZustandFileUpload/types/upload";

interface UploadBatchResult {
  success: number;
  failed: number;
  total: number;
}

type NoticeLevel = "info" | "success" | "error";

interface NoticeItem {
  id: number;
  level: NoticeLevel;
  text: string;
}

const noticeStyleMap: Record<NoticeLevel, CSSProperties> = {
  info: {
    backgroundColor: "#e6f4ff",
    color: "#0958d9",
    borderColor: "#91caff",
  },
  success: {
    backgroundColor: "#f6ffed",
    color: "#237804",
    borderColor: "#b7eb8f",
  },
  error: {
    backgroundColor: "#fff2f0",
    color: "#cf1322",
    borderColor: "#ffccc7",
  },
};

const App = () => {
  const [notices, setNotices] = useState<NoticeItem[]>([]);
  const noticeTimersRef = useRef<Map<number, number>>(new Map());
  const noticeIdRef = useRef(0);

  const dismissNotice = useCallback((id: number) => {
    const timer = noticeTimersRef.current.get(id);
    if (timer !== undefined) {
      window.clearTimeout(timer);
      noticeTimersRef.current.delete(id);
    }

    setNotices((prev) => prev.filter((item) => item.id !== id));
  }, []);

  const notify = useCallback(
    (level: NoticeLevel, text: string) => {
      const id = (noticeIdRef.current += 1);
      const maxNoticeCount = 4;

      setNotices((prev) => {
        const next = [...prev, { id, level, text }];
        if (next.length <= maxNoticeCount) {
          return next;
        }

        const removed = next.slice(0, next.length - maxNoticeCount);
        for (const item of removed) {
          const timer = noticeTimersRef.current.get(item.id);
          if (timer !== undefined) {
            window.clearTimeout(timer);
            noticeTimersRef.current.delete(item.id);
          }
        }

        return next.slice(-maxNoticeCount);
      });

      const timer = window.setTimeout(() => {
        dismissNotice(id);
      }, 2500);
      noticeTimersRef.current.set(id, timer);
    },
    [dismissNotice],
  );

  useEffect(() => {
    const timers = noticeTimersRef.current;
    return () => {
      for (const timer of timers.values()) {
        window.clearTimeout(timer);
      }
      timers.clear();
    };
  }, []);

  const handleUploadStart = (files: UploadFile[]) => {
    notify("info", `开始上传 ${files.length} 个文件`);
  };

  const handleUploadComplete = (file: UploadFile, success: boolean) => {
    if (success) {
      notify("success", `上传成功: ${file.fileName}`);
      return;
    }

    notify("error", `上传失败: ${file.fileName}`);
  };

  const handleUploadError = (file: UploadFile, error: string) => {
    notify("error", `${file.fileName} 上传错误: ${error}`);
  };

  const handleUploadBatchComplete = (results: UploadBatchResult) => {
    notify(
      "success",
      `批量上传完成: 成功 ${results.success} 个, 失败 ${results.failed} 个`,
    );
  };

  const customFileValidator = (file: File) => {
    if (file.name.includes("test")) {
      return { valid: false, message: "文件名包含 test 时不允许上传" };
    }
    if (file.size > 500 * 1024 * 1024) {
      return { valid: false, message: "文件大小不能超过 500MB" };
    }
    return { valid: true };
  };

  return (
    <div
      style={{ padding: 16, minHeight: "100vh", backgroundColor: "#f5f7fb" }}
    >
      <h2 style={{ margin: 0, marginBottom: 12 }}>上传组件演示</h2>
      <p style={{ margin: "0 0 12px", color: "#4b5563", fontSize: 13 }}>
        支持文件选择与校验、分片上传、断点续传、队列与并发控制、IndexedDB
        暂存恢复。
      </p>

      <div
        style={{
          position: "fixed",
          top: 16,
          right: 16,
          zIndex: 1000,
          display: "flex",
          flexDirection: "column",
          gap: 8,
          width: "min(420px, calc(100vw - 32px))",
          pointerEvents: "none",
        }}
      >
        {notices.map((notice) => (
          <div
            key={notice.id}
            style={{
              ...noticeStyleMap[notice.level],
              borderWidth: 1,
              borderStyle: "solid",
              borderRadius: 8,
              padding: "8px 12px",
              fontSize: 13,
              boxShadow: "0 8px 20px rgba(0, 0, 0, 0.08)",
              pointerEvents: "auto",
            }}
          >
            {notice.text}
          </div>
        ))}
      </div>

      <div
        style={{
          backgroundColor: "#fff",
          border: "1px solid #e5e7eb",
          borderRadius: 10,
          padding: 12,
        }}
      >
        <ZustandFileUpload
          baseURL={API_BASE_URL}
          uploadApi={API_PATHS.file.upload}
          checkApi={API_PATHS.file.instant}
          chunkSize={1024 * 1024}
          fileConcurrency={2}
          chunkConcurrency={2}
          maxRetries={3}
          maxFileSize={100 * 1024 * 1024}
          allowedFileTypes={[]}
          maxFiles={10}
          autoUpload={true}
          autoCleanup={true}
          cleanupDelay={5}
          networkDisplayMode="tooltip"
          onUploadStart={handleUploadStart}
          onUploadComplete={handleUploadComplete}
          onUploadError={handleUploadError}
          onBatchComplete={handleUploadBatchComplete}
          customFileValidator={customFileValidator}
        />
      </div>
    </div>
  );
};

export default App;
