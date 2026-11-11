import { describe, expect, it } from "vitest";

import { ChunkCacheMissError } from "./uploadWorkerTypes";

describe("uploadWorkerTypes · ChunkCacheMissError", () => {
  it("携带分片索引并给出可读文案", () => {
    const err = new ChunkCacheMissError(3);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("ChunkCacheMissError");
    expect(err.chunkIndex).toBe(3);
    expect(err.message).toBe("本地续传缓存缺少分片 4");
  });
});
