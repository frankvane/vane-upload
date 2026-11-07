const trimSlash = (value: string) => value.replace(/\/+$/, "");

// 兼容非 Vite 构建的消费方：import.meta.env 在 webpack/Next 等环境不一定存在，
// 用 try/catch 兜底，缺失时回退到相对路径（""）。baseURL 也可通过组件 props 覆盖。
const readEnv = (key: string): string => {
  try {
    const env = (import.meta as unknown as { env?: Record<string, string | undefined> }).env;
    return (env?.[key] as string | undefined) ?? "";
  } catch {
    return "";
  }
};

const rawBaseUrl = readEnv("VITE_API_BASE_URL").trim();

export const API_BASE_URL = rawBaseUrl ? trimSlash(rawBaseUrl) : "";

export const API_PATHS = {
  file: {
    instant: "/api/file/instant",
    status: "/api/file/status",
    upload: "/api/file/upload",
    merge: "/api/file/merge",
  },
};

export const buildApiUrl = (path: string) => `${API_BASE_URL}${path}`;
