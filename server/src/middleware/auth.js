// 可插拔鉴权中间件（参考实现）。
//
// 发布为「仅客户端组件库」时，本文件作为服务端对接示例：
// vane-crm 应替换为自家鉴权（如 portal_token 校验 + RBAC），但接口形态一致——
// 校验不通过返回 401 `{ code: 401, message, data: {} }`，与前端 401 处理对齐。
//
// 支持两种来源（任一即通过）：
//   1) Authorization: Bearer <token>（跨域常用，前端 getAuthHeaders/getAuthToken 注入）
//   2) 同域 Cookie（前端 axios withCredentials / Worker credentials:'include' 自动携带）
//
// 默认 fail-closed（拒绝优先）：
//   - 只要拿到有效凭据（Bearer token 命中白名单 / Cookie 命中白名单 / verify 放行）才 next()；
//   - 否则一律 401，绝不静默放行。
//   - 唯一的“放开口子”是显式传入 requireAuth:false（demo / 测试场景由 app.js 决定）。
//     app.js 默认 AUTH_MODE=secure，永远以 requireAuth:true 挂载本中间件；
//     因此生产路径绝不会出现“开了开关却 silently 全开”。
const crypto = require("crypto");

// 解析 Cookie；畸形百分号编码（decodeURIComponent 抛错）视为空值，绝不抛异常（S7）。
function parseCookies(header) {
  if (!header) return {};
  return header.split(";").reduce((acc, part) => {
    const idx = part.indexOf("=");
    if (idx === -1) return acc;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (!k) return acc;
    let decoded;
    try {
      decoded = decodeURIComponent(v);
    } catch (_err) {
      decoded = "";
    }
    acc[k] = decoded;
    return acc;
  }, {});
}

// 定长 + timingSafeEqual 比较，抗时序攻击（S7）。
function safeTokenEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

// P2-9：由凭据派生出稳定的主体 ID。
// 共享密钥模型没有账号体系，但「一把钥匙 = 一个主体」足以把数据按凭据隔离开：
// 同一 token 无论走 Bearer 还是 Cookie 都映射到同一 ID，且无法由客户端伪造。
function buildPrincipalId(token) {
  const digest = crypto
    .createHash("sha256")
    .update(String(token))
    .digest("hex");
  return `u_${digest.slice(0, 32)}`;
}

function attachPrincipal(req, token, source) {
  if (!req.user || !req.user.id) {
    req.user = { id: buildPrincipalId(token), source };
  }
}

function createAuthMiddleware(options = {}) {
  const {
    bearerTokens = [],
    cookieTokens = [], // Cookie 值白名单；未提供 verify 时必须命中才放行（P0-3）
    cookieName,
    verify, // (token, req, next) => void；返回 void 即放行，否则自行 res 结束
    requireAuth = true, // 默认 fail-closed：未提供有效凭据即拒绝
  } = options;

  return function authMiddleware(req, res, next) {
    // 预检请求（OPTIONS）不参与鉴权，交由 CORS 中间件处理，避免 401 阻断跨域预检。
    if (req.method === "OPTIONS") return next();

    // 显式关闭（demo / 测试）：直接放行，不做任何校验。
    if (requireAuth === false) return next();

    const authHeader = req.headers.authorization || "";
    const [scheme, token] = authHeader.split(" ");
    if (scheme === "Bearer" && token) {
      if (verify) {
        attachPrincipal(req, token, "bearer");
        return verify(token, req, next);
      }
      if (bearerTokens.some((t) => safeTokenEqual(t, token))) {
        attachPrincipal(req, token, "bearer");
        return next();
      }
    }

    if (cookieName) {
      const cookies = parseCookies(req.headers.cookie);
      const cookieValue = cookies[cookieName];
      if (cookieValue) {
        if (verify) {
          attachPrincipal(req, cookieValue, "cookie");
          return verify(cookieValue, req, next);
        }
        // P0-3：没有 verify 时必须命中 Cookie 白名单。绝不能「存在即通过」，
        // 否则任意非空 Cookie 都能绕过鉴权。
        if (cookieTokens.some((t) => safeTokenEqual(t, cookieValue))) {
          attachPrincipal(req, cookieValue, "cookie");
          return next();
        }
      }
    }

    // fail-closed：无论是否配置了校验，只要没拿到有效凭据就拒绝。
    // 唯一的放开口子是 requireAuth === false（由 app.js 在 demo/测试场景显式传入）。
    return res.status(401).json({ code: 401, message: "未授权", data: {} });
  };
}

module.exports = { createAuthMiddleware, parseCookies, buildPrincipalId };
