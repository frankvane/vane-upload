import { describe, expect, it } from "vitest";

import { computeUploadProgress } from "./uploadProgress";

describe("computeUploadProgress（T3.4 字节级进度/速率）", () => {
  it("按字节累加推导百分比（50MB / 100MB = 50%）", () => {
    const r = computeUploadProgress({
      uploadedBytes: 50 * 1024 * 1024,
      totalBytes: 100 * 1024 * 1024,
      elapsedMs: 1000,
    });
    expect(r.progress).toBe(50);
    expect(r.uploadedBytes).toBe(50 * 1024 * 1024);
    expect(r.totalBytes).toBe(100 * 1024 * 1024);
  });

  it("速率 = 已传字节 / 耗时（50MB / 1s ≈ 52428800 B/s）", () => {
    const r = computeUploadProgress({
      uploadedBytes: 50 * 1024 * 1024,
      totalBytes: 100 * 1024 * 1024,
      elapsedMs: 1000,
    });
    expect(r.speed).toBe(50 * 1024 * 1024);
  });

  it("eta = 剩余字节 / 速率（剩 50MB @ 50MB/s = 1s）", () => {
    const r = computeUploadProgress({
      uploadedBytes: 50 * 1024 * 1024,
      totalBytes: 100 * 1024 * 1024,
      elapsedMs: 1000,
    });
    expect(r.eta).toBe(1);
  });

  it("完成态：进度钳到 100、eta 归零、速率保留", () => {
    const r = computeUploadProgress({
      uploadedBytes: 100 * 1024 * 1024,
      totalBytes: 100 * 1024 * 1024,
      elapsedMs: 2000,
    });
    expect(r.progress).toBe(100);
    expect(r.eta).toBe(0);
    expect(r.speed).toBe(50 * 1024 * 1024);
  });

  it("elapsed=0 不产生 Infinity/NaN：speed=0、eta=0", () => {
    const r = computeUploadProgress({
      uploadedBytes: 30 * 1024 * 1024,
      totalBytes: 100 * 1024 * 1024,
      elapsedMs: 0,
    });
    expect(r.progress).toBe(30);
    expect(r.speed).toBe(0);
    expect(r.eta).toBe(0);
    expect(Number.isFinite(r.speed)).toBe(true);
    expect(Number.isFinite(r.eta)).toBe(true);
  });

  it("speed 接近 0（耗时过大）时 eta 归零，避免除零", () => {
    const r = computeUploadProgress({
      uploadedBytes: 1024,
      totalBytes: 100 * 1024 * 1024,
      elapsedMs: 3_000_000, // 1024B / 3000s ≈ 0.34 B/s，向下取整为 0（视为停滞）
    });
    expect(r.speed).toBeLessThan(1);
    expect(r.eta).toBe(0);
  });

  it("uploadedBytes 超过总数时被钳制为 100%", () => {
    const r = computeUploadProgress({
      uploadedBytes: 200 * 1024 * 1024,
      totalBytes: 100 * 1024 * 1024,
      elapsedMs: 1000,
    });
    expect(r.progress).toBe(100);
    expect(r.uploadedBytes).toBe(100 * 1024 * 1024);
  });

  it("totalBytes=0 时安全返回全 0，不抛错", () => {
    const r = computeUploadProgress({
      uploadedBytes: 10,
      totalBytes: 0,
      elapsedMs: 500,
    });
    expect(r.progress).toBe(0);
    expect(r.uploadedBytes).toBe(0);
    expect(r.totalBytes).toBe(0);
    expect(Number.isFinite(r.speed)).toBe(true);
  });
});
