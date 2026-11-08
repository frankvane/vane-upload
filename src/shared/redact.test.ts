import { describe, expect, it } from "vitest";
import { redactHeaders, scrubLogText } from "./redact";

/**
 * VU-05：凭据脱敏规则的确定性单测。
 *
 * 与 uploadWorker 的 200ms 节流 / 时序完全解耦：规则本身在这里被逐类验证，
 * worker 集成测试只负责「任何出站消息都不含明文凭据」这条不变式。
 */
describe("shared/redact（VU-05 凭据脱敏）", () => {
  describe("redactHeaders", () => {
    it("敏感头一律置换为 ***，非敏感头原样保留", () => {
      expect(
        redactHeaders({
          Authorization: "Bearer TOKEN_A",
          authorization: "Bearer TOKEN_B",
          Cookie: "session=COOKIE_A",
          "Set-Cookie": "sid=COOKIE_B",
          "Proxy-Authorization": "Basic TOKEN_C",
          "X-Api-Token": "TOKEN_D",
          "X-Api-Key": "TOKEN_E",
          "X-Custom-Auth": "TOKEN_F",
          "Content-Type": "application/json",
          Accept: "application/json",
        }),
      ).toEqual({
        Authorization: "***",
        authorization: "***",
        Cookie: "***",
        "Set-Cookie": "***",
        "Proxy-Authorization": "***",
        "X-Api-Token": "***",
        "X-Api-Key": "***",
        "X-Custom-Auth": "***",
        "Content-Type": "application/json",
        Accept: "application/json",
      });
    });

    it("undefined 原样返回，且不修改调用方传入的对象", () => {
      expect(redactHeaders(undefined)).toBeUndefined();
      const original = {
        Authorization: "Bearer KEEP_ME",
        "Content-Type": "application/json",
      };
      const snapshot = { ...original };
      redactHeaders(original);
      expect(original).toEqual(snapshot);
    });

    it("空对象返回新的空对象", () => {
      expect(redactHeaders({})).toEqual({});
    });
  });

  describe("scrubLogText", () => {
    it("JSON 对象里的敏感键值整段替换", () => {
      const input = JSON.stringify({
        authorization: "Bearer JSON_SECRET_A",
        Cookie: "session=JSON_SECRET_B",
        "Content-Type": "application/json",
      });
      const output = scrubLogText(input);
      expect(output).not.toContain("JSON_SECRET_A");
      expect(output).not.toContain("JSON_SECRET_B");
      expect(output).toContain('"authorization":"***"');
      expect(output).toContain("application/json");
    });

    it("纯文本 `Authorization: Bearer xxx` 不会残留裸 token", () => {
      const output = scrubLogText("Authorization: Bearer PLAIN_SECRET_TOKEN");
      expect(output).not.toContain("PLAIN_SECRET_TOKEN");
      expect(output).toBe("Authorization: ***");
    });

    it("裸 Bearer token 与 Cookie 赋值形式同样脱敏", () => {
      expect(scrubLogText("send Bearer STANDALONE_SECRET now")).toBe(
        "send Bearer *** now",
      );
      expect(scrubLogText("cookie=session=COOKIE_SECRET;")).not.toContain(
        "COOKIE_SECRET",
      );
    });

    it("同一段文本中多处敏感值全部替换（g 标志）", () => {
      const output = scrubLogText(
        "Authorization: Bearer SECRET_A; Cookie: session=SECRET_B",
      );
      expect(output).not.toContain("SECRET_A");
      expect(output).not.toContain("SECRET_B");
      expect(output).toBe("Authorization: ***; Cookie: ***");
    });

    it("非敏感业务字段不受影响", () => {
      const url = "/api/file/status?file_id=abc_1_2&md5=" + "d".repeat(32);
      expect(scrubLogText(url)).toBe(url);
      expect(scrubLogText("分片 3/100 上传成功，总进度: 3%")).toBe(
        "分片 3/100 上传成功，总进度: 3%",
      );
    });
  });
});
