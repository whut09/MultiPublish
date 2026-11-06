import { app, BrowserWindow, dialog, ipcMain, Menu, WebContentsView } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import ffmpegStatic from "ffmpeg-static";
import { resolveFfmpegBinary } from "./ffmpeg";
import { JsonStore } from "./store";
import { BrowserManager, chromeUserAgent } from "./browser-manager";
import { attachWindowDiagnostics } from "./runtime-guard";
import { platformMap } from "../shared/platforms";
import type {
  AccountInput,
  BrowserBounds,
  PublishDraft,
  PublishTask,
} from "../shared/types";
const dir = path.dirname(fileURLToPath(import.meta.url));
if (process.env.MULTIPUBLISH_USER_DATA_DIR)
  app.setPath("userData", process.env.MULTIPUBLISH_USER_DATA_DIR);
let win: BrowserWindow | null = null;
let browsers: BrowserManager | null = null;
let quittingAfterSessionFlush = false;
const store = new JsonStore();
const execFileAsync = promisify(execFile);
let verifiedFfmpegBinary: string | undefined;
async function getFfmpegBinary() {
  if (verifiedFfmpegBinary) return verifiedFfmpegBinary;
  const binary = resolveFfmpegBinary({
    resourcesPath: process.resourcesPath,
    appPath: app.getAppPath(),
    importedPath: ffmpegStatic,
    envPath: process.env.FFMPEG_PATH,
  });
  try {
    await execFileAsync(binary, ["-version"], {
      windowsHide: true,
      timeout: 5000,
      maxBuffer: 1024 * 1024,
    });
    verifiedFfmpegBinary = binary;
    return binary;
  } catch (error) {
    throw new Error(
      "FFmpeg 启动失败：" +
        binary +
        "；" +
        (error instanceof Error ? error.message : String(error)),
    );
  }
}
async function extractVideoCover(videoPath: string) {
  const coverDir = path.join(app.getPath("userData"), "covers");
  await fs.mkdir(coverDir, { recursive: true });
  const output = path.join(coverDir, randomUUID() + ".jpg");
  const input = await fs.stat(videoPath).catch(() => undefined);
  if (!input?.isFile() || input.size <= 0)
    throw new Error("视频文件不存在或为空：" + videoPath);
  const binary = await getFfmpegBinary();
  let lastError: unknown;
  for (const position of ["0.1", "1"]) {
    try {
      await execFileAsync(
        binary,
        [
          "-y",
          "-ss",
          position,
          "-i",
          videoPath,
          "-frames:v",
          "1",
          "-update",
          "1",
          "-vf",
          "scale=1280:-2",
          "-q:v",
          "2",
          output,
        ],
        { windowsHide: true, timeout: 15000, maxBuffer: 1024 * 1024 },
      );
      const stat = await fs.stat(output);
      if (stat.size > 0) {
        const bytes = await fs.readFile(output);
        return {
          path: output,
          dataUrl: "data:image/jpeg;base64," + bytes.toString("base64"),
        };
      }
    } catch (error) {
      lastError = error;
      await fs.rm(output, { force: true }).catch(() => undefined);
    }
  }
  throw new Error(
    "首帧封面提取失败：" +
      (lastError instanceof Error ? lastError.message : String(lastError)),
  );
}
async function runCoverSelfTest() {
  const videoPath = process.env.MULTIPUBLISH_COVER_SELF_TEST;
  if (!videoPath) return false;
  const reportPath =
    process.env.MULTIPUBLISH_COVER_SELF_TEST_RESULT ||
    path.join(app.getPath("temp"), "multipublish-cover-self-test.json");
  try {
    const binary = await getFfmpegBinary();
    const result = await extractVideoCover(videoPath);
    await fs.writeFile(
      reportPath,
      JSON.stringify(
        {
          ok: true,
          binary,
          videoPath,
          coverPath: result.path,
          coverBytes: (await fs.stat(result.path)).size,
          createdAt: new Date().toISOString(),
        },
        null,
        2,
      ),
      "utf8",
    );
    app.exit(0);
  } catch (error) {
    await fs
      .writeFile(
        reportPath,
        JSON.stringify(
          {
            ok: false,
            videoPath,
            error: error instanceof Error ? error.message : String(error),
            createdAt: new Date().toISOString(),
          },
          null,
          2,
        ),
        "utf8",
      )
      .catch(() => undefined);
    app.exit(1);
  }
  return true;
}
async function runPublishSelfTest() {
  const platform = process.env.MULTIPUBLISH_PUBLISH_SELF_TEST_PLATFORM as
    PublishDraft["accountIds"][number] | undefined;
  if (!platform) return false;
  const reportPath =
    process.env.MULTIPUBLISH_PUBLISH_SELF_TEST_RESULT ||
    path.join(app.getPath("temp"), "multipublish-publish-self-test.json");
  const draftId = process.env.MULTIPUBLISH_PUBLISH_SELF_TEST_DRAFT_ID;
  const data = store.get();
  const account = data.accounts.find((item) => item.platform === platform);
  const draft = draftId
    ? data.drafts.find((item) => item.id === draftId)
    : data.drafts.find((item) => item.accountIds.includes(account?.id || ""));
  const progress: Array<{ status: string; message: string; at: string }> = [];
  let testWindow: BrowserWindow | undefined;
  let manager: BrowserManager | undefined;
  try {
    if (!account) throw new Error("找不到平台账号：" + platform);
    if (!draft) throw new Error("找不到可发布草稿");
    testWindow = new BrowserWindow({
      show: false,
      width: 320,
      height: 240,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    manager = new BrowserManager(testWindow, async () => undefined);
    const result = await manager.autoPublish(
      account,
      draft,
      async (status, message) => {
        progress.push({ status, message, at: new Date().toISOString() });
        console.log("publish-self-test", platform, status, message);
      },
    );
    await fs.writeFile(
      reportPath,
      JSON.stringify(
        {
          ok: result.status === "success",
          platform,
          accountId: account.id,
          draftId: draft.id,
          result,
          progress,
          createdAt: new Date().toISOString(),
        },
        null,
        2,
      ),
      "utf8",
    );
    app.exit(result.status === "success" ? 0 : 2);
  } catch (error) {
    await fs
      .writeFile(
        reportPath,
        JSON.stringify(
          {
            ok: false,
            platform,
            draftId,
            error: error instanceof Error ? error.message : String(error),
            progress,
            createdAt: new Date().toISOString(),
          },
          null,
          2,
        ),
        "utf8",
      )
      .catch(() => undefined);
    app.exit(1);
  } finally {
    manager?.destroy();
    if (testWindow && !testWindow.isDestroyed()) testWindow.destroy();
  }
  return true;
}
async function runInspectSelfTest() {
  const platform = process.env.MULTIPUBLISH_INSPECT_SELF_TEST_PLATFORM;
  if (!platform) return false;
  const reportPath =
    process.env.MULTIPUBLISH_INSPECT_SELF_TEST_RESULT ||
    path.join(app.getPath("temp"), "multipublish-inspect-self-test.json");
  const data = store.get();
  const account = data.accounts.find((item) => item.platform === platform);
  const lastSuccessfulTask = account
    ? data.tasks.find(
        (item) =>
          item.accountId === account.id &&
          item.status === "success" &&
          item.title.trim(),
      )
    : undefined;
  const draft =
    (lastSuccessfulTask &&
      data.drafts.find((item) => item.id === lastSuccessfulTask.draftId)) ||
    data.drafts.find((item) => item.accountIds.includes(account?.id || ""));
  let inspectWindow: BrowserWindow | undefined;
  try {
    if (!account) throw new Error("找不到平台账号：" + platform);
    inspectWindow = new BrowserWindow({
      show: false,
      width: 1280,
      height: 900,
      webPreferences: {
        session: (await import("electron")).session.fromPartition(
          "persist:account-" + account.id,
        ),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        backgroundThrottling: false,
      },
    });
    const wc = inspectWindow.webContents;
    wc.setUserAgent(chromeUserAgent);
    const inspectUrl =
      account.platform === "bilibili"
        ? "https://member.bilibili.com/platform/upload-manager/article"
        : account.platform === "douyin"
          ? "https://creator.douyin.com/creator-micro/content/manage"
          : account.platform === "weixin"
            ? "https://channels.weixin.qq.com/platform/post/list"
          : platformMap[account.platform].homeUrl;
    await wc.loadURL(inspectUrl).catch((error) => {
      if (!/ERR_ABORTED/.test(String(error))) throw error;
    });
    await new Promise((resolve) => setTimeout(resolve, 7000));
    if (account.platform === "xiaohongshu") {
      await wc.executeJavaScript(
        "(()=>{const visible=e=>!!e&&e.offsetParent!==null;const nodes=[...document.querySelectorAll('a,button,[role=button],div,span')].filter(e=>visible(e)&&(e.textContent||'').trim()==='笔记管理');nodes.sort((a,b)=>(a.getBoundingClientRect().width*a.getBoundingClientRect().height)-(b.getBoundingClientRect().width*b.getBoundingClientRect().height));const label=nodes[0];if(!label)return false;(label.closest('a,button,[role=button]')||label).click();return true})()",
      );
      await new Promise((resolve) => setTimeout(resolve, 7000));
    }
    const artifactDir = path.join(app.getPath("userData"), "task-artifacts");
    await fs.mkdir(artifactDir, { recursive: true });
    const screenshotPath = path.join(
      artifactDir,
      "inspect-" + account.platform + "-" + Date.now() + ".png",
    );
    await fs.writeFile(screenshotPath, (await wc.capturePage()).toPNG());
    const snapshot = await wc.executeJavaScript(
      "(()=>{const text=(document.body?.innerText||'').slice(0,30000);return{url:location.href,title:document.title,text,login:/扫码登录|手机号登录|验证码登录|短信登录|密码登录|立即登录/.test(text)||location.pathname.includes('/login')||location.pathname.includes('/auth')}})()",
    );
    const frameSnapshots = (await Promise.all(
      wc.mainFrame.framesInSubtree.map((frame) =>
        frame
          .executeJavaScript(
            "(()=>{const text=(document.body?.innerText||'').slice(0,30000);return{url:location.href,text,login:/扫码登录|手机号登录|验证码登录|短信登录|密码登录|立即登录/.test(text)||location.pathname.includes('/login')||location.pathname.includes('/auth')}})()",
          )
          .catch(() => ({ url: "", text: "", login: false })),
      ),
    )) as Array<{ url: string; text: string; login: boolean }>;
    const combinedText = [
      snapshot.text,
      ...frameSnapshots.map((frame) => frame.text),
    ].join("\n");
    const expectedTitle =
      process.env.MULTIPUBLISH_INSPECT_SELF_TEST_TITLE?.trim() ||
      lastSuccessfulTask?.title ||
      draft?.title ||
      "";
    const candidates =
      account.platform === "weixin"
        ? [expectedTitle]
        : [
            expectedTitle,
            Array.from(expectedTitle).slice(0, 30).join(""),
            Array.from(expectedTitle).slice(0, 20).join(""),
            Array.from(expectedTitle).slice(0, 16).join(""),
            Array.from(expectedTitle).slice(0, 12).join(""),
          ].filter((value) => value.length >= 8);
    const normalize = (value: string) =>
      value
        .normalize("NFKC")
        .toLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, "");
    const normalizedText = normalize(combinedText);
    const foundTitle = candidates.some(
      (value) =>
        combinedText.includes(value) ||
        normalizedText.includes(normalize(value)),
    );
    const ok =
      !snapshot.login &&
      !frameSnapshots.some((frame) => frame.login) &&
      foundTitle;
    await fs.writeFile(
      reportPath,
      JSON.stringify(
        {
          ok,
          platform,
          url: snapshot.url,
          pageTitle: snapshot.title,
          expectedTitle,
          foundTitle,
          login: snapshot.login,
          text: combinedText,
          screenshotPath,
          createdAt: new Date().toISOString(),
        },
        null,
        2,
      ),
      "utf8",
    );
    app.exit(ok ? 0 : 2);
  } catch (error) {
    await fs
      .writeFile(
        reportPath,
        JSON.stringify(
          {
            ok: false,
            platform,
            error: error instanceof Error ? error.message : String(error),
            createdAt: new Date().toISOString(),
          },
          null,
          2,
        ),
        "utf8",
      )
      .catch(() => undefined);
    app.exit(1);
  } finally {
    if (inspectWindow && !inspectWindow.isDestroyed()) inspectWindow.destroy();
  }
  return true;
}
/**
 * 视图竞态回归自测：复现 2026-11-05"小红书登录页盖住发布记录页"。
 * 契约：
 * 1) show() 进行中用户切页（hide）→ 过期 show 不得把控件挂回主窗口；
 * 2) hide 之后的重新 show 必须正常挂载（账号页功能不受护栏影响）。
 */
// B站创作声明补选的独立验证：只打开投稿页，调用生产方法定位并点击
// "内容无需标注"，记录点击前后的 DOM，不上传、不发布任何内容。
async function runBilibiliDeclarationProbe() {
  if (process.env.MULTIPUBLISH_BILIBILI_DECLARATION_PROBE !== "1")
    return false;
  const reportPath =
    process.env.MULTIPUBLISH_BILIBILI_DECLARATION_PROBE_RESULT ||
    path.join(app.getPath("temp"), "multipublish-bilibili-declaration.json");
  let testWindow: BrowserWindow | undefined;
  try {
    const account = store.get().accounts.find((item) => item.platform === "bilibili");
    if (!account) throw new Error("找不到 B站账号");
    testWindow = new BrowserWindow({
      show: false,
      width: 1440,
      height: 900,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    const manager = new BrowserManager(testWindow, async () => undefined);
    await manager.show(account, "publish");
    const view = testWindow.contentView.children[0] as
      | WebContentsView
      | undefined;
    if (!view) throw new Error("投稿页视图未挂载");
    const wc = view.webContents;
    // 投稿页可能停在上传 landing（"本地浏览器存在1个未提交的视频"），
    // 此时表单未渲染、没有创作声明；点"继续编辑"恢复草稿进表单再探测。
    // SPA 渲染有延迟，每轮都重试点击并重新检查
    let ready = false;
    let resumed = false;
    for (let i = 0; i < 45; i++) {
      resumed =
        ((await wc
          .executeJavaScript(
            "(()=>{const all=root=>{const r=[];for(const e of root.querySelectorAll('*')){r.push(e);if(e.shadowRoot)r.push(...all(e.shadowRoot))}return r};const c=all(document).filter(e=>{const t=(e.textContent||'').trim();return t.includes('继续编辑')&&t.length<20&&e.children.length<4});c.sort((a,b)=>{const ar=a.getBoundingClientRect(),br=b.getBoundingClientRect();return ar.width*ar.height-br.width*br.height});if(!c[0])return false;(c[0].closest('button,[role=button]')||c[0]).click();return true})()",
          )
          .catch(() => false)) as boolean) || resumed;
      ready = (await wc
        .executeJavaScript("/创作声明/.test(document.body?.innerText||'')")
        .catch(() => false)) as boolean;
      if (ready) break;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    const before = (await wc
      .executeJavaScript("(document.body?.innerText||'').slice(-400)")
      .catch(() => "")) as string;
    const declarationDom = await wc
      .executeJavaScript(
        "(()=>{const all=root=>{const r=[];for(const e of root.querySelectorAll('*')){r.push(e);if(e.shadowRoot)r.push(...all(e.shadowRoot))}return r};const i=all(document).find(e=>e.tagName==='INPUT'&&/创作声明/.test(e.placeholder||''));if(!i)return{found:false,inputs:all(document).filter(e=>e.tagName==='INPUT').map(e=>({p:e.placeholder||'',v:e.value||''})).slice(0,30)};let p=i;for(let k=0;k<4&&p.parentElement;k++)p=p.parentElement;return{found:true,input:i.outerHTML.slice(0,800),area:p.outerHTML.slice(0,5000),text:(p.innerText||'').slice(0,800)}})()",
      )
      .catch((error) => String(error));
    const outcome = await manager.selectBilibiliDeclaration(wc);
    const report = {
      ok: ready && !!(outcome as { found?: boolean }).found,
      ready,
      resumed,
      outcome,
      url: wc.getURL(),
      bodyTail: before,
      declarationDom,
      createdAt: new Date().toISOString(),
    };
    await fs.writeFile(reportPath, JSON.stringify(report, null, 2), "utf8");
    app.exit(report.ok ? 0 : 2);
  } catch (error) {
    await fs.writeFile(
      reportPath,
      JSON.stringify({ ok: false, error: String(error) }, null, 2),
      "utf8",
    );
    app.exit(2);
  }
  return true;
}
async function runViewRaceSelfTest() {
  if (!process.env.MULTIPUBLISH_VIEW_RACE_SELF_TEST) return false;
  const reportPath =
    process.env.MULTIPUBLISH_VIEW_RACE_SELF_TEST_RESULT ||
    path.join(app.getPath("temp"), "multipublish-view-race-self-test.json");
  let testWindow: BrowserWindow | undefined;
  let manager: BrowserManager | undefined;
  const report = (result: Record<string, unknown>) =>
    fs.writeFile(reportPath, JSON.stringify(result, null, 2), "utf8");
  try {
    const data = store.get();
    const platform = process.env.MULTIPUBLISH_VIEW_RACE_SELF_TEST_PLATFORM;
    const account = data.accounts.find((a) =>
      platform ? a.platform === platform : a.platform === "xiaohongshu",
    );
    if (!account) throw new Error("找不到自测平台账号");
    testWindow = new BrowserWindow({ show: false, width: 1280, height: 900 });
    manager = new BrowserManager(testWindow, async () => undefined);
    // 第一步：发起 show 但不等待（模拟小红书探针/任何 await 造成的窗口期）
    const firstShow = manager.show(account, "home");
    await new Promise((resolve) => setTimeout(resolve, 300));
    // 第二步：窗口期内用户切页 → hide
    await manager.hide();
    await firstShow.catch((error) => String(error));
    const childrenAfterHide = testWindow.contentView.children.length;
    // 第三步：hide 之后的重新 show（用户再点账号）必须正常挂载
    await manager.show(account, "home");
    const childrenAfterReshow = testWindow.contentView.children.length;
    const ok = childrenAfterHide === 0 && childrenAfterReshow === 1;
    await report({
      ok,
      platform: account.platform,
      childrenAfterHide,
      childrenAfterReshow,
      createdAt: new Date().toISOString(),
    });
    app.exit(ok ? 0 : 2);
  } catch (error) {
    await report({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      createdAt: new Date().toISOString(),
    }).catch(() => undefined);
    app.exit(1);
  } finally {
    if (testWindow && !testWindow.isDestroyed()) testWindow.destroy();
  }
  return true;
}
async function createWindow() {
  win = new BrowserWindow({
    width: 1500,
    height: 920,
    minWidth: 1100,
    minHeight: 720,
    backgroundColor: "#f4f7fb",
    title: "多平台发布助手",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(dir, "../preload/index.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  attachWindowDiagnostics(win);
  browsers = new BrowserManager(win, async (id, update) => {
    let changed = false;
    await store.update((d) => {
      const account = d.accounts.find((x) => x.id === id);
      if (!account) return;
      changed = Object.entries(update).some(
        ([key, value]) => account[key as keyof typeof account] !== value,
      );
      if (changed) Object.assign(account, update);
    });
    if (changed) win?.webContents.send("data:changed");
  });
  if (process.env.ELECTRON_RENDERER_URL)
    await win.loadURL(process.env.ELECTRON_RENDERER_URL);
  else await win.loadFile(path.join(dir, "../../dist/index.html"));
  win.on("closed", () => {
    // Windows exits after its last window closes. Keep the browser manager alive
    // until before-quit so its persistent login partitions can finish flushing.
    if (process.platform === "darwin") {
      void browsers?.destroy();
      browsers = null;
    }
    win = null;
  });
}
function ipc() {
  /**
   * 执行单个发布任务：带 45 分钟硬超时。超时后强制中止自动化窗口并把
   * 任务标记为失败（可重试），避免任务永远停在"等待自动发布"
   * （2026-10-26 抖音任务卡死实证：CDP 调用在页面未就绪时永不返回）。
   */
  const runTask = async (task: PublishTask, draft: PublishDraft) => {
    const account = store
      .get()
      .accounts.find((x) => x.id === task.accountId);
    if (!account) return;
    const progress = async (status: any, message: string) => {
      await store.update((d) => {
        const current = d.tasks.find((x) => x.id === task.id);
        if (current)
          Object.assign(current, {
            status,
            message,
            updatedAt: new Date().toISOString(),
          });
      });
      win?.webContents.send("data:changed");
    };
    try {
      const result = await Promise.race([
        browsers!.autoPublish(account, draft, progress),
        new Promise<null>((resolve) =>
          setTimeout(() => resolve(null), 45 * 60 * 1000),
        ),
      ]);
      if (!result) {
        await browsers!.abortPublish(account.id);
        await progress(
          "failed",
          "发布超时（45 分钟未返回结果），已终止自动化窗口，可点“重新发布”重试",
        );
        return;
      }
      await progress(result.status, result.message);
    } catch (error) {
      await progress(
        "failed",
        "自动发布任务异常：" +
          (error instanceof Error ? error.message : String(error)),
      );
    }
  };
  ipcMain.handle("data:get", () => store.get());
  ipcMain.handle("app:version", () => app.getVersion());
  ipcMain.handle("data:recovery", () => store.getRecovery());
  ipcMain.handle("browser:close", (_e, id: string) => browsers?.close(id));
  ipcMain.handle("account:add", (_e, input: AccountInput) =>
    store.update((d) => {
      d.accounts.push({
        id: randomUUID(),
        platform: input.platform,
        name:
          (
            {
              douyin: "抖音",
              kuaishou: "快手",
              xiaohongshu: "小红书",
              toutiao: "头条号",
              weixin: "视频号",
              bilibili: "哔哩哔哩",
              qqmedia: "企鹅号",
            } as const
          )[input.platform] + "账号",
        loginStatus: "checking",
        createdAt: new Date().toISOString(),
      });
    }),
  );
  ipcMain.handle("account:remove", async (_e, id: string) => {
    await browsers?.remove(id);
    return store.update((d) => {
      d.accounts = d.accounts.filter((x) => x.id !== id);
      d.tasks = d.tasks.filter((x) => x.accountId !== id);
      for (const type of ["video", "image_text"] as const) {
        d.accountSelections[type] = (d.accountSelections[type] || []).filter(
          (accountId) => accountId !== id,
        );
      }
    });
  });
  ipcMain.handle(
    "browser:show",
    async (_e, id: string, target: "home" | "publish" = "home") => {
      const a = store.get().accounts.find((x) => x.id === id);
      if (!a) throw new Error("账号不存在");
      await browsers?.show(a, target);
    },
  );
  ipcMain.handle("browser:hide", () => browsers?.hide());
  ipcMain.handle("browser:bounds", (_e, b: BrowserBounds) =>
    browsers?.setBounds(b),
  );
  ipcMain.handle(
    "browser:navigate",
    (_e, a: "back" | "forward" | "reload" | "home", id: string) =>
      browsers?.navigate(
        a,
        store.get().accounts.find((x) => x.id === id),
      ),
  );
  ipcMain.handle("video:cover", async (_e, videoPath: string) => {
    try {
      return { ok: true, ...(await extractVideoCover(videoPath)) };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  });
  ipcMain.handle(
    "file:pick",
    async (_e, kind: "video" | "images" | "cover") => {
      if (!win) return [];
      const r = await dialog.showOpenDialog(win, {
        properties:
          kind === "images" ? ["openFile", "multiSelections"] : ["openFile"],
        filters:
          kind === "video"
            ? [{ name: "视频", extensions: ["mp4", "mov", "mkv", "webm"] }]
            : [{ name: "图片", extensions: ["jpg", "jpeg", "png", "webp"] }],
      });
      return r.canceled ? [] : r.filePaths;
    },
  );
  ipcMain.handle(
    "publish:create",
    async (_e, draft: Omit<PublishDraft, "id" | "createdAt">) => {
      if (draft.type === "video" && draft.mediaPaths[0]) {
        try {
          draft.coverPath = (await extractVideoCover(draft.mediaPaths[0])).path;
        } catch {
          draft.coverPath = undefined;
        }
      }
      const now = new Date().toISOString(),
        created = { ...draft, id: randomUUID(), createdAt: now };
      return store.update((d) => {
        d.drafts.unshift(created);
        for (const id of created.accountIds) {
          const a = d.accounts.find((x) => x.id === id);
          if (a)
            d.tasks.unshift({
              id: randomUUID(),
              draftId: created.id,
              accountId: id,
              platform: a.platform,
              title: created.title,
              status: "pending",
              message: "等待自动发布",
              createdAt: now,
              updatedAt: now,
            });
        }
      });
    },
  );
  ipcMain.handle("publish:auto", async (_e, draftId: string) => {
    const draft = store.get().drafts.find((x) => x.id === draftId);
    if (!draft) throw new Error("发布内容不存在");
    const tasks = store
      .get()
      .tasks.filter((x) => x.draftId === draftId && x.status !== "success");
    const concurrency = Math.min(3, tasks.length);
    let cursor = 0;
    const worker = async () => {
      while (true) {
        const task = tasks[cursor++];
        if (!task) return;
        await runTask(task, draft);
      }
    };
    await Promise.all(Array.from({ length: concurrency }, () => worker()));
    return store.get();
  });
  ipcMain.handle("task:retry", async (_e, id: string) => {
    const data = store.get(),
      task = data.tasks.find((x) => x.id === id),
      draft = data.drafts.find((x) => x.id === task?.draftId);
    if (!task || !draft) throw new Error("任务或发布内容不存在");
    await runTask(task, draft);
    return store.get();
  });
  ipcMain.handle("task:open", async (_e, id: string) => {
    const data = store.get(),
      task = data.tasks.find((x) => x.id === id),
      account = data.accounts.find((x) => x.id === task?.accountId);
    if (!task || !account) throw new Error("任务或账号不存在");
    await browsers?.show(account, "publish");
    return store.update((d) => {
      const t = d.tasks.find((x) => x.id === id);
      if (t)
        Object.assign(t, {
          status: "manual_required",
          message: "官方发布页已打开，请检查并完成发布",
          updatedAt: new Date().toISOString(),
        });
    });
  });
  ipcMain.handle("task:complete", (_e, id: string) =>
    store.update((d) => {
      const t = d.tasks.find((x) => x.id === id);
      if (t)
        Object.assign(t, {
          status: "success",
          message: "发布成功",
          updatedAt: new Date().toISOString(),
        });
    }),
  );
  ipcMain.handle("task:fail", (_e, id: string, reason: string) =>
    store.update((d) => {
      const t = d.tasks.find((x) => x.id === id);
      if (t)
        Object.assign(t, {
          status: "failed",
          message: reason || "发布失败，未填写原因",
          updatedAt: new Date().toISOString(),
        });
    }),
  );
}
const singleInstanceLock = app.requestSingleInstanceLock();
if (!singleInstanceLock) app.quit();
else
  app.on("second-instance", () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    }
  });
app.whenReady().then(async () => {
  Menu.setApplicationMenu(null);
  if (await runCoverSelfTest()) return;
  const recovery = await store.load();
  if (recovery.warning) console.warn(recovery.warning);
  if (await runPublishSelfTest()) return;
  if (await runInspectSelfTest()) return;
  if (await runBilibiliDeclarationProbe()) return;
  if (await runViewRaceSelfTest()) return;
  ipc();
  await createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
app.on("before-quit", (event) => {
  if (quittingAfterSessionFlush || !browsers) return;
  event.preventDefault();
  quittingAfterSessionFlush = true;
  void browsers.destroy().finally(() => {
    browsers = null;
    app.quit();
  });
});
ipcMain.handle(
  "account:selection",
  (_e, type: "video" | "image_text", accountIds: string[]) =>
    store.update((d) => {
      const valid = new Set(d.accounts.map((account) => account.id));
      d.accountSelections[type] = Array.from(
        new Set(accountIds.filter((id) => valid.has(id))),
      );
    }),
);
