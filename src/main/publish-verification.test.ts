import assert from "node:assert/strict";
import test from "node:test";
import { backendTitleCandidates, publishUploadTimeout } from "./publish-verification.ts";

test("Bilibili and Weixin cannot verify another video with a shared title prefix", () => {
  const title = "今日开源热点趋势项目推荐：supabase｜围绕 Postgres 的开发平台";
  const other = "今日开源热点趋势项目推荐：colibri｜纯 C 磁盘流式运行超大模型";
  for (const platform of ["bilibili", "weixin"]) {
    const candidates = backendTitleCandidates(platform, title);
    assert.deepEqual(candidates, [title]);
    assert.equal(candidates.some((candidate) => other.includes(candidate)), false);
    assert.equal(candidates.some((candidate) => title.includes(candidate)), true);
  }
});

test("Weixin leaves time for processing after a three-minute upload", () => {
  assert.ok(publishUploadTimeout("weixin") > 180000 + 8000);
  assert.equal(publishUploadTimeout("bilibili"), 180000);
});
