export function publishUploadTimeout(platform: string) {
  // 小红书 2026-11-05 用户批次实证：9MB 视频上传+转码耗时超过 3 分钟窗口，
  // 发布按钮在转码完成前持续禁用（页面已显示"重新上传"即文件已就位），
  // 与抖音/头条/视频号同为 10 分钟，避免大视频/慢转码被误判失败。
  return ["douyin", "toutiao", "weixin", "xiaohongshu"].includes(platform)
    ? 600000
    : 180000;
}

export function backendTitleCandidates(platform: string, title: string) {
  if (platform === "weixin" || platform === "bilibili") return [title];
  // 抖音作品管理列表会完整渲染标题（自动化输入即 ≤30 字整题），且同一账号
  // 常有“今日开源热点趋势项目推荐：XXX”这类同前缀系列旧作：短前缀候选会
  // 命中旧作造成假“发布成功”（2026-10-25 microduck 实证：页面全文无
  // microduck，但 12 字前缀命中 8 处旧作），因此抖音只允许整题匹配。
  if (platform === "douyin") return [title];
  // 小红书笔记标题上限 20 字、列表整题渲染，同前缀系列旧作同样会让短前缀
  // 候选误命中（2026-10-26 claude-seo 实证：整页快照无该标题，却匹配到
  // 首页“最新笔记”里的 microdu 旧笔记），因此小红书也只允许整题匹配。
  if (platform === "xiaohongshu") return [title];
  return [title, ...[24, 20, 16, 12].map((limit) => Array.from(title).slice(0, limit).join(""))]
    .filter((value) => value.length >= 2);
}
