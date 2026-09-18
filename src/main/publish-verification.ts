export function publishUploadTimeout(platform: string) {
  return ["douyin", "toutiao", "weixin"].includes(platform) ? 600000 : 180000;
}

export function backendTitleCandidates(platform: string, title: string) {
  if (platform === "weixin" || platform === "bilibili") return [title];
  return [title, ...[24, 20, 16, 12].map((limit) => Array.from(title).slice(0, limit).join(""))]
    .filter((value) => value.length >= 2);
}
