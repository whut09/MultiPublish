import { app, BrowserWindow, WebContentsView, session, shell } from "electron";
import { promises as fs } from "node:fs";
import path from "node:path";
import type {
  Account,
  BrowserBounds,
  DouyinSyncTarget,
  LoginStatus,
  PublishDraft,
  TaskStatus,
} from "../shared/types";
import { platformMap } from "../shared/platforms";
import { backendTitleCandidates, publishUploadTimeout } from "./publish-verification";
type AccountUpdate = { name?: string; loginStatus?: LoginStatus };
type PublishProgress = (status: TaskStatus, message: string) => Promise<void>;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
/**
 * CDP 调用超时护栏：Electron 的 debugger 命令在页面未就绪时可能永不返回，
 * 挂起会让整个发布任务卡死（2026-10-26 抖音任务卡在"等待自动发布"实证）。
 * 超时后放弃该调用并落盘日志，发布主链路继续。
 */
const cdpWithTimeout = async <T>(
  promise: Promise<T>,
  ms: number,
  label: string,
): Promise<T | undefined> => {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T | undefined>((resolve) => {
        timer = setTimeout(() => {
          void writeBrowserLog("publish-cdp-timeout " + label);
          resolve(undefined);
        }, ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
};
const writeBrowserLog = async (message: string) => {
  const line = `[${new Date().toISOString()}] ${message}\n`;
  await fs
    .appendFile(
      path.join(app.getPath("logs"), "multipublish-browser.log"),
      line,
    )
    .catch(() => undefined);
};
const redactWeixinDiagnostic = (value: unknown, limit = 16000) =>
  String(value ?? "")
    .replace(
      /((?:cookie|sessionid|token|findertoken|encfilekey|authkey)["']?\s*[:=]\s*["']?)[^"'&\s,}]+/gi,
      "$1[redacted]",
    )
    .replace(/([?&](?:token|findertoken|encfilekey)=)[^&\s]+/gi, "$1[redacted]")
    .slice(0, limit);
export const chromeUserAgent =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36";
// 小红书创作平台按访问地域分为国内站与海外站：
// 国内用户停留在 creator.xiaohongshu.com，海外用户会被平台自动跳转到 creator.rednote.com。
// 导航时沿用当前会话所在的域名，避免把用户强制推到另一个地域的站点。
const XHS_ORIGIN_DOMESTIC = "https://creator.xiaohongshu.com";
const XHS_ORIGIN_OVERSEAS = "https://creator.rednote.com";
const XHS_PUBLISH_PATH = "/publish/publish?from=homepage&target=video";
const xhsOriginFromUrl = (url?: string) => {
  try {
    const host = new URL(url || "").hostname.toLowerCase();
    if (host === "rednote.com" || host.endsWith(".rednote.com"))
      return XHS_ORIGIN_OVERSEAS;
  } catch {
    // 空 URL 或非法 URL 时按国内站处理
  }
  return XHS_ORIGIN_DOMESTIC;
};
const weixinPostListRecorder = `(()=>{try{if(window.__multipublishPostListRecorder)return true;window.__multipublishPostListRecorder=true;window.__multipublishPostListEvidence=[];const record=(url,body)=>{if(!/\\/post\\/post_list(?:\\?|$)/.test(String(url||""))||typeof body!=="string")return;try{const parsed=JSON.parse(body);const list=parsed?.data?.list;if(!Array.isArray(list))return;const titles=list.map(item=>({objectId:String(item?.objectId||"").slice(0,120),createTime:item?.createTime,titles:[item?.desc?.description,item?.desc?.mpTitle,item?.description,item?.title,...(Array.isArray(item?.desc?.shortTitle)?item.desc.shortTitle.map(value=>typeof value==="string"?value:value?.shortTitle):[])].filter(value=>typeof value==="string"&&value.trim())}));window.__multipublishPostListEvidence.push({url:String(url),titles});if(window.__multipublishPostListEvidence.length>4)window.__multipublishPostListEvidence.shift()}catch(_){}};const fetch0=window.fetch;if(typeof fetch0==="function")window.fetch=function(input,init){const url=typeof input==="string"?input:input?.url||"";return fetch0.call(this,input,init).then(response=>{if(/\\/post\\/post_list(?:\\?|$)/.test(String(url)))response.clone().text().then(body=>record(url,body)).catch(()=>{});return response})};const open0=XMLHttpRequest.prototype.open;XMLHttpRequest.prototype.open=function(method,url){this.__multipublishPostListUrl=String(url||"");return open0.apply(this,arguments)};const send0=XMLHttpRequest.prototype.send;XMLHttpRequest.prototype.send=function(body){if(/\\/post\\/post_list(?:\\?|$)/.test(this.__multipublishPostListUrl||""))this.addEventListener("load",()=>{try{record(this.__multipublishPostListUrl,this.responseText)}catch(_){}});return send0.call(this,body)};return true}catch(_){return false}})()`;
const extractWeixinPostListTitles = (body: string) => {
  try {
    const list = JSON.parse(body)?.data?.list;
    if (!Array.isArray(list)) return [] as string[];
    return list.flatMap((item: any) =>
      [
        item?.desc?.description,
        item?.desc?.mpTitle,
        item?.description,
        item?.title,
        ...(Array.isArray(item?.desc?.shortTitle)
          ? item.desc.shortTitle.map((value: any) =>
              typeof value === "string" ? value : value?.shortTitle,
            )
          : []),
      ].filter(
        (value): value is string =>
          typeof value === "string" && Boolean(value.trim()),
      ),
    );
  } catch {
    return [] as string[];
  }
};
export class BrowserManager {
  private views = new Map<string, WebContentsView>();
  private inspectTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private inspectVersions = new Map<string, number>();
  private sessionFlushes = new Map<string, Promise<void>>();
  private weixinRemoteUploadAt = new Map<number, number>();
  private weixinUploadFailures = new Map<number, string>();
  private weixinPublishPoints = new Map<number, { x: number; y: number }>();
  private weixinPostCreateResults = new Map<
    number,
    { ok: boolean; errCode?: number; body: string }
  >();
  private weixinPostCreateRequested = new Set<number>();
  private weixinPostListTitles = new Map<number, string[]>();
  private xhsOrigins = new Map<string, string>();
  // 小红书可见视图的发布请求探针（按账号记录，避免重复挂载）
  private xhsViewProbes = new Map<
    string,
    (_event: Electron.Event, method: string, params: any) => void
  >();
  // 自动化发布窗口按账号登记：任务超时/卡死时可以被强制中止并释放。
  private automationWindows = new Map<string, BrowserWindow>();
  private active?: string;
  private bounds: BrowserBounds = { x: 280, y: 160, width: 900, height: 650 };
  constructor(
    private win: BrowserWindow,
    private updateAccount: (id: string, update: AccountUpdate) => Promise<void>,
  ) {}
  private accountSession(accountId: string) {
    return session.fromPartition("persist:account-" + accountId);
  }
  // 返回该账号当前所在的小红书店点：优先用最近检测到的域名，
  // 否则回退到已打开的账号视图 URL，最后默认国内站（会由平台自动跳转）。
  private xhsOrigin(account: Account) {
    const detected = this.xhsOrigins.get(account.id);
    if (detected) return detected;
    const viewUrl = this.views.get(account.id)?.webContents.getURL();
    return xhsOriginFromUrl(viewUrl);
  }
  private xhsUrl(account: Account, path: string) {
    return this.xhsOrigin(account).replace(/\/+$/, "") + path;
  }
  private async flushAccountSession(accountId: string, reason: string) {
    const existing = this.sessionFlushes.get(accountId);
    if (existing) return existing;
    const profile = this.accountSession(accountId);
    const flush = Promise.all([
      profile.cookies.flushStore(),
      profile.flushStorageData(),
    ])
      .then(() =>
        writeBrowserLog(
          `session-flushed account=${accountId} reason=${reason}`,
        ),
      )
      .catch(async (error) => {
        await writeBrowserLog(
          `session-flush-failed account=${accountId} reason=${reason} error=${String(error)}`,
        );
      })
      .finally(() => this.sessionFlushes.delete(accountId));
    this.sessionFlushes.set(accountId, flush);
    return flush;
  }
  private ensureView(account: Account) {
    let view = this.views.get(account.id);
    if (view) return view;
    view = new WebContentsView({
      webPreferences: {
        session: this.accountSession(account.id),
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
      },
    });
    view.webContents.setUserAgent(chromeUserAgent);
    void writeBrowserLog(
      `create account=${account.id} platform=${account.platform} url=${view.webContents.getURL()}`,
    );
    view.webContents.setWindowOpenHandler(({ url }) => {
      void writeBrowserLog(`window-open account=${account.id} url=${url}`);
      if (account.platform === "weixin")
        return {
          action: "allow",
          overrideBrowserWindowOptions: {
            show: true,
            width: 900,
            height: 700,
            autoHideMenuBar: true,
            webPreferences: {
              session: this.accountSession(account.id),
              nodeIntegration: false,
              contextIsolation: true,
              sandbox: true,
              backgroundThrottling: false,
            },
          },
        };
      if (url.startsWith("http")) view?.webContents.loadURL(url);
      else shell.openExternal(url);
      return { action: "deny" };
    });
    const inspect = () => {
      void writeBrowserLog(
        `navigation account=${account.id} url=${view!.webContents.getURL()}`,
      );
      this.scheduleInspect(account, view!);
    };
    view.webContents.on("did-finish-load", inspect);
    view.webContents.on("did-navigate", inspect);
    view.webContents.on("did-frame-navigate", inspect);
    view.webContents.on("did-redirect-navigation", inspect);
    view.webContents.on("did-navigate-in-page", inspect);
    view.webContents.on("page-title-updated", inspect);
    this.views.set(account.id, view);
    return view;
  }
  async show(account: Account, target: "home" | "publish" = "home") {
    const view = this.ensureView(account);
    // 小红书可见视图挂发布请求探针：用户在可见发布页手动发布时，
    // 抓取带"声明原创"状态的完整请求体，用于确定原创字段的真实名称
    // （自动勾选已证实 DOM 生效但 React 状态不进 payload，注入方案
    // 需要先拿到字段名，不能猜）
    if (
      account.platform === "xiaohongshu" &&
      !this.xhsViewProbes.has(account.id)
    ) {
      const listener = await this.installPublishRequestProbe(
        view.webContents,
        "xiaohongshu-view",
      );
      if (listener) {
        this.xhsViewProbes.set(account.id, listener);
        view.webContents.once("destroyed", () => {
          const l = this.xhsViewProbes.get(account.id);
          if (l) {
            view.webContents.debugger.removeListener("message", l);
            this.xhsViewProbes.delete(account.id);
          }
        });
      }
    }
    if (this.active && this.active !== account.id) {
      const old = this.views.get(this.active);
      if (old) this.win.contentView.removeChildView(old);
    }
    if (!this.win.contentView.children.includes(view))
      this.win.contentView.addChildView(view);
    this.active = account.id;
    view.setBounds(this.bounds);
    const p = platformMap[account.platform];
    void writeBrowserLog(
      `show account=${account.id} target=${target} current=${view.webContents.getURL()}`,
    );
    if (!view.webContents.getURL() || target === "publish")
      await view.webContents.loadURL(
        account.platform === "xiaohongshu"
          ? this.xhsUrl(
              account,
              target === "publish" ? XHS_PUBLISH_PATH : "/",
            )
          : target === "publish"
            ? p.publishUrl
            : p.homeUrl,
      );
    await this.updateAccount(account.id, { loginStatus: "checking" });
    await sleep(1000);
    await this.inspectAccount(account, view);
    // 平台后台多为单页应用，扫码或会话恢复后的跳转不总是触发导航事件；
    // 在一段时间内补几次检测，保证登录态徽标能及时翻转。
    for (const delay of [2000, 5000, 12000, 25000, 45000])
      setTimeout(() => {
        if (
          view!.webContents.isDestroyed() ||
          this.win.isDestroyed() ||
          !this.win.contentView.children.includes(view!)
        )
          return;
        this.inspectAccount(account, view!).catch(() => undefined);
      }, delay);
  }

  private scheduleInspect(account: Account, view: WebContentsView) {
    const previous = this.inspectTimers.get(account.id);
    if (previous) clearTimeout(previous);
    const version = (this.inspectVersions.get(account.id) || 0) + 1;
    this.inspectVersions.set(account.id, version);
    const timer = setTimeout(() => {
      this.inspectTimers.delete(account.id);
      void this.inspectAccount(account, view, version);
    }, 1400);
    this.inspectTimers.set(account.id, timer);
  }
  /**
   * 强制中止某个账号正在进行的自动化发布窗口：任务卡死（如 CDP 挂起）时
   * 由主进程调度器调用，避免任务永远停在"等待发布"。
   */
  async abortPublish(accountId: string): Promise<boolean> {
    const win = this.automationWindows.get(accountId);
    if (!win || win.isDestroyed()) return false;
    win.destroy();
    this.automationWindows.delete(accountId);
    await writeBrowserLog("publish-aborted account=" + accountId);
    return true;
  }
  async autoPublish(
    account: Account,
    draft: PublishDraft,
    progress: PublishProgress,
  ) {
    // 先把任务从"等待自动发布"推进到可见状态：后续任何卡点都会在界面上
    // 反映出停在哪一步，而不是永远停在 pending。
    await progress(
      "opening",
      "正在准备" + platformMap[account.platform].name + "发布任务…",
    );
    const videoPath = draft.mediaPaths[0];
    if (!videoPath)
      return { status: "failed" as const, message: "草稿没有选择视频文件" };
    const videoStat = await fs.stat(videoPath).catch(() => undefined);
    if (!videoStat?.isFile() || videoStat.size < 1024)
      return {
        status: "failed" as const,
        message: "视频文件不存在或为空：" + videoPath,
      };
    const automationWindow = new BrowserWindow({
      show: false,
      skipTaskbar: true,
      autoHideMenuBar: true,
      title: "MultiPublish",
      x: -10000,
      y: -10000,
      width: 1280,
      height: 900,
      webPreferences: {
        session: this.accountSession(account.id),
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        backgroundThrottling: false,
      },
    });
    automationWindow.setOpacity(0.01);
    // Keep Chromium rendering without bringing an off-screen publisher to the
    // foreground. Fully hidden windows can stall platform upload processing.
    automationWindow.showInactive();
    this.automationWindows.set(account.id, automationWindow);
    const wc = automationWindow.webContents;
    wc.setUserAgent(chromeUserAgent);
    wc.setAudioMuted(true);
    let weixinDiagnosticListener:
      | ((_event: Electron.Event, method: string, params: any) => void)
      | undefined;
    const weixinDiagnosticRequests = new Map<
      string,
      { method: string; url: string }
    >();
    // 抖音发布链路曾有"点击后跳转管理页但作品从未落库"的哑弹（URL 跳转
    // 不代表提交成功），挂 Network 监听把发布相关 API 的真实响应状态留痕。
    // 注意：监听必须在页面加载完成后再挂载——在 about:blank 上提前
    // attach/Network.enable 会永久挂起（2026-10-26 抖音任务卡在"等待自动
    // 发布"实证），因此这里只声明句柄，实际挂载见抖音分支。
    let douyinNetworkListener:
      | ((_event: Electron.Event, method: string, params: any) => void)
      | undefined;
    let xhsNetworkListener:
      | ((_event: Electron.Event, method: string, params: any) => void)
      | undefined;
    try {
      await progress(
        "opening",
        "正在进入" + platformMap[account.platform].name + "发布页面",
      );
      await wc
        .loadURL(
          account.platform === "xiaohongshu"
            ? this.xhsUrl(account, XHS_PUBLISH_PATH)
            : platformMap[account.platform].publishUrl,
        )
        .catch(async (error) => {
          const message = String(error);
          void writeBrowserLog(
            "publish-load-error account=" +
              account.id +
              " url=" +
              wc.getURL() +
              " error=" +
              message,
          );
          if (!/ERR_ABORTED/.test(message)) throw error;
          await sleep(1500);
        });
      if (account.platform === "weixin") {
        this.weixinRemoteUploadAt.delete(wc.id);
        this.weixinUploadFailures.delete(wc.id);
        this.weixinPublishPoints.delete(wc.id);
        this.weixinPostCreateRequested.delete(wc.id);
        this.weixinPostListTitles.delete(wc.id);
        if (!wc.debugger.isAttached()) wc.debugger.attach("1.3");
        await Promise.all([
          wc.debugger.sendCommand("Runtime.enable"),
          wc.debugger.sendCommand("Log.enable"),
          wc.debugger.sendCommand("Network.enable"),
        ]);
        await Promise.all(
          [wc.mainFrame, ...wc.mainFrame.framesInSubtree].map((frame) =>
            frame.executeJavaScript(weixinPostListRecorder).catch(() => undefined),
          ),
        );
        weixinDiagnosticListener = (_event, method, params) => {
          let diagnostic: unknown;
          if (method === "Runtime.consoleAPICalled") {
            const args = (params.args || []).map((arg: any) =>
              arg.value !== undefined ? arg.value : arg.description,
            );
            if (params.type === "error" && args.some((value: unknown) =>
              typeof value === "string" && /uploadpartdfs/.test(value) &&
              /connect timeout|upload.*fail|network error/i.test(value),
            )) {
              this.weixinUploadFailures.set(wc.id, "视频号视频分片上传连接失败，请检查系统代理或网络连接");
            }
            if (
              args.some(
                (value: unknown) =>
                  typeof value === "string" && value.includes("@@@视频URL变化"),
              ) &&
              args.some(
                (value: unknown) =>
                  typeof value === "string" &&
                  value.includes("finder.video.qq.com"),
              )
            ) {
              this.weixinUploadFailures.delete(wc.id);
              this.weixinRemoteUploadAt.set(wc.id, Date.now());
            }
            diagnostic = {
              type: params.type,
              args,
            };
          } else if (method === "Runtime.exceptionThrown")
            diagnostic = params.exceptionDetails;
          else if (method === "Log.entryAdded") diagnostic = params.entry;
          else if (method === "Network.loadingFailed") diagnostic = params;
          else if (method === "Network.requestWillBeSent") {
            const request = params.request || {};
            const requestMethod = String(request.method || "");
            const url = String(request.url || "");
            const postData = String(request.postData || "");
            if (/\/post\/post_create(?:\?|$)/.test(url))
              this.weixinPostCreateRequested.add(wc.id);
            if (/UploadFileSuccess/.test(postData) && /videoFileType/.test(postData)) {
              this.weixinUploadFailures.delete(wc.id);
              this.weixinRemoteUploadAt.set(wc.id, Date.now());
            }
            if (requestMethod && requestMethod !== "GET") {
              const relevant =
                /(?:post|publish|create|finderassistant|finderassistance|mmfinderassistant|cgi-bin)/i.test(
                  url,
                );
              if (relevant)
                weixinDiagnosticRequests.set(String(params.requestId), {
                  method: requestMethod,
                  url,
                });
              diagnostic = {
                requestId: params.requestId,
                method: requestMethod,
                url: redactWeixinDiagnostic(url, 4000),
                relevant,
                postData: /\/uploadpartdfs(?:\?|$)/.test(url)
                  ? undefined
                  : redactWeixinDiagnostic(request.postData),
              };
            }
          } else if (
            method === "Network.webSocketFrameSent" ||
            method === "Network.webSocketFrameReceived"
          ) {
            const payload = String(params.response?.payloadData || "");
            if (
              /(?:post|publish|create|finderassistant|mmfinderassistant|300002|errcode)/i.test(
                payload,
              )
            )
              diagnostic = {
                requestId: params.requestId,
                opcode: params.response?.opcode,
                payloadData: redactWeixinDiagnostic(payload),
              };
          }
          else if (
            method === "Network.responseReceived" &&
            (params.response?.status >= 400 ||
              weixinDiagnosticRequests.has(String(params.requestId)))
          ) {
            const request = weixinDiagnosticRequests.get(
              String(params.requestId),
            );
            diagnostic = {
              requestId: params.requestId,
              method: request?.method,
              url: redactWeixinDiagnostic(params.response.url, 4000),
              status: params.response.status,
              statusText: params.response.statusText,
              mimeType: params.response.mimeType,
            };
            if (request)
              void wc.debugger
                .sendCommand("Network.getResponseBody", {
                  requestId: params.requestId,
                })
                .then((result: { body?: string; base64Encoded?: boolean }) =>
                  writeBrowserLog(
                    "weixin-network-response " +
                      JSON.stringify({
                        requestId: params.requestId,
                        method: request.method,
                        url: redactWeixinDiagnostic(request.url, 4000),
                        status: params.response.status,
                        base64Encoded: result.base64Encoded,
                        body: redactWeixinDiagnostic(result.body),
                      }),
                  ),
                )
                .catch((error) =>
                  writeBrowserLog(
                    "weixin-network-response-error " +
                      JSON.stringify({
                        requestId: params.requestId,
                        url: redactWeixinDiagnostic(request.url, 4000),
                        error: String(error),
                      }),
                  ),
                );
            if (request && /\/post\/post_create(?:\?|$)/.test(request.url))
              void wc.debugger
                .sendCommand("Network.getResponseBody", {
                  requestId: params.requestId,
                })
                .then((result: { body?: string }) => {
                  const body = String(result.body || "");
                  let parsed: any;
                  try {
                    parsed = JSON.parse(body);
                  } catch {}
                  this.weixinPostCreateResults.set(wc.id, {
                    ok: Number(parsed?.errCode) === 0,
                    errCode: Number.isFinite(Number(parsed?.errCode))
                      ? Number(parsed.errCode)
                      : undefined,
                    body: redactWeixinDiagnostic(body, 4000),
                  });
                  void writeBrowserLog(
                    "weixin-post-create-result " +
                      JSON.stringify({
                        ok: Number(parsed?.errCode) === 0,
                        errCode: parsed?.errCode,
                        body: redactWeixinDiagnostic(body, 4000),
                      }),
                  );
                })
                .catch(() => undefined);
          } else if (method === "Network.loadingFinished") {
            const request = weixinDiagnosticRequests.get(String(params.requestId));
            if (request && /\/post\/post_list(?:\?|$)/.test(request.url))
              void wc.debugger
                .sendCommand("Network.getResponseBody", {
                  requestId: params.requestId,
                })
                .then((result: { body?: string }) => {
                  const titles = extractWeixinPostListTitles(
                    String(result.body || ""),
                  );
                  if (titles.length) this.weixinPostListTitles.set(wc.id, titles);
                  void writeBrowserLog(
                    "weixin-post-list-cdp-evidence " +
                      JSON.stringify({ titles: titles.slice(0, 80) }).slice(
                        0,
                        12000,
                      ),
                  );
                })
                .catch(() => undefined);
          }
          if (diagnostic !== undefined)
            void writeBrowserLog(
              "weixin-runtime " +
                method +
                " " +
                redactWeixinDiagnostic(JSON.stringify(diagnostic)),
            );
        };
        wc.debugger.on("message", weixinDiagnosticListener);
      }
      void writeBrowserLog(
        "publish-loaded account=" +
          account.id +
          " url=" +
          wc.getURL() +
          " ua=" +
          wc.getUserAgent(),
      );
      await sleep(2500);
      const initialLogin = await this.getLoginState(account, wc);
      if (!initialLogin.loggedIn) {
        await this.updateAccount(account.id, { loginStatus: "logged_out" });
        return {
          status: "manual_required" as const,
          message:
            platformMap[account.platform].name +
            "登录已失效，请在账号管理重新扫码登录",
        };
      }
      await this.flushAccountSession(account.id, "publish-login-check");
      await this.updateAccount(account.id, {
        loginStatus: "logged_in",
        ...(initialLogin.name ? { name: initialLogin.name } : {}),
      });
      if (account.platform === "xiaohongshu") {
        // 小红书发布接口请求体取证：确认"声明原创"是否随发布请求提交
        xhsNetworkListener = await this.installPublishRequestProbe(
          wc,
          "xiaohongshu",
        );
      }
      if (
        (account.platform === "weixin" || account.platform === "bilibili") &&
        process.env.MULTIPUBLISH_PUBLISH_SELF_TEST_DRAFT_ID === draft.id
      ) {
        await progress("opening", "正在检查平台后台，防止重复发布");
        const existing = await this.verifyPublishedTitle(
          wc,
          account.platform,
          draft.title,
          20000,
        );
        if (existing.ok)
          return {
            status: "success" as const,
            message:
              platformMap[account.platform].name + "后台已存在完整目标标题：" +
              draft.title + "，未重复发布",
          };
        await wc
          .loadURL(platformMap[account.platform].publishUrl)
          .catch((error) => {
            if (!/ERR_ABORTED/.test(String(error))) throw error;
          });
        await sleep(3000);
      }
      if (account.platform === "bilibili") {
        const hasStaleDraft = await wc
          .executeJavaScript(
            "/本地浏览器存在.*未提交/.test(document.body?.innerText||'')",
          )
          .catch(() => false);
        if (hasStaleDraft) {
          const discarded = await this.waitAndClickButton(
            wc,
            ["不用了", "放弃草稿", "重新投稿"],
            12000,
            false,
          );
          if (!discarded)
            throw new Error(
              "Bilibili stale draft prompt could not be dismissed",
            );
          await sleep(1800);
        }
      }
      await progress("uploading", "正在等待平台上传控件");
      let videoNodeId = 0;
      if (account.platform === "bilibili") {
        videoNodeId = await this.uploadBilibiliVideo(wc, draft.mediaPaths[0]);
      } else if (account.platform === "weixin") {
        const inputs = await this.waitForFileInputs(wc, 60000);
        const videoInput =
          inputs.find((input) => /video/i.test(input.accept)) || inputs[0];
        if (!videoInput) throw new Error("视频号上传控件不存在");
        await writeBrowserLog(
          "weixin-file-inputs " + JSON.stringify(inputs).slice(0, 10000),
        );
        // Weixin's uploader may render a transparent drop zone whose click
        // does not open a native chooser in a background window. Binding the
        // file directly to the actual input is deterministic and still
        // dispatches the platform's normal change event below.
        await this.setFileInput(wc, videoInput.nodeId, [draft.mediaPaths[0]]);
        await wc.executeJavaScript(
          "(()=>{for(const input of document.querySelectorAll('input[type=file]')){input.dispatchEvent(new Event('change',{bubbles:true}));input.dispatchEvent(new Event('input',{bubbles:true}))}return true})()",
        ).catch(() => undefined);
        videoNodeId = videoInput.nodeId;
      } else {
        // 页面是 SPA：publish-loaded 只代表 loadURL 完成，上传控件要等
        // 前端渲染完才出现（2026-10-28 实证：快手 63 秒、B站 2 秒即报
        // "找不到上传控件"，均为页面未渲染完）。这里先等控件出现。
        const inputs = await this.waitForFileInputs(wc, 60000);
        if (!inputs.length) {
          // 再给一次机会：等待页面出现任何上传相关元素（最多 30 秒）
          for (let wait = 0; wait < 30; wait += 2) {
            await sleep(2000);
            const retryInputs = await this.waitForFileInputs(wc, 1000);
            if (retryInputs.length) {
              inputs.push(...retryInputs);
              break;
            }
          }
        }
        if (!inputs.length && account.platform === "douyin") {
          await this.chooseFileFromButton(wc, "douyin", draft.mediaPaths[0]);
          videoNodeId = -1;
        } else {
          if (!inputs.length) {
            const login = await this.getLoginState(account, wc);
            if (!login.loggedIn) {
              return {
                status: "manual_required" as const,
                message: "Login required",
              };
            }
            // 上传控件始终未出现：落盘页面快照供取证
            const snapshot = await wc
              .executeJavaScript(
                "(()=>JSON.stringify({url:location.href,title:document.title,body:(document.body?.innerText||'').slice(0,3000)}))()",
              )
              .catch(() => "诊断失败");
            await writeBrowserLog(
              "upload-control-missing " +
                account.platform +
                " " +
                String(snapshot).slice(0, 3200),
            );
            return {
              status: "manual_required" as const,
              message:
                "未找到视频上传控件（页面可能未加载完或已改版，页面快照已记录到日志）",
            };
          }
          const videoInput =
            inputs.find((x) => /video/i.test(x.accept)) ||
            inputs.find((x) => !/image/i.test(x.accept)) ||
            inputs[0];
          if (!videoInput) throw new Error("Video upload control not found");
          videoNodeId = videoInput.nodeId;
          await this.setFileInput(wc, videoNodeId, [draft.mediaPaths[0]]);
        }
      }
      await progress("uploading", "\u6b63\u5728\u4e0a\u4f20\u89c6\u9891");
      const editorReady = await this.waitForEditor(
        wc,
        account.platform,
        120000,
      );
      if (!editorReady) throw new Error("视频已选择，但未进入平台编辑页面");
      if (account.platform === "bilibili") {
        const uploadDeadline = Date.now() + 240000;
        let uploadFinished = false;
        while (Date.now() < uploadDeadline) {
          const uploadState = await wc.executeJavaScript(
            "(()=>{const visible=e=>!!e&&e.offsetParent!==null;const fields=[...document.querySelectorAll('input,textarea,[contenteditable=true]')].filter(visible);const title=fields.find(e=>/标题|稿件标题|视频标题/.test(e.getAttribute('placeholder')||''));const declaration=fields.find(e=>/创建声明|创作声明|自制声明/.test(e.getAttribute('placeholder')||''));const anchors=[title,declaration,fields.find(e=>/立即投稿|投稿类型/.test(e.parentElement?.innerText||''))].filter(Boolean);const root=anchors[0]?.closest('form,[class*=upload],[class*=投稿],[class*=editor]')||anchors[0]?.parentElement;const text=(root?.innerText||anchors.map(e=>e?.parentElement?.innerText||'').join('\\n')||'').slice(0,12000);const failed=/上传失败|转码失败|无视频流信息/.test(text);const editorReady=!!title||!!declaration||/立即投稿|投稿类型|自制声明|视频封面|添加标签/.test(text);const completed=!failed&&(editorReady||/上传完成|已上传|视频预览/.test(text));const uploading=!completed&&/上传中|剩余时间|当前速度|上传进度/.test(text);const landing=/点击上传或将视频拖拽到此区域/.test((document.body?.innerText||''))&&!editorReady;return{completed,uploading,failed,landing,text}})()",
          );
          if (uploadState.failed) throw new Error("B站平台返回视频上传失败");
          // Only positive completion evidence counts. The old
          // `!uploading → completed` shortcut mistook an upload that never
          // started (or was silently dropped back to the landing page) for a
          // finished upload and marched on to a guaranteed timeout.
          if (uploadState.completed) {
            uploadFinished = true;
            break;
          }
          if (uploadState.landing) {
            // The page fell back to the video-select screen after the file
            // injection; re-drive the upload instead of timing out later.
            await writeBrowserLog("bilibili-upload-landing-retry");
            await this.uploadBilibiliVideo(wc, draft.mediaPaths[0]);
          }
          await sleep(2000);
        }
        if (!uploadFinished)
          throw new Error("B站视频上传未在等待时间内完成，请检查平台处理状态");
      }
      if (account.platform !== "douyin")
        await this.fillContent(wc, draft, account.platform);
      if (account.platform === "bilibili") {
        await wc.executeJavaScript(
          "window.scrollTo(0,document.documentElement.scrollHeight);true",
        ).catch(() => undefined);
        // The declaration control is mounted lazily after the editor settles.
        // Open its visible label first so the input exists before scanning the
        // flattened CDP document.
        await this.clickSmallestByText(wc, "含AI生成内容").catch(() => false);
        await sleep(1200);
        if (!wc.debugger.isAttached()) wc.debugger.attach("1.3");
        await wc.debugger.sendCommand("DOM.enable");
        const flat = await wc.debugger.sendCommand("DOM.getFlattenedDocument", {
          depth: -1,
          pierce: true,
        });
        const textareaCandidates = [] as Array<{
          backendNodeId: number;
          area: number;
        }>;
        for (const node of flat.nodes as Array<{
          nodeId: number;
          backendNodeId?: number;
          nodeName: string;
        }>) {
          if (node.nodeName !== "TEXTAREA") continue;
          const backendNodeId = node.backendNodeId || node.nodeId;
          try {
            const model = await wc.debugger.sendCommand("DOM.getBoxModel", {
              backendNodeId,
            });
            const quad = (model.model.border ||
              model.model.content) as number[];
            const area =
              (Math.max(quad[0], quad[2], quad[4], quad[6]) -
                Math.min(quad[0], quad[2], quad[4], quad[6])) *
              (Math.max(quad[1], quad[3], quad[5], quad[7]) -
                Math.min(quad[1], quad[3], quad[5], quad[7]));
            if (area > 100) textareaCandidates.push({ backendNodeId, area });
          } catch {}
        }
        textareaCandidates.sort((a, b) => b.area - a.area);
        const textareaNode = textareaCandidates[0];
        if (textareaNode) {
          const resolved = await wc.debugger.sendCommand("DOM.resolveNode", {
            backendNodeId: textareaNode.backendNodeId,
          });
          const objectId = resolved.object?.objectId;
          if (objectId) {
            await wc.debugger.sendCommand("Runtime.callFunctionOn", {
              objectId,
              functionDeclaration:
                'function(value){const setter=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,"value")?.set;setter?setter.call(this,value):this.value=value;this.dispatchEvent(new InputEvent("input",{bubbles:true,inputType:"insertText",data:value}));this.dispatchEvent(new Event("change",{bubbles:true}));this.dispatchEvent(new Event("blur",{bubbles:true}));return this.value}',
              arguments: [{ value: draft.description }],
              returnByValue: true,
            });
            await sleep(800);
          }
        }
        const declarationPlaceholder =
          "\u8bf7\u9009\u62e9\u7b26\u5408\u60a8\u89c6\u9891\u5185\u5bb9\u7684\u521b\u4f5c\u58f0\u660e";
        let declarationDom = await wc.debugger.sendCommand(
          "DOM.getFlattenedDocument",
          { depth: -1, pierce: true },
        );
        const declarationAll = declarationDom.nodes as Array<{
          nodeId: number;
          backendNodeId?: number;
          parentId?: number;
          nodeName: string;
          attributes?: string[];
        }>;
        const declarationMap = new Map(
          declarationAll.map((node) => [node.nodeId, node]),
        );
        let declarationInputs = [] as Array<{
          nodeId: number;
          backendNodeId: number;
          x: number;
          y: number;
          area: number;
        }>;
        const collectDeclarationInputs = async (all: typeof declarationAll) => {
        const map = new Map(all.map((node) => [node.nodeId, node]));
        const collected = [] as typeof declarationInputs;
        for (const node of all.filter(
          (node) => node.nodeName === "INPUT",
        )) {
          const attrs = node.attributes || [];
          const values = new Map<string, string>();
          for (let index = 0; index < attrs.length; index += 2)
            values.set(attrs[index], attrs[index + 1] || "");
          if (values.get("placeholder") !== declarationPlaceholder) continue;
          let hidden = false,
            current: typeof node | undefined = node;
          for (
            let depth = 0;
            current && depth < 8;
            depth++,
              current = current.parentId
                ? map.get(current.parentId)
                : undefined
          ) {
            const joined = (current.attributes || []).join(" ");
            if (/display\s*:\s*none|visibility\s*:\s*hidden/i.test(joined))
              hidden = true;
          }
          if (hidden) continue;
          try {
            const model = await wc.debugger.sendCommand("DOM.getBoxModel", {
              nodeId: node.nodeId,
            });
            const quad = (model.model.border ||
              model.model.content) as number[];
            const xs = [quad[0], quad[2], quad[4], quad[6]],
              ys = [quad[1], quad[3], quad[5], quad[7]],
              width = Math.max(...xs) - Math.min(...xs),
              height = Math.max(...ys) - Math.min(...ys);
            if (width > 10 && height > 10)
              collected.push({
                nodeId: node.nodeId,
                backendNodeId: node.backendNodeId || node.nodeId,
                x: xs.reduce((sum, value) => sum + value, 0) / 4,
                y: ys.reduce((sum, value) => sum + value, 0) / 4,
                area: width * height,
              });
          } catch {}
        }
        return collected;
        };
        declarationInputs = await collectDeclarationInputs(declarationAll);
        for (let attempt = 0; !declarationInputs.length && attempt < 12; attempt++) {
          await sleep(800);
          declarationDom = await wc.debugger.sendCommand(
            "DOM.getFlattenedDocument",
            { depth: -1, pierce: true },
          );
          declarationInputs = await collectDeclarationInputs(
            declarationDom.nodes as typeof declarationAll,
          );
        }
        declarationInputs.sort((a, b) => b.area - a.area);
        const declarationInput = declarationInputs[0];
        if (!declarationInput) {
          await writeBrowserLog(
            "bilibili declaration input not found; continuing with platform default",
          );
        } else {
        const declarationResolvedBefore = await wc.debugger.sendCommand(
          "DOM.resolveNode",
          { backendNodeId: declarationInput.backendNodeId },
        );
        if (declarationResolvedBefore.object?.objectId)
          await wc.debugger.sendCommand("Runtime.callFunctionOn", {
            objectId: declarationResolvedBefore.object.objectId,
            functionDeclaration:
              'function(){this.scrollIntoView({block:"center",inline:"nearest"});return true}',
            returnByValue: true,
          });
        await sleep(800);
        const declarationModel = await wc.debugger.sendCommand(
          "DOM.getBoxModel",
          { backendNodeId: declarationInput.backendNodeId },
        );
        const declarationQuad = (declarationModel.model.border ||
          declarationModel.model.content) as number[];
        const declarationXs = [
            declarationQuad[0],
            declarationQuad[2],
            declarationQuad[4],
            declarationQuad[6],
          ],
          declarationYs = [
            declarationQuad[1],
            declarationQuad[3],
            declarationQuad[5],
            declarationQuad[7],
          ];
        const declarationX =
            declarationXs.reduce((sum, value) => sum + value, 0) / 4,
          declarationY =
            declarationYs.reduce((sum, value) => sum + value, 0) / 4;
        await wc.debugger.sendCommand("Input.dispatchMouseEvent", {
          type: "mouseMoved",
          x: declarationX,
          y: declarationY,
        });
        await wc.debugger.sendCommand("Input.dispatchMouseEvent", {
          type: "mousePressed",
          x: declarationX,
          y: declarationY,
          button: "left",
          buttons: 1,
          clickCount: 1,
        });
        await sleep(100);
        await wc.debugger.sendCommand("Input.dispatchMouseEvent", {
          type: "mouseReleased",
          x: declarationX,
          y: declarationY,
          button: "left",
          buttons: 0,
          clickCount: 1,
        });
        await sleep(900);
        let declarationClick = await this.clickSmallestByText(
          wc,
          "\u542bAI\u751f\u6210\u5185\u5bb9",
        );
        await sleep(900);
        const declarationResolved = await wc.debugger.sendCommand(
          "DOM.resolveNode",
          { backendNodeId: declarationInput.backendNodeId },
        );
        let declarationValue = "";
        if (declarationResolved.object?.objectId) {
          const valueResult = await wc.debugger.sendCommand(
            "Runtime.callFunctionOn",
            {
              objectId: declarationResolved.object.objectId,
              functionDeclaration: 'function(){return this.value||""}',
              returnByValue: true,
            },
          );
          declarationValue = valueResult.result?.value || "";
        }
        if (!declarationValue) {
          declarationClick = await this.clickButtonByText(
            wc,
            ["含AI生成内容"],
            false,
          );
          await sleep(1000);
          const refreshed = await wc.debugger.sendCommand(
            "DOM.getFlattenedDocument",
            { depth: -1, pierce: true },
          );
          for (const node of refreshed.nodes as typeof declarationAll) {
            if (node.nodeName !== "INPUT") continue;
            const attrs = node.attributes || [];
            if (!attrs.includes(declarationPlaceholder)) continue;
            const resolved = await wc.debugger.sendCommand("DOM.resolveNode", {
              backendNodeId: node.backendNodeId || node.nodeId,
            });
            if (!resolved.object?.objectId) continue;
            const state = await wc.debugger.sendCommand("Runtime.callFunctionOn", {
              objectId: resolved.object.objectId,
              functionDeclaration: 'function(){return{value:this.value||"",visible:this.getClientRects().length>0,context:(this.parentElement?.innerText||"").slice(0,1200)}}',
              returnByValue: true,
            });
            await writeBrowserLog("bilibili-declaration-state " + JSON.stringify(state.result?.value));
            if (state.result?.value?.visible && state.result.value.value) {
              declarationValue = state.result.value.value;
              break;
            }
          }
        }
        if (!declarationClick || !declarationValue)
          await writeBrowserLog(
            "bilibili declaration selection unavailable; continuing with platform default " +
              JSON.stringify({
                declarationClick,
                declarationValue,
                declarationInput: { x: declarationX, y: declarationY },
              }),
          );
        }
        wc.sendInputEvent({ type: "mouseMove", x: 680, y: 785 });
        wc.sendInputEvent({
          type: "mouseDown",
          x: 680,
          y: 785,
          button: "left",
          clickCount: 1,
        });
        await sleep(100);
        wc.sendInputEvent({
          type: "mouseUp",
          x: 680,
          y: 785,
          button: "left",
          clickCount: 1,
        });
        await sleep(200);
        await wc.debugger.sendCommand("Input.insertText", {
          text: draft.description,
        });
        await sleep(800);
        if (draft.coverPath) {
          const coverUploaded = await this.uploadFileByActions(
            wc,
            draft.coverPath,
            "image",
            [
              "添加主封面",
              "封面设置",
              "更换封面",
              "上传封面",
              "本地上传",
              "点击上传",
            ],
            [videoNodeId],
            45000,
          );
          if (!coverUploaded)
            await writeBrowserLog(
              "bilibili cover upload unavailable; continuing with platform default",
            );
          else {
            await sleep(2200);
            await this.waitAndClickButton(
              wc,
              ["确定", "保存", "完成", "应用"],
              15000,
              true,
            );
            await sleep(1000);
          }
        }
      }
      if (account.platform === "douyin") {
        await sleep(1200);
        if (!wc.debugger.isAttached()) wc.debugger.attach("1.3");
        await wc.debugger.sendCommand("DOM.enable");
        // 发布 API 取证监听：必须在页面加载完成后挂载，且每次 CDP 调用都要
        // 有超时护栏，任何一步挂起都不能让整个发布任务永远卡住。
        douyinNetworkListener = await this.installDouyinNetworkProbe(wc);
        const douyinFlat = await wc.debugger.sendCommand(
          "DOM.getFlattenedDocument",
          { depth: -1, pierce: true },
        );
        const douyinNodes = douyinFlat.nodes as Array<{
          nodeId: number;
          backendNodeId?: number;
          nodeName: string;
          attributes?: string[];
        }>;
        const readAttrs = (node: (typeof douyinNodes)[number]) => {
          const result = new Map<string, string>(),
            attrs = node.attributes || [];
          for (let index = 0; index < attrs.length; index += 2)
            result.set(attrs[index], attrs[index + 1] || "");
          return result;
        };
        const visibleArea = async (node: (typeof douyinNodes)[number]) => {
          try {
            const backendNodeId = node.backendNodeId || node.nodeId;
            const model = await wc.debugger.sendCommand("DOM.getBoxModel", {
              backendNodeId,
            });
            const quad = (model.model.border ||
              model.model.content) as number[];
            return {
              backendNodeId,
              area:
                (Math.max(quad[0], quad[2], quad[4], quad[6]) -
                  Math.min(quad[0], quad[2], quad[4], quad[6])) *
                (Math.max(quad[1], quad[3], quad[5], quad[7]) -
                  Math.min(quad[1], quad[3], quad[5], quad[7])),
            };
          } catch {
            return undefined;
          }
        };
        const titleCandidates = [] as Array<{
          backendNodeId: number;
          area: number;
        }>;
        const editorCandidates = [] as Array<{
          backendNodeId: number;
          area: number;
        }>;
        for (const node of douyinNodes) {
          const attrs = readAttrs(node);
          const geometry = await visibleArea(node);
          if (!geometry || geometry.area < 100) continue;
          if (
            node.nodeName === "INPUT" &&
            /\u4f5c\u54c1\u6807\u9898/.test(attrs.get("placeholder") || "")
          )
            titleCandidates.push(geometry);
          if (attrs.get("contenteditable") === "true")
            editorCandidates.push(geometry);
        }
        titleCandidates.sort((a, b) => b.area - a.area);
        editorCandidates.sort((a, b) => b.area - a.area);
        const typeInto = async (backendNodeId: number, text: string) => {
          const resolved = await wc.debugger.sendCommand("DOM.resolveNode", {
            backendNodeId,
          });
          const objectId = resolved.object?.objectId;
          if (objectId)
            await wc.debugger.sendCommand("Runtime.callFunctionOn", {
              objectId,
              functionDeclaration:
                'function(){if(this instanceof HTMLInputElement||this instanceof HTMLTextAreaElement){const prototype=this instanceof HTMLInputElement?HTMLInputElement.prototype:HTMLTextAreaElement.prototype;const setter=Object.getOwnPropertyDescriptor(prototype,"value")?.set;setter?setter.call(this,""):this.value=""}else{this.innerHTML="";this.textContent=""}this.dispatchEvent(new InputEvent("input",{bubbles:true,inputType:"deleteContentBackward"}));this.dispatchEvent(new Event("change",{bubbles:true}));return true}',
              returnByValue: true,
            });
          await wc.debugger.sendCommand("DOM.focus", { backendNodeId });
          await wc.debugger.sendCommand("Input.dispatchKeyEvent", {
            type: "rawKeyDown",
            key: "a",
            code: "KeyA",
            windowsVirtualKeyCode: 65,
            modifiers: 2,
          });
          await wc.debugger.sendCommand("Input.dispatchKeyEvent", {
            type: "rawKeyDown",
            key: "Backspace",
            code: "Backspace",
            windowsVirtualKeyCode: 8,
          });
          await wc.debugger.sendCommand("Input.dispatchKeyEvent", {
            type: "keyUp",
            key: "Backspace",
            code: "Backspace",
            windowsVirtualKeyCode: 8,
          });
          await wc.debugger.sendCommand("Input.dispatchKeyEvent", {
            type: "keyUp",
            key: "a",
            code: "KeyA",
            windowsVirtualKeyCode: 65,
            modifiers: 2,
          });
          await wc.debugger.sendCommand("Input.insertText", { text });
          await wc.debugger.sendCommand("Input.dispatchKeyEvent", {
            type: "keyDown",
            key: "Tab",
            code: "Tab",
            windowsVirtualKeyCode: 9,
          });
          await wc.debugger.sendCommand("Input.dispatchKeyEvent", {
            type: "keyUp",
            key: "Tab",
            code: "Tab",
            windowsVirtualKeyCode: 9,
          });
          await sleep(700);
        };
        if (!titleCandidates[0] || !editorCandidates[0])
          throw new Error("未找到抖音真实标题或简介控件");
        const douyinExpectedTitle = Array.from(draft.title)
          .slice(0, 30)
          .join("");
        await typeInto(titleCandidates[0].backendNodeId, douyinExpectedTitle);
        await typeInto(editorCandidates[0].backendNodeId, draft.description);
        const douyinFilled = await wc.executeJavaScript(
          "(()=>{const title=[...document.querySelectorAll('input')].find(e=>/作品标题/.test(e.placeholder||''));const editor=[...document.querySelectorAll('[contenteditable=true]')].find(e=>e.offsetParent!==null);return{title:title?.value||'',description:editor?.textContent||''}})()",
        );
        if (
          douyinFilled.title !== douyinExpectedTitle ||
          !douyinFilled.description.includes(draft.description)
        )
          throw new Error(
            "抖音真实输入未生效：" +
              JSON.stringify({
                ...douyinFilled,
                expectedTitle: douyinExpectedTitle,
              }),
          );
        const size = await wc.executeJavaScript(
          "(()=>({width:innerWidth,height:innerHeight}))()",
        );
        const x = Math.round(size.width * 0.525),
          y = Math.round(size.height * 0.655);
        wc.sendInputEvent({ type: "mouseMove", x, y });
        wc.sendInputEvent({
          type: "mouseDown",
          x,
          y,
          button: "left",
          clickCount: 1,
        });
        await sleep(100);
        wc.sendInputEvent({
          type: "mouseUp",
          x,
          y,
          button: "left",
          clickCount: 1,
        });
        await sleep(2000);
      }
      if (account.platform === "toutiao") {
        await this.clickButtonByText(wc, ["我知道了", "知道了"]);
        await sleep(800);
      }
      if (account.platform === "toutiao") {
        await progress("uploading", "头条视频上传中，等待上传完成");
        const toutiaoVideoReady = await this.waitForPublishReady(
          wc,
          "toutiao",
          600000,
        );
        if (!toutiaoVideoReady) throw new Error("头条视频上传完成超时");
        // Toutiao replaces the form after video processing completes. Re-apply
        // the title after that rerender so the final publish request does not
        // restore the original over-30-character draft title.
        await this.fillContent(wc, draft, "toutiao", {
          toutiaoStrict: true,
        });
      }
      if (
        draft.coverPath &&
        (account.platform === "douyin" || account.platform === "toutiao")
      ) {
        if (account.platform === "toutiao") {
          try {
          const coverBefore = await wc
            .executeJavaScript(
              "(()=>{const visible=e=>!!e&&e.getClientRects?.().length>0&&getComputedStyle(e).visibility!=='hidden';return JSON.stringify({url:location.href,body:(document.body?.innerText||'').slice(-14000),controls:[...document.querySelectorAll('button,[role=button],a,input,textarea,[contenteditable=true],div,span,label')].filter(visible).map(e=>({tag:e.tagName,text:(e.textContent||'').trim().slice(0,240),aria:e.getAttribute('aria-label'),title:e.getAttribute('title'),placeholder:e.getAttribute('placeholder'),type:e.getAttribute('type'),disabled:!!e.disabled,cls:String(e.className||'').slice(0,180)})).filter(e=>e.text||e.aria||e.title||e.placeholder).slice(-400)})})()",
            )
            .catch(() => "");
          void writeBrowserLog("toutiao-cover-before " + coverBefore.slice(0, 18000));
          const coverModalOpened =
            (await wc
              .executeJavaScript(
                "(()=>{const visible=e=>!!e&&e.getClientRects?.().length>0&&getComputedStyle(e).visibility!=='hidden';const e=[...document.querySelectorAll('.xigua-poster-editor .fake-upload-trigger,.xigua-poster-editor [class*=upload-trigger]')].find(visible);if(!e)return false;(e.closest('button,[role=button]')||e).click();return true})()",
              )
              .catch(() => false)) ||
            (await this.clickButtonByText(
              wc,
              ["上传封面", "设置封面", "更换封面", "选择封面", "编辑封面", "视频封面"],
              false,
              false,
            ));
          if (!coverModalOpened) throw new Error("未找到头条上传封面入口");
          await sleep(1200);
          let localCoverInput = await this.waitForMatchingFileInput(
            wc,
            "image",
            2500,
            [videoNodeId],
          );
          let confirmedViaFrame = false;
          if (!localCoverInput) {
            // The editor opens on 封面截取 with a default video frame already
            // selected. Confirming that frame satisfies the required cover
            // without any file upload, so prefer it over hunting for a
            // local-upload file control the dialog may not expose.
            const frameNext = await this.clickButtonByText(
              wc,
              ["下一步"],
              true,
              true,
            );
            await writeBrowserLog(
              "toutiao-cover-frame-next " + String(frameNext),
            );
            if (frameNext) {
              confirmedViaFrame = true;
            } else {
              const localUploadOpened = await this.clickButtonByText(
                wc,
                ["本地上传", "本地上传图片", "上传图片", "从本地选择", "选择本地图片"],
                false,
                false,
              );
              if (!localUploadOpened) {
                const semanticOpened = await wc
                  .executeJavaScript(
                    "(()=>{const visible=e=>!!e&&e.getClientRects?.().length>0&&getComputedStyle(e).visibility!=='hidden';const all=root=>{const r=[];for(const e of root.querySelectorAll('*')){r.push(e);if(e.shadowRoot)r.push(...all(e.shadowRoot))}return r};const nodes=all(document).filter(visible);const target=nodes.filter(e=>{const s=((e.textContent||'')+' '+(e.getAttribute('aria-label')||'')+' '+(e.getAttribute('title')||'')).trim();return /本地|图片|上传|选择/.test(s)&&e.children.length<8}).sort((a,b)=>{const ar=a.getBoundingClientRect(),br=b.getBoundingClientRect();return ar.width*ar.height-br.width*br.height})[0];if(!target)return false;target.click();return true})()",
                  )
                  .catch(() => false);
                if (!semanticOpened)
                  throw new Error("未找到头条本地上传封面页签");
              }
              localCoverInput = await this.waitForMatchingFileInput(
                wc,
                "image",
                15000,
                [videoNodeId],
              );
            }
          }
          if (confirmedViaFrame) {
            await sleep(1000);
          } else {
            if (localCoverInput)
              await this.setFileInput(wc, localCoverInput.nodeId, [
                draft.coverPath,
              ]);
            else
              await this.chooseFileFromButton(
                wc,
                ["本地上传", "本地上传图片", "点击上传", "上传图片", "从本地选择"],
                draft.coverPath,
              );
            await sleep(1800);
            await this.clickButtonByText(wc, ["下一步"], true, true);
            await sleep(1000);
          }
          let editorConfirmed = await this.clickButtonByText(
            wc,
            ["裁剪完成", "完成", "确定", "保存"],
            true,
            true,
          );
          if (!editorConfirmed && confirmedViaFrame) {
            await sleep(1200);
            editorConfirmed = await this.clickButtonByText(
              wc,
              ["完成", "确定", "保存", "裁剪完成"],
              true,
              true,
            );
          }
          if (!editorConfirmed) throw new Error("未找到头条封面编辑确认按钮");
          await sleep(1000);
          const finalConfirmVisible = await wc
            .executeJavaScript(
              "/完成后无法继续编辑/.test(document.body?.innerText||'')",
            )
            .catch(() => false);
          if (finalConfirmVisible) {
            const finalConfirmed = await this.clickButtonByText(
              wc,
              ["确定"],
              false,
              true,
            );
            if (!finalConfirmed) throw new Error("未找到头条封面二次确认按钮");
          }
          const coverDeadline = Date.now() + 30000;
          let coverReady = false;
          while (Date.now() < coverDeadline) {
            await sleep(1000);
            const confirmStillVisible = await wc
              .executeJavaScript(
                "/完成后无法继续编辑/.test(document.body?.innerText||'')",
              )
              .catch(() => false);
            if (confirmStillVisible)
              await this.clickButtonByText(wc, ["确定"], false, true);
            coverReady = await wc
              .executeJavaScript(
                "(()=>{const visible=e=>!!e&&e.offsetParent!==null;const pageText=document.body?.innerText||'';if(/封面编辑|完成后无法继续编辑/.test(pageText))return false;const labels=[...document.querySelectorAll('div,span,label')].filter(e=>visible(e)&&(e.textContent||'').trim()==='封面');for(const label of labels){let root=label.parentElement;for(let depth=0;root&&depth<7;depth++,root=root.parentElement){const text=(root.textContent||'').trim();if(!/清晰美观的封面|上传封面/.test(text))continue;const visual=[...root.querySelectorAll('img,canvas')].some(visible)||[...root.querySelectorAll('*')].some(e=>visible(e)&&getComputedStyle(e).backgroundImage!=='none');if(visual||/重新上传封面|更换封面/.test(text))return true}}return false})()",
              )
              .catch(() => false);
            if (coverReady) break;
          }
          if (!coverReady) {
            const coverDiagnostics = await wc
              .executeJavaScript(
                "(()=>JSON.stringify({buttons:[...document.querySelectorAll('button,[role=button]')].filter(e=>e.offsetParent!==null).map(e=>(e.textContent||'').trim()).filter(Boolean).slice(-50),dialogs:[...document.querySelectorAll('[role=dialog],[class*=modal],[class*=dialog]')].filter(e=>e.offsetParent!==null).map(e=>(e.textContent||'').trim()).filter(Boolean).slice(-20),body:(document.body?.innerText||'').slice(-5000)}))()",
              )
              .catch(() => "");
            void writeBrowserLog(
              "toutiao-cover-not-ready " +
                (coverDiagnostics ? coverDiagnostics.slice(0, 6000) : ""),
            );
          }
          } catch (error) {
            // Toutiao marks the cover as required: submitting without one is
            // silently rejected by the platform, so a failed cover flow must
            // fail the task with the real reason instead of skipping ahead.
            const coverFailureState = await wc
              .executeJavaScript(
                "(()=>{const visible=e=>!!e&&e.getClientRects?.().length>0&&getComputedStyle(e).visibility!=='hidden';const nodes=[...document.querySelectorAll('button,[role=button],a,input,textarea,[contenteditable=true],div,span,label')].filter(visible);return JSON.stringify({url:location.href,body:(document.body?.innerText||'').slice(-12000),controls:nodes.map(e=>({tag:e.tagName,text:(e.textContent||'').trim().slice(0,300),aria:e.getAttribute('aria-label'),title:e.getAttribute('title'),placeholder:e.getAttribute('placeholder'),type:e.getAttribute('type'),disabled:!!e.disabled,cls:String(e.className||'').slice(0,200)})).filter(e=>e.text||e.aria||e.title||e.placeholder).slice(-300)})})()",
              )
              .catch(() => "");
            void writeBrowserLog(
              "toutiao-cover-skipped " +
                String(error).slice(0, 4000) +
                " state=" +
                coverFailureState.slice(0, 16000),
            );
            throw error instanceof Error
              ? error
              : new Error(String(error));
          }
        } else {
          const nearbyCover =
            account.platform === "douyin"
              ? await this.findFileInputNearText(wc, "\u9009\u62e9\u5c01\u9762")
              : undefined;
          const refreshed = await this.getFileInputs(wc);
          const coverInput =
            nearbyCover ||
            refreshed.find(
              (x) => /image/i.test(x.accept) && x.nodeId !== videoNodeId,
            );
          if (coverInput)
            await this.setFileInput(wc, coverInput.nodeId, [draft.coverPath]);
          else {
            const uploaded = await this.uploadFileByActions(
              wc,
              draft.coverPath,
              "image",
              ["选择封面", "上传封面", "本地上传", "点击上传"],
              [videoNodeId],
              30000,
            );
            if (!uploaded)
              throw new Error(
                account.platform === "douyin"
                  ? "未找到抖音封面上传控件"
                  : "未找到封面上传控件",
              );
          }
          if (account.platform === "douyin") {
            await sleep(4000);
            const x = 841,
              y = 585;
            wc.sendInputEvent({ type: "mouseMove", x, y });
            wc.sendInputEvent({
              type: "mouseDown",
              x,
              y,
              button: "left",
              clickCount: 1,
            });
            await sleep(120);
            wc.sendInputEvent({
              type: "mouseUp",
              x,
              y,
              button: "left",
              clickCount: 1,
            });
            await sleep(2500);
          }
        }
      }
      await progress("uploading", "视频上传中，等待平台处理");
      const publishTimeout = publishUploadTimeout(account.platform);
      let ready = false;
      if (account.platform === "weixin") {
        for (let attempt = 1; attempt <= 3 && !ready; attempt++) {
          try {
            ready = await this.waitForPublishReady(
              wc,
              account.platform,
              publishTimeout,
            );
          } catch (error) {
            if (
              attempt >= 3 ||
              !/视频号视频分片上传连接失败/.test(String(error))
            )
              throw error;
            await progress(
              "uploading",
              `视频号上传连接失败，正在自动重试（${attempt}/2）`,
            );
            this.weixinUploadFailures.delete(wc.id);
            this.weixinRemoteUploadAt.delete(wc.id);
            const retryInputs = await this.waitForFileInputs(wc, 20000);
            const retryInput =
              retryInputs.find((input) => /video/i.test(input.accept)) ||
              retryInputs[0];
            if (!retryInput) throw new Error("视频号重试时未找到上传控件");
            await this.setFileInput(wc, retryInput.nodeId, [videoPath]);
            await sleep(1500);
          }
        }
      } else {
        ready =
          account.platform === "xiaohongshu"
            ? await this.waitForXhsPublishReady(wc, publishTimeout)
            : account.platform === "bilibili"
              ? await this.waitForBilibiliPublishReady(wc, publishTimeout)
              : await this.waitForPublishReady(
                  wc,
                  account.platform,
                  publishTimeout,
                );
      }
      if (!ready) {
        const douyinDiagnostics =
          account.platform === "douyin"
            ? await wc
                .executeJavaScript(
                  "(()=>JSON.stringify({url:location.href,fields:[...document.querySelectorAll('input,textarea,[contenteditable=true]')].map(e=>{const r=e.getBoundingClientRect();return{tag:e.tagName,type:e.type||'',placeholder:e.getAttribute('placeholder')||'',contenteditable:e.getAttribute('contenteditable'),value:typeof e.value==='string'?e.value:(e.textContent||''),visible:!!e.offsetParent,rect:{x:r.x,y:r.y,width:r.width,height:r.height},html:(e.outerHTML||'').slice(0,800)}}),buttons:[...document.querySelectorAll('button,[role=button]')].map(e=>({text:(e.textContent||'').trim(),disabled:!!e.disabled,ariaDisabled:e.getAttribute('aria-disabled'),visible:!!e.offsetParent})).filter(e=>e.visible).slice(-80),body:(document.body?.innerText||'').slice(0,12000)}))()",
                )
                .catch((error) => "诊断失败：" + String(error))
            : "";
        // 小红书/其他平台失败时同样落盘页面快照：没有证据就无法区分
        // "视频没处理完"还是"平台改版/校验弹窗"
        const genericDiagnostics =
          account.platform === "douyin"
            ? ""
            : await wc
                .executeJavaScript(
                  "(()=>JSON.stringify({url:location.href,buttons:[...document.querySelectorAll('button,[role=button]')].map(e=>({text:(e.textContent||'').trim().slice(0,30),disabled:!!e.disabled,visible:!!e.offsetParent})).filter(e=>e.visible).slice(-40),alerts:[...document.querySelectorAll('[role=alert],[class*=error],[class*=toast],[class*=message]')].filter(e=>e.offsetParent!==null).map(e=>(e.textContent||'').trim().slice(0,120)).filter(Boolean).slice(-10),body:(document.body?.innerText||'').slice(0,6000)}))()",
                )
                .catch((error) => "诊断失败：" + String(error));
        if (genericDiagnostics)
          await writeBrowserLog(
            "publish-not-ready " +
              account.platform +
              " " +
              String(genericDiagnostics).slice(0, 6500),
          );
        throw new Error(
          account.platform === "xiaohongshu"
            ? "小红书真实发布按钮持续禁用，请检查视频处理、标题、正文、封面或平台校验提示（页面快照已记录到日志）"
            : "等待视频上传完成超时" +
                (douyinDiagnostics
                  ? "；抖音控件诊断：" + douyinDiagnostics
                  : ""),
        );
      }
      if (
        account.platform === "bilibili" ||
        account.platform === "kuaishou" ||
        account.platform === "douyin"
      ) {
        await wc.executeJavaScript(
          "window.scrollTo(0,document.documentElement.scrollHeight);true",
        );
        await sleep(1200);
      }
      // 声明类选项的勾选结果直接写进任务消息：用户能在界面上看到
      // "原创已勾选"还是"未找到控件"，不再需要靠猜。
      const declarationNotes: string[] = [];
      if (
        draft.declareOriginal &&
        ["douyin", "xiaohongshu", "weixin"].includes(account.platform)
      ) {
        if (account.platform === "douyin") {
          // 实测（2026-10-26 多轮多 frame 扫描）：抖音网页版创作者中心
          // 发布页没有任何"声明原创"开关——抖音的原创标识由平台根据内容
          // 自动判定打标，不提供网页端手动声明入口
          declarationNotes.push(
            "抖音网页版发布页无声明原创开关（原创标识由平台自动判定，可在抖音App作品页查看）",
          );
        } else {
          const result = await this.ensureCheckboxByText(
            wc,
            [/声明原创/, /原创声明/, /原创/],
            "declare-original " + account.platform,
          );
          if (result.ok && result.checked)
            declarationNotes.push("已勾选声明原创");
          else if (result.ok)
            declarationNotes.push("声明原创开关已处于勾选状态");
          else
            declarationNotes.push(
              "未找到声明原创控件（账号可能无原创声明权益）",
            );
          if (account.platform === "xiaohongshu") {
            // 原创声明的权威生效方式：发布请求体注入。2026-10-28 取证：
            // 手动勾选原创的发布请求 common.business_binds 内含
            // optionRelationList=[{type:"ORIGINAL_STATEMENT",...}]，而自动
            // 勾选即使开关 DOM 已 checked，React 受控状态也不进 payload。
            // 因此拦截 v2/note 请求改写 business_binds（同视频号标题补丁
            // 模式），不依赖任何 UI 控件。bizId 取自用户手动发布的真实请求。
            const originalPatch =
              "((flag)=>{try{if(window.__multipublishOriginalPatch)return 'already';" +
              "const patchBody=(flag)=>(body)=>{if(!flag||typeof body!=='string')return body;" +
              "try{const data=JSON.parse(body);const binds=data&&data.common&&data.common.business_binds;" +
              "if(typeof binds!=='string')return body;const parsed=JSON.parse(binds);" +
              "if(!Array.isArray(parsed.optionRelationList))parsed.optionRelationList=[];" +
              "if(!parsed.optionRelationList.some(o=>o&&o.type==='ORIGINAL_STATEMENT')){" +
              "parsed.optionRelationList.push({type:'ORIGINAL_STATEMENT',relationList:[{bizType:'ORIGINAL_STATEMENT',bizId:'62b2da320000000019022923',extraInfo:'{}'}]})}" +
              "data.common.business_binds=JSON.stringify(parsed);return JSON.stringify(data)}catch{return body}};" +
              "const patch=patchBody(flag);" +
              "const fetch0=window.fetch;window.fetch=(input,init)=>{const url=typeof input==='string'?input:input&&input.url||'';" +
              "if(/web_api\\/sns\\/v2\\/note(\\?|$)/.test(url)&&init&&typeof init.body==='string')init={...init,body:patch(init.body)};" +
              "return fetch0.call(window,input,init)};" +
              "const open0=XMLHttpRequest.prototype.open;XMLHttpRequest.prototype.open=function(method,url){this.__mpUrl=String(url);return open0.apply(this,arguments)};" +
              "const send0=XMLHttpRequest.prototype.send;XMLHttpRequest.prototype.send=function(body){if(/web_api\\/sns\\/v2\\/note(\\?|$)/.test(this.__mpUrl||''))body=patch(body);return send0.call(this,body)};" +
              "window.__multipublishOriginalPatch=true;return 'installed'}catch(error){return String(error)}})(true)";
            const frames = [wc.mainFrame, ...wc.mainFrame.framesInSubtree];
            const patchResults = await Promise.all(
              frames.map((frame) =>
                frame
                  .executeJavaScript(originalPatch)
                  .catch((error) => String(error)),
              ),
            );
            await writeBrowserLog(
              "xhs-original-patch frames=" +
                frames.length +
                " " +
                JSON.stringify(patchResults),
            );
            declarationNotes.push("已注入原创声明到发布请求");
          }
        }
      }
      if (
        account.platform === "douyin" &&
        draft.douyinSyncTargets &&
        draft.douyinSyncTargets.length
      ) {
        const syncPatterns: Record<DouyinSyncTarget, RegExp> = {
          // 抖音同步发布的平台名在不同版本有变体："今日头条/头条号"、
          // "番茄小说/番茄"、"懂车帝"，因此用宽松匹配
          toutiao: /头条/,
          fanqie: /番茄/,
          dongchedi: /懂车帝/,
        };
        const syncNames: Record<DouyinSyncTarget, string> = {
          toutiao: "头条",
          fanqie: "番茄",
          dongchedi: "懂车帝",
        };
        for (const target of draft.douyinSyncTargets) {
          const result = await this.ensureCheckboxByText(
            wc,
            [syncPatterns[target]],
            "douyin-sync " + target,
          );
          declarationNotes.push(
            result.ok && result.checked
              ? `已勾选同步到${syncNames[target]}`
              : result.ok
                ? `同步到${syncNames[target]}已处于勾选状态`
                : `未找到同步到${syncNames[target]}的控件`,
          );
        }
      }
      if (account.platform === "weixin") {
        // Install the request patch before the trusted mouse event. The page
        // builds post_create asynchronously after the click, so installing it
        // afterwards races the platform and can leave the editor unchanged.
        const titlePatch =
          "((fullTitle)=>{try{if(window.__multipublishPostPatch)return true;const shortTitle=Array.from(fullTitle).slice(0,12).join('');const patchBody=body=>{if(typeof body!=='string')return body;try{const data=JSON.parse(body);if(data?.objectDesc){data.objectDesc.mpTitle=shortTitle;data.objectDesc.shortTitle=[{shortTitle}];}return JSON.stringify(data)}catch{return body}};const fetch0=window.fetch;window.fetch=(input,init)=>{const url=typeof input==='string'?input:input?.url||'';if(/post\\/post_create/.test(url)&&init?.body)init={...init,body:patchBody(init.body)};return fetch0.call(window,input,init)};const open0=XMLHttpRequest.prototype.open;XMLHttpRequest.prototype.open=function(method,url){this.__multipublishUrl=String(url);return open0.apply(this,arguments)};const send0=XMLHttpRequest.prototype.send;XMLHttpRequest.prototype.send=function(body){if(/post\\/post_create/.test(this.__multipublishUrl||''))body=patchBody(body);return send0.call(this,body)};window.__multipublishPostPatch=true;return true}catch(error){return String(error)}})(" +
          JSON.stringify(draft.title) +
          ")";
        const frames = [wc.mainFrame, ...wc.mainFrame.framesInSubtree];
        await Promise.all(
          frames.map((frame) => frame.executeJavaScript(titlePatch).catch(() => undefined)),
        );
        await writeBrowserLog(
          "weixin-post-request-patch frames=" + String(frames.length),
        );
      }
      await progress("publishing", "正在提交发布");
      let clicked = false,
        clickDiagnostics = "";
      if (account.platform === "xiaohongshu") {
        if (!wc.debugger.isAttached()) wc.debugger.attach("1.3");
        await wc.debugger.sendCommand("DOM.enable");
        const flattened = await wc.debugger.sendCommand(
          "DOM.getFlattenedDocument",
          { depth: -1, pierce: true },
        );
        const nodes = flattened.nodes as Array<{
          nodeId: number;
          parentId?: number;
          nodeName: string;
          nodeValue?: string;
          attributes?: string[];
          backendNodeId?: number;
        }>;
        const byId = new Map(nodes.map((node) => [node.nodeId, node]));
        const buttonIds = new Set<number>();
        for (const textNode of nodes.filter(
          (node) =>
            node.nodeName === "#text" &&
            (node.nodeValue || "").trim() === "发布",
        )) {
          let current: typeof textNode | undefined = textNode;
          while (current && current.nodeName !== "BUTTON" && current.parentId)
            current = byId.get(current.parentId);
          if (current?.nodeName === "BUTTON") buttonIds.add(current.nodeId);
        }
        const buttonPoints: Array<{
          nodeId: number;
          x: number;
          y: number;
          width: number;
          height: number;
        }> = [];
        for (const nodeId of buttonIds) {
          try {
            const model = await wc.debugger.sendCommand("DOM.getBoxModel", {
              nodeId,
            });
            const quad = (model.model.border ||
              model.model.content) as number[];
            const xs = [quad[0], quad[2], quad[4], quad[6]],
              ys = [quad[1], quad[3], quad[5], quad[7]];
            buttonPoints.push({
              nodeId,
              x: xs.reduce((sum, value) => sum + value, 0) / 4,
              y: ys.reduce((sum, value) => sum + value, 0) / 4,
              width: Math.max(...xs) - Math.min(...xs),
              height: Math.max(...ys) - Math.min(...ys),
            });
          } catch {}
        }
        buttonPoints.sort((a, b) => b.y - a.y || b.x - a.x);
        const chosenButton = buttonPoints.find(
          (candidate) => candidate.width > 40 && candidate.height > 20,
        );
        let point: { x: number; y: number } | undefined = chosenButton;
        if (!point)
          point = await wc.executeJavaScript(
            "(()=>{const target=document.querySelector('xhs-publish-btn');if(!target)return null;const rect=target.getBoundingClientRect();return{x:Math.round(rect.left+rect.width*0.61),y:Math.round(rect.top+rect.height/2)}})()",
          );
        clickDiagnostics = JSON.stringify({
          buttonPoints,
          chosenPoint: point,
          activation: chosenButton ? "focus-enter" : "mouse-fallback",
        });
        if (chosenButton) {
          const resolved = await wc.debugger.sendCommand("DOM.resolveNode", {
            nodeId: chosenButton.nodeId,
          });
          const objectId = resolved.object?.objectId;
          if (!objectId) throw new Error("无法解析小红书发布按钮对象");
          const invoked = await wc.debugger.sendCommand(
            "Runtime.callFunctionOn",
            {
              objectId,
              functionDeclaration:
                'function(){const before={disabled:!!this.disabled,ariaDisabled:this.getAttribute?.(\"aria-disabled\"),outerHTML:(this.outerHTML||\"\").slice(0,500)};this.click();return before}',
              returnByValue: true,
              awaitPromise: true,
            },
          );
          clickDiagnostics = JSON.stringify({
            buttonPoints,
            chosenPoint: point,
            activation: "runtime-click",
            button: invoked.result?.value,
          });
          clicked = true;
        } else if (
          point &&
          Number.isFinite(point.x) &&
          Number.isFinite(point.y)
        ) {
          await wc.debugger.sendCommand("Input.dispatchMouseEvent", {
            type: "mouseMoved",
            x: point.x,
            y: point.y,
          });
          await wc.debugger.sendCommand("Input.dispatchMouseEvent", {
            type: "mousePressed",
            x: point.x,
            y: point.y,
            button: "left",
            buttons: 1,
            clickCount: 1,
          });
          await sleep(120);
          await wc.debugger.sendCommand("Input.dispatchMouseEvent", {
            type: "mouseReleased",
            x: point.x,
            y: point.y,
            button: "left",
            buttons: 0,
            clickCount: 1,
          });
          clicked = true;
        }
      } else if (account.platform === "douyin") {
        clicked = await wc.executeJavaScript(
          "(()=>{const buttons=[...document.querySelectorAll('button')].filter(button=>(button.textContent||'').trim()==='发布'&&!button.disabled&&button.getAttribute('aria-disabled')!=='true');const target=buttons.at(-1);if(!target)return false;target.scrollIntoView({block:'center'});target.focus();target.click();return true})()",
        );
        clickDiagnostics = await wc
          .executeJavaScript(
            "(()=>JSON.stringify({url:location.href,publishButtons:[...document.querySelectorAll('button')].filter(button=>(button.textContent||'').trim()==='发布').map(button=>({disabled:!!button.disabled,ariaDisabled:button.getAttribute('aria-disabled'),visible:!!button.offsetParent,html:(button.outerHTML||'').slice(0,800)}))}))()",
          )
          .catch((error) => String(error));
        // 点击现场落盘：跳转成功与否、按钮状态、平台拦截提示都要可追溯。
        await writeBrowserLog(
          "douyin-publish-click " +
            JSON.stringify({ clicked, url: wc.getURL() }) +
            (clickDiagnostics ? " " + clickDiagnostics.slice(0, 6000) : ""),
        );
        await sleep(4000);
        const douyinToasts = await wc
          .executeJavaScript(
            "(()=>{const visible=e=>!!e&&e.getClientRects?.().length>0;return [...document.querySelectorAll('div,span,p')].filter(visible).map(e=>(e.textContent||'').trim()).filter(t=>t&&t.length<80&&/失败|错误|审核|违规|频繁|请先|不能|稍后/.test(t)).slice(-12)})()",
          )
          .catch(() => []);
        await writeBrowserLog(
          "douyin-post-click-toasts " + JSON.stringify(douyinToasts),
        );
      } else if (account.platform === "bilibili") {
        await sleep(15000);
        clickDiagnostics = await wc
          .executeJavaScript(
            "(()=>JSON.stringify({url:location.href,textareas:[...document.querySelectorAll('textarea')].map(e=>({visible:!!e.offsetParent,value:e.value,placeholder:e.placeholder})),buttons:[...document.querySelectorAll('button')].filter(e=>e.offsetParent!==null).map(e=>({text:(e.textContent||'').trim(),disabled:!!e.disabled,className:String(e.className)})).slice(-40),body:(document.body?.innerText||'').slice(0,16000)}))()",
          )
          .catch((error) => String(error));
        clicked = await this.clickButtonByText(
          wc,
          ["\u7acb\u5373\u6295\u7a3f"],
          true,
        );
        if (clicked) {
          await sleep(1200);
          await this.clickButtonByText(
            wc,
            [
              "\u786e\u5b9a",
              "\u786e\u8ba4\u6295\u7a3f",
              "\u7ee7\u7eed\u6295\u7a3f",
            ],
            true,
          );
        }
      } else {
        clicked = await this.clickButtonByText(
          wc,
          [
            "发布",
            "立即发布",
            "确认发布",
            "投稿",
            "立即投稿",
            "提交发布",
            "发表",
          ],
          true,
          account.platform === "weixin",
        );
      }
      if (!clicked) throw new Error("没有找到可用的发布按钮");
      if (account.platform === "weixin") {
        // A stale coordinate can hit the editor after a late layout shift. If
        // no submit request or navigation appears, reacquire the live button
        // and issue one trusted retry instead of declaring success.
        await sleep(6000);
        if (!this.weixinPostCreateRequested.has(wc.id) && /platform\/post\/create/.test(wc.getURL())) {
          await writeBrowserLog("weixin-publish-retry reason=no-post-create");
          await this.clickButtonByText(
            wc,
            ["发布", "发表"],
            true,
            true,
          );
        }
      }
      if (account.platform === "toutiao") {
        await sleep(5000);
        const current = await wc.getURL();
        if (/xigua\/upload-video/.test(current)) {
          const retry = await this.clickButtonByText(
            wc,
            ["发布"],
            true,
            false,
          );
          await writeBrowserLog("toutiao-publish-retry " + String(retry));
          // Surface the platform validation toast (e.g. 请上传封面) so a
          // blocked submit is diagnosable instead of a silent timeout.
          await sleep(1500);
          const toasts = await wc
            .executeJavaScript(
              "(()=>{const visible=e=>!!e&&e.getClientRects?.().length>0&&getComputedStyle(e).visibility!=='hidden';return [...document.querySelectorAll('div,span,p')].filter(visible).map(e=>(e.textContent||'').trim()).filter(t=>t&&t.length<80&&/请|必须|不能|失败|错误|再试/.test(t)).slice(-12)})()",
            )
            .catch(() => []);
          await writeBrowserLog(
            "toutiao-post-click-toasts " + JSON.stringify(toasts),
          );
        }
      }
      if (
        account.platform === "kuaishou" ||
        account.platform === "xiaohongshu"
      ) {
        for (let attempt = 0; attempt < 8; attempt++) {
          await sleep(750);
          const confirmed = await this.clickButtonByText(
            wc,
            ["确认发布", "确认", "继续发布"],
            true,
          );
          if (confirmed) break;
        }
      }
      const result = await this.waitForResult(
        wc,
        account.platform,
        account.platform === "xiaohongshu"
          ? 15000
          : account.platform === "bilibili"
            ? 30000
            : account.platform === "douyin"
              ? 600000
              : account.platform === "toutiao"
                ? 120000
                : 120000,
      );
      if (result.challenge)
        return { status: "manual_required" as const, message: result.message };
      if (!result.success && result.message)
        return { status: "failed" as const, message: result.message };
      const verified = await this.verifyPublishedTitle(
        wc,
        account.platform,
        draft.title,
        180000,
      );
      const declarationSuffix = declarationNotes.length
        ? "；" + declarationNotes.join("、")
        : "";
      if (verified.ok)
        return {
          status: "success" as const,
          message:
            platformMap[account.platform].name +
            "作品管理已找到目标标题，发布成功：" +
            verified.url +
            declarationSuffix,
        };
      if (result.success) {
        const evidence = await this.captureFailure(wc, account.platform).catch(
          () => undefined,
        );
        return {
          status: "failed" as const,
          message:
            (verified.reason || "平台后台未找到目标作品") +
            declarationSuffix +
            (evidence ? "；现场截图：" + evidence : ""),
        };
      }
      if (clicked) {
        // The submit click was issued but the platform gave neither a success
        // URL nor a success banner inside the wait window (e.g. Toutiao
        // redirects to its manage page tens of seconds after the click).
        // Settle the outcome by checking the creator backend for the target
        // title instead of bouncing the task straight to manual_required.
        const lateVerified = await this.verifyPublishedTitle(
          wc,
          account.platform,
          draft.title,
          180000,
        );
        if (lateVerified.ok)
          return {
            status: "success" as const,
            message:
              platformMap[account.platform].name +
              "作品管理已找到目标标题，发布成功：" +
              lateVerified.url +
              declarationSuffix,
          };
      }
      const diagnostics =
        account.platform === "xiaohongshu"
          ? await wc
              .executeJavaScript(
                "(()=>JSON.stringify({viewport:{width:innerWidth,height:innerHeight},customButtons:[...document.querySelectorAll('xhs-publish-btn')].map(e=>{const r=e.getBoundingClientRect();return{rect:{left:r.left,top:r.top,width:r.width,height:r.height},attributes:[...e.attributes].map(a=>[a.name,a.value]),shadowText:e.shadowRoot?.textContent||'',shadowHtml:(e.shadowRoot?.innerHTML||'').slice(0,1200)}}),publishElements:[...document.querySelectorAll('button,[role=button],div,span')].filter(e=>(e.textContent||'').trim()==='发布').map(e=>{const r=e.getBoundingClientRect(),style=getComputedStyle(e);return{tag:e.tagName,className:String(e.className),disabled:!!e.disabled,ariaDisabled:e.getAttribute('aria-disabled'),pointerEvents:style.pointerEvents,visible:!!e.offsetParent,rect:{left:r.left,top:r.top,width:r.width,height:r.height},parent:e.parentElement?{tag:e.parentElement.tagName,className:String(e.parentElement.className)}:null}}),bottomHit:[...document.elementsFromPoint(innerWidth*.535,innerHeight-46)].slice(0,8).map(e=>({tag:e.tagName,className:String(e.className),text:(e.textContent||'').trim().slice(0,80)})),alerts:[...document.querySelectorAll('[role=alert],.error,.error-message,.ant-message,.toast')].filter(e=>e.offsetParent!==null).map(e=>(e.textContent||'').trim()).filter(Boolean)}))()",
              )
              .catch((error) => "诊断失败：" + String(error))
          : "";
      const genericDiagnostics = await wc
        .executeJavaScript(
          "(()=>JSON.stringify({alerts:[...document.querySelectorAll('[role=alert],.error,.error-message,[class*=error],[class*=tip],[class*=message]')].filter(e=>e.offsetParent!==null).map(e=>(e.textContent||'').trim()).filter(Boolean).slice(-30),body:(document.body?.innerText||'').slice(-4000)}))()",
        )
        .catch(() => "");
      const unconfirmedEvidence = await this.captureFailure(
        wc,
        account.platform,
      ).catch(() => undefined);
      return {
        status: "manual_required" as const,
        message:
          "已点击发布但平台未确认结果；当前页面：" +
          wc.getURL() +
          (clickDiagnostics ? "；点击诊断：" + clickDiagnostics : "") +
          (diagnostics ? "；页面诊断：" + diagnostics : "") +
          (unconfirmedEvidence ? "；现场截图：" + unconfirmedEvidence : ""),
      };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      const evidence = await this.captureFailure(wc, account.platform).catch(
        () => undefined,
      );
      return {
        status: "failed" as const,
        message: reason + (evidence ? "；现场截图：" + evidence : ""),
      };
    } finally {
      this.weixinRemoteUploadAt.delete(wc.id);
      this.weixinUploadFailures.delete(wc.id);
      this.weixinPublishPoints.delete(wc.id);
      this.weixinPostCreateResults.delete(wc.id);
      this.weixinPostCreateRequested.delete(wc.id);
      this.weixinPostListTitles.delete(wc.id);
      if (weixinDiagnosticListener)
        wc.debugger.removeListener("message", weixinDiagnosticListener);
      if (douyinNetworkListener) {
        wc.debugger.removeListener("message", douyinNetworkListener);
        await wc.debugger
          .sendCommand("Network.disable")
          .catch(() => undefined);
      }
      if (xhsNetworkListener)
        wc.debugger.removeListener("message", xhsNetworkListener);
      this.automationWindows.delete(account.id);
      await this.flushAccountSession(account.id, "publish-finished");
      if (!automationWindow.isDestroyed()) automationWindow.destroy();
    }
  }
  private async waitForXhsPublishReady(
    wc: Electron.WebContents,
    timeout: number,
  ) {
    if (!wc.debugger.isAttached()) wc.debugger.attach("1.3");
    await wc.debugger.sendCommand("Page.enable");
    await wc.debugger.sendCommand("DOM.enable");
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeout) {
      const flattened = await wc.debugger.sendCommand(
        "DOM.getFlattenedDocument",
        { depth: -1, pierce: true },
      );
      const nodes = flattened.nodes as Array<{
        nodeId: number;
        parentId?: number;
        nodeName: string;
        nodeValue?: string;
        attributes?: string[];
        backendNodeId?: number;
      }>;
      const byId = new Map(nodes.map((node) => [node.nodeId, node]));
      for (const textNode of nodes.filter(
        (node) =>
          node.nodeName === "#text" && (node.nodeValue || "").trim() === "发布",
      )) {
        let current: typeof textNode | undefined = textNode;
        while (current && current.nodeName !== "BUTTON" && current.parentId)
          current = byId.get(current.parentId);
        if (current?.nodeName === "BUTTON") {
          const attributes = current.attributes || [];
          const attributeMap = new Map<string, string>();
          for (let index = 0; index < attributes.length; index += 2)
            attributeMap.set(attributes[index], attributes[index + 1] || "");
          if (
            !attributeMap.has("disabled") &&
            attributeMap.get("aria-disabled") !== "true"
          )
            return true;
        }
      }
      await sleep(2000);
    }
    return false;
  }
  private async captureFailure(
    wc: Electron.WebContents,
    platform: Account["platform"],
  ) {
    const dir = path.join(app.getPath("userData"), "task-artifacts");
    await fs.mkdir(dir, { recursive: true });
    const file = path.join(dir, platform + "-" + Date.now() + ".png");
    await fs.writeFile(
      file,
      await wc.capturePage().then((image) => image.toPNG()),
    );
    return file;
  }
  private async waitForEditor(
    wc: Electron.WebContents,
    platform: Account["platform"],
    timeout: number,
  ) {
    const start = Date.now();
    let lastWeixinFrameDiagnosticAt = 0;
    while (Date.now() - start < timeout) {
      const url = wc.getURL();
      if (
        platform === "douyin" &&
        /creator-micro\/content\/(publish|post\/video)/.test(url)
      ) {
        const ready = await wc.executeJavaScript(
          "(()=>{const visible=e=>!!e&&e.offsetParent!==null;const title=[...document.querySelectorAll('input')].find(e=>visible(e)&&/标题|作品名称/.test(e.placeholder||''));const editor=[...document.querySelectorAll('[contenteditable=true]')].find(visible);return!!title&&!!editor})()",
        );
        if (ready) return true;
      }
      if (platform === "xiaohongshu") {
        const ready = await wc.executeJavaScript(
          "!!document.querySelector('input[placeholder*=标题],input[placeholder*=填写标题],input.upload-input')",
        );
        if (ready) return true;
      }
      if (platform === "kuaishou") {
        const ready = await wc.executeJavaScript(
          "(()=>{const text=document.body?.innerText||'';return /描述|封面设置|发布设置/.test(text)&&!!document.querySelector('[contenteditable=true],textarea,input')})()",
        );
        if (ready) return true;
      }
      if (platform === "toutiao") {
        const ready = await wc.executeJavaScript(
          "(()=>{const text=document.body?.innerText||'';const fields=[...document.querySelectorAll('input,textarea')].filter(e=>e.offsetParent!==null);const cover=/封面|上传封面/.test(text);const settings=/发布设置|发布视频/.test(text);return fields.length>0&&(settings||cover)})()",
        );
        if (ready) return true;
      }
      if (platform === "weixin") {
        const uploadFailure = this.weixinUploadFailures.get(wc.id);
        if (uploadFailure) throw new Error(uploadFailure);
        const ready = await wc.executeJavaScript(
          "(()=>{const visible=e=>!!e&&e.offsetParent!==null;const all=root=>{const result=[];for(const e of root.querySelectorAll('*')){result.push(e);if(e.shadowRoot)result.push(...all(e.shadowRoot))}return result};const nodes=all(document);const fields=nodes.filter(e=>visible(e)&&(e.matches?.('input,textarea,[contenteditable=true]')||e.getAttribute?.('contenteditable')==='true'));const text=(document.body?.innerText||'')+' '+nodes.map(e=>(e.textContent||'').trim()).join(' ');const login=/扫码登录|手机号登录|验证码登录|APP扫一扫登录/.test(text);const editor=/视频描述|作品描述|发表视频|声明原创|原创声明|封面|发布设置|添加话题/.test(text);const uploadError=/上传失败|上传出错|视频格式不支持|文件损坏/.test(text);return{ok:/channels\\.weixin\\.qq\\.com\\/platform/.test(location.href)&&!login&&!uploadError&&fields.length>0&&editor,url:location.href,fields:fields.length,editor,uploadError,login,text:text.slice(-1800)}})()",
        );
        void writeBrowserLog(
          "weixin-editor-check url=" +
            wc.getURL() +
            " result=" +
            JSON.stringify(ready).slice(0, 2500),
        );
        if (ready?.ok) return true;
        if (Date.now() - lastWeixinFrameDiagnosticAt >= 10000) {
          lastWeixinFrameDiagnosticAt = Date.now();
          const frameDiagnostics = await Promise.all(
            wc.mainFrame.framesInSubtree.map(async (frame) => {
              const state = await Promise.race([
                frame
                  .executeJavaScript(
                    "(()=>{const summary=e=>({tag:e.tagName,text:(e.textContent||'').trim().slice(0,300),type:e.type||'',placeholder:e.getAttribute?.('placeholder')||'',className:String(e.className||'').slice(0,200),display:getComputedStyle(e).display,visibility:getComputedStyle(e).visibility,rect:(()=>{const r=e.getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:r.height}})()});return{url:location.href,title:document.title,visibilityState:document.visibilityState,body:(document.body?.innerText||'').slice(-5000),fields:[...document.querySelectorAll('input,textarea,[contenteditable=true]')].map(summary),buttons:[...document.querySelectorAll('button,[role=button]')].map(summary),videos:[...document.querySelectorAll('video')].map(e=>({...summary(e),src:e.currentSrc||e.src,readyState:e.readyState,duration:e.duration,paused:e.paused}))}})()",
                  )
                  .catch((error) => ({ error: String(error) })),
                new Promise<{ error: string }>((resolve) =>
                  setTimeout(() => resolve({ error: "frame timeout" }), 2000),
                ),
              ]);
              return {
                frameUrl: frame.url,
                frameName: frame.name,
                state,
              };
            }),
          );
          await writeBrowserLog(
            "weixin-frame-diagnostics " +
              JSON.stringify(frameDiagnostics).slice(0, 30000),
          );
        }
      }
      if (platform === "bilibili") {
        const ready = await wc.executeJavaScript(
          "(()=>{const visible=e=>!!e&&e.getClientRects?.().length>0&&getComputedStyle(e).visibility!=='hidden';const all=root=>{const result=[];for(const e of root.querySelectorAll('*')){result.push(e);if(e.shadowRoot)result.push(...all(e.shadowRoot))}return result};const nodes=all(document);const url=/member\\.bilibili\\.com\\/platform\\/upload\\/video(?:\\/|$)/.test(location.href);const fields=nodes.filter(e=>visible(e)&&(e.matches?.('input,textarea,[contenteditable=true]')||e.getAttribute?.('contenteditable')==='true'));const title=fields.some(e=>/标题|稿件标题|视频标题/.test(e.getAttribute?.('placeholder')||''));const declaration=fields.some(e=>/创建声明|创作声明|自制声明/.test(e.getAttribute?.('placeholder')||''));const text=((document.body?.innerText||'')+' '+nodes.map(e=>(e.textContent||'').trim()).join(' ')).slice(-16000);const editor=title||declaration||/立即投稿|立即投稿|投稿类型|自制声明|添加标签|视频封面/.test(text);const uploadDone=/上传完成|视频已上传|转码完成|视频预览/.test(text)||nodes.some(e=>visible(e)&&e.tagName==='VIDEO');return{ok:url&&editor,uploadDone,fields:fields.length,url,text:text.slice(-1800)}})()",
        );
        if (ready?.ok || (ready?.uploadDone && ready?.fields > 0)) return true;
      }
      if (
        !["douyin", "xiaohongshu", "kuaishou", "weixin", "bilibili"].includes(
          platform,
        )
      ) {
        const ready = await wc.executeJavaScript(
          "!!document.querySelector('textarea,[contenteditable=true],input[placeholder*=标题]')",
        );
        if (ready) return true;
      }
      await sleep(1500);
    }
    return false;
  }
  private async findFileInputNearText(wc: Electron.WebContents, text: string) {
    if (!wc.debugger.isAttached()) wc.debugger.attach("1.3");
    await wc.debugger.sendCommand("DOM.enable");
    const flattened = await wc.debugger.sendCommand(
      "DOM.getFlattenedDocument",
      { depth: -1, pierce: true },
    );
    const nodes = flattened.nodes as Array<{
      nodeId: number;
      backendNodeId?: number;
      parentId?: number;
      nodeName: string;
      nodeValue?: string;
      attributes?: string[];
    }>;
    const byId = new Map(nodes.map((node) => [node.nodeId, node]));
    const children = new Map<number, typeof nodes>();
    for (const node of nodes) {
      if (!node.parentId) continue;
      const list = children.get(node.parentId) || [];
      list.push(node);
      children.set(node.parentId, list);
    }
    const readInput = (node: (typeof nodes)[number]) => {
      if (node.nodeName !== "INPUT") return undefined;
      const attrs = node.attributes || [];
      const values = new Map<string, string>();
      for (let index = 0; index < attrs.length; index += 2)
        values.set(attrs[index], attrs[index + 1] || "");
      const type = (values.get("type") || "").toLowerCase(),
        accept = values.get("accept") || "";
      return type === "file" || accept
        ? { nodeId: node.backendNodeId || node.nodeId, accept }
        : undefined;
    };
    const descendantInputs = (root: number) => {
      const queue = (children.get(root) || []).map((node) => ({
        node,
        depth: 1,
      }));
      const found: Array<{
        input: { nodeId: number; accept: string };
        depth: number;
      }> = [];
      while (queue.length) {
        const current = queue.shift()!;
        const input = readInput(current.node);
        if (input) found.push({ input, depth: current.depth });
        for (const child of children.get(current.node.nodeId) || [])
          queue.push({ node: child, depth: current.depth + 1 });
      }
      return found;
    };
    const wantsImage = /封面|图片/.test(text),
      wantsVideo = /视频/.test(text) && !wantsImage;
    const candidates = new Map<
      number,
      {
        input: { nodeId: number; accept: string };
        score: number;
        y: number;
        area: number;
      }
    >();
    for (const textNode of nodes.filter(
      (node) =>
        node.nodeName === "#text" && (node.nodeValue || "").trim() === text,
    )) {
      let textY = -1,
        textArea = Number.MAX_SAFE_INTEGER;
      try {
        const parentId = textNode.parentId || textNode.nodeId;
        const model = await wc.debugger.sendCommand("DOM.getBoxModel", {
          nodeId: parentId,
        });
        const quad = (model.model.border || model.model.content) as number[];
        const xs = [quad[0], quad[2], quad[4], quad[6]],
          ys = [quad[1], quad[3], quad[5], quad[7]];
        textY = ys.reduce((sum, value) => sum + value, 0) / 4;
        textArea =
          (Math.max(...xs) - Math.min(...xs)) *
          (Math.max(...ys) - Math.min(...ys));
      } catch {
        continue;
      }
      let current = textNode.parentId ? byId.get(textNode.parentId) : undefined;
      for (
        let ancestorDepth = 0;
        current && ancestorDepth < 12;
        ancestorDepth++,
          current = current.parentId ? byId.get(current.parentId) : undefined
      ) {
        for (const found of descendantInputs(current.nodeId)) {
          const accept = found.input.accept;
          const typePenalty = wantsImage
            ? /image/i.test(accept)
              ? 0
              : 10000
            : wantsVideo
              ? /video/i.test(accept)
                ? 0
                : /image/i.test(accept)
                  ? 10000
                  : 50
              : 0;
          const score = ancestorDepth * 100 + found.depth + typePenalty;
          const previous = candidates.get(found.input.nodeId);
          if (!previous || score < previous.score)
            candidates.set(found.input.nodeId, {
              input: found.input,
              score,
              y: textY,
              area: textArea,
            });
        }
      }
    }
    return [...candidates.values()].sort(
      (a, b) => a.score - b.score || b.y - a.y || a.area - b.area,
    )[0]?.input;
  }
  private async clickSmallestByText(wc: Electron.WebContents, text: string) {
    if (!wc.debugger.isAttached()) wc.debugger.attach("1.3");
    await wc.debugger.sendCommand("DOM.enable");
    const flattened = await wc.debugger.sendCommand(
      "DOM.getFlattenedDocument",
      { depth: -1, pierce: true },
    );
    const nodes = flattened.nodes as Array<{
      nodeId: number;
      parentId?: number;
      nodeName: string;
      nodeValue?: string;
      attributes?: string[];
    }>;
    const byId = new Map(nodes.map((node) => [node.nodeId, node]));
    const candidates: Array<{
      x: number;
      y: number;
      area: number;
      rank: number;
    }> = [];
    for (const textNode of nodes.filter(
      (node) =>
        node.nodeName === "#text" && (node.nodeValue || "").trim() === text,
    )) {
      let current: typeof textNode | undefined = textNode.parentId
        ? byId.get(textNode.parentId)
        : undefined;
      let hidden = false;
      let visibilityNode = current;
      for (
        let depth = 0;
        visibilityNode && depth < 8;
        depth++,
          visibilityNode = visibilityNode.parentId
            ? byId.get(visibilityNode.parentId)
            : undefined
      ) {
        const attrs = (visibilityNode.attributes || []).join(" ");
        if (/display\s*:\s*none|visibility\s*:\s*hidden/i.test(attrs))
          hidden = true;
      }
      for (
        let depth = 0;
        current && !hidden && depth < 6;
        depth++,
          current = current.parentId ? byId.get(current.parentId) : undefined
      ) {
        try {
          const model = await wc.debugger.sendCommand("DOM.getBoxModel", {
            nodeId: current.nodeId,
          });
          const quad = (model.model.border || model.model.content) as number[];
          const xs = [quad[0], quad[2], quad[4], quad[6]],
            ys = [quad[1], quad[3], quad[5], quad[7]],
            width = Math.max(...xs) - Math.min(...xs),
            height = Math.max(...ys) - Math.min(...ys),
            area = width * height,
            attrs = (current.attributes || []).join(" ");
          if (width > 3 && height > 3)
            candidates.push({
              x: xs.reduce((sum, value) => sum + value, 0) / 4,
              y: ys.reduce((sum, value) => sum + value, 0) / 4,
              area,
              rank:
                current.nodeName === "LI" && /bcc-option/i.test(attrs)
                  ? 0
                  : current.nodeName === "ARTICLE"
                    ? 1
                    : 2,
            });
        } catch {}
      }
    }
    candidates.sort((a, b) => a.rank - b.rank || a.area - b.area);
    const target = candidates[0];
    if (!target) return false;
    const x = target.x,
      y = target.y;
    await wc.debugger.sendCommand("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x,
      y,
    });
    await wc.debugger.sendCommand("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x,
      y,
      button: "left",
      buttons: 1,
      clickCount: 1,
    });
    await sleep(120);
    await wc.debugger.sendCommand("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x,
      y,
      button: "left",
      buttons: 0,
      clickCount: 1,
    });
    return true;
  }
  private async clickButtonByText(
    wc: Electron.WebContents,
    texts: string[],
    preferBottom = true,
    trustedOnly = false,
  ) {
    if (!wc.debugger.isAttached()) wc.debugger.attach("1.3");
    const weixinPoint = this.weixinPublishPoints.get(wc.id);
    if (
      trustedOnly &&
      texts.some((text) => /发布|发表/.test(text))
    ) {
      // 视频号编辑器由 Wujie 挂载在子 frame 中。主文档坐标有时只命中
      // 宿主包装层，因此先在每个实际 frame 内触发对应按钮。
      const frameClicks = await Promise.all(
        [wc.mainFrame, ...wc.mainFrame.framesInSubtree].map((frame) =>
          frame
            .executeJavaScript(
              "((texts,preferBottom)=>{const visible=e=>!!e&&e.getClientRects?.().length>0&&getComputedStyle(e).visibility!=='hidden';const all=root=>{const result=[];for(const e of root.querySelectorAll('*')){result.push(e);if(e.shadowRoot)result.push(...all(e.shadowRoot))}return result};const c=all(document).filter(e=>e.matches?.('button,[role=button]')&&visible(e)&&texts.includes((e.textContent||'').trim())&&!e.disabled&&e.getAttribute('aria-disabled')!=='true'&&!String(e.className||'').includes('disabled'));c.sort((a,b)=>(preferBottom?b.getBoundingClientRect().bottom-a.getBoundingClientRect().bottom:a.getBoundingClientRect().bottom-b.getBoundingClientRect().bottom));const e=c[0];if(!e)return{clicked:false};e.scrollIntoView({block:'center'});e.focus?.();e.click();return{clicked:true,text:(e.textContent||'').trim(),url:location.href}})(" +
                JSON.stringify(texts) +
                "," +
                JSON.stringify(preferBottom) +
                ")",
            )
            .then((value) => ({ frame: frame.url, value }))
            .catch(() => ({ frame: frame.url, value: { clicked: false } })),
        ),
      );
      const clickedInFrame = frameClicks.filter(
        (item) => (item.value as { clicked?: boolean } | undefined)?.clicked,
      );
      if (clickedInFrame.length) {
        await writeBrowserLog(
          "weixin-publish-dom-click " +
            JSON.stringify(clickedInFrame).slice(0, 12000),
        );
        await sleep(1200);
        if (this.weixinPostCreateRequested.has(wc.id)) return true;
      }
      // Re-read the button immediately before dispatching the trusted event.
      // The editor can reflow after upload processing, making the point saved
      // by waitForPublishReady stale even though the button is still enabled.
      const livePoint = await wc
        .executeJavaScript(
          "((texts,preferBottom)=>{const visible=e=>!!e&&e.getClientRects?.().length>0&&getComputedStyle(e).visibility!=='hidden';const all=root=>{const result=[];for(const e of root.querySelectorAll('*')){result.push(e);if(e.shadowRoot)result.push(...all(e.shadowRoot))}return result};const candidates=all(document).filter(e=>e.matches?.('button,[role=button]')&&visible(e)&&texts.includes((e.textContent||'').trim())&&!e.disabled&&e.getAttribute('aria-disabled')!=='true'&&!String(e.className||'').includes('disabled')).map(e=>{const r=e.getBoundingClientRect();return{x:r.left+r.width/2,y:r.top+r.height/2,area:r.width*r.height,bottom:r.bottom}}).sort((a,b)=>(preferBottom?b.bottom-a.bottom:a.bottom-b.bottom)||a.area-b.area);return candidates[0]||null})(" +
            JSON.stringify(texts) +
            "," +
            JSON.stringify(preferBottom) +
            ")",
        )
        .catch(() => null);
      const point = livePoint || weixinPoint;
      if (!point) return false;
      this.weixinPublishPoints.set(wc.id, { x: point.x, y: point.y });
      await wc.debugger.sendCommand("Input.dispatchMouseEvent", {
        type: "mouseMoved",
        x: point.x,
        y: point.y,
      });
      await wc.debugger.sendCommand("Input.dispatchMouseEvent", {
        type: "mousePressed",
        x: point.x,
        y: point.y,
        button: "left",
        buttons: 1,
        clickCount: 1,
      });
      await sleep(120);
      await wc.debugger.sendCommand("Input.dispatchMouseEvent", {
        type: "mouseReleased",
        x: point.x,
        y: point.y,
        button: "left",
        buttons: 0,
        clickCount: 1,
      });
      await writeBrowserLog(
        "weixin-publish-click " + JSON.stringify(point),
      );
      return true;
    }
    const script =
      "((texts,preferBottom)=>{const visible=e=>!!e&&e.getClientRects().length>0&&getComputedStyle(e).visibility!=='hidden';const all=root=>{const result=[];for(const e of root.querySelectorAll('*')){result.push(e);if(e.shadowRoot)result.push(...all(e.shadowRoot))}return result};const candidates=all(document).filter(e=>e.matches?.('button,[role=button],a,div,span')&&visible(e)&&texts.includes((e.textContent||'').trim())&&!e.disabled&&e.getAttribute('aria-disabled')!=='true'&&!String(e.className||'').includes('disabled'));candidates.sort((a,b)=>{const ar=a.getBoundingClientRect(),br=b.getBoundingClientRect();return(preferBottom?br.top-ar.top:ar.top-br.top)||((ar.width*ar.height)-(br.width*br.height))});const target=candidates[0];if(!target)return false;target.scrollIntoView({block:'center',inline:'center'});target.focus?.();target.click();return true})(" +
      JSON.stringify(texts) +
      "," +
      JSON.stringify(preferBottom) +
      ")";
    const clicked = trustedOnly
      ? false
      : await wc.executeJavaScript(script).catch(() => false);
    if (clicked) return true;
    await wc.debugger.sendCommand("DOM.enable");
    const flattened = await wc.debugger.sendCommand(
      "DOM.getFlattenedDocument",
      { depth: -1, pierce: true },
    );
    const nodes = flattened.nodes as Array<{
      nodeId: number;
      parentId?: number;
      nodeName: string;
      nodeValue?: string;
    }>;
    const byId = new Map(nodes.map((node) => [node.nodeId, node]));
    const candidates: Array<{ x: number; y: number; area: number }> = [];
    for (const textNode of nodes.filter(
      (node) =>
        node.nodeName === "#text" &&
        texts.includes((node.nodeValue || "").trim()),
    )) {
      let current = textNode.parentId ? byId.get(textNode.parentId) : undefined;
      for (
        let depth = 0;
        current && depth < 6;
        depth++,
          current = current.parentId ? byId.get(current.parentId) : undefined
      ) {
        try {
          const model = await wc.debugger.sendCommand("DOM.getBoxModel", {
            nodeId: current.nodeId,
          });
          const quad = (model.model.border || model.model.content) as number[];
          const xs = [quad[0], quad[2], quad[4], quad[6]],
            ys = [quad[1], quad[3], quad[5], quad[7]],
            width = Math.max(...xs) - Math.min(...xs),
            height = Math.max(...ys) - Math.min(...ys);
          if (width > 3 && height > 3 && width < 700 && height < 180)
            candidates.push({
              x: xs.reduce((sum, value) => sum + value, 0) / 4,
              y: ys.reduce((sum, value) => sum + value, 0) / 4,
              area: width * height,
            });
        } catch {}
      }
    }
    candidates.sort((a, b) =>
      preferBottom
        ? b.y - a.y || a.area - b.area
        : a.y - b.y || a.area - b.area,
    );
    const target = candidates[0];
    if (!target) return false;
    await wc.debugger.sendCommand("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: target.x,
      y: target.y,
    });
    await wc.debugger.sendCommand("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x: target.x,
      y: target.y,
      button: "left",
      buttons: 1,
      clickCount: 1,
    });
    await sleep(120);
    await wc.debugger.sendCommand("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x: target.x,
      y: target.y,
      button: "left",
      buttons: 0,
      clickCount: 1,
    });
    return true;
  }
  private async chooseFileFromButton(
    wc: Electron.WebContents,
    selector: string | string[],
    file: string,
  ) {
    if (!wc.debugger.isAttached()) wc.debugger.attach("1.3");
    const labels = Array.isArray(selector)
      ? selector
      : selector === "toutiao-cover"
        ? ["本地上传", "上传图片", "点击上传", "上传封面"]
        : selector === "douyin"
          ? ["上传视频", "点击上传", "选择视频", "上传"]
          : ["上传视频", "点击上传", "选择文件"];
    const imageMode =
      (Array.isArray(selector) &&
        selector.some((value) => /封面|图片/.test(value))) ||
      selector === "toutiao-cover";
    const before = (await this.getFileInputs(wc).catch(() => [])).map(
      (input) => input.nodeId,
    );
    let chooserNodeId: number | undefined;
    const listener = (_event: Electron.Event, method: string, params: any) => {
      if (method === "Page.fileChooserOpened")
        chooserNodeId = params.backendNodeId;
    };
    wc.debugger.on("message", listener);
    await wc.debugger.sendCommand("Page.setInterceptFileChooserDialog", {
      enabled: true,
    });
    try {
      const clicked = await this.clickButtonByText(wc, labels, true, true);
      if (!clicked) throw new Error(labels.join("/") + "上传按钮不存在");
      const start = Date.now();
      while (Date.now() - start < 30000) {
        if (chooserNodeId) {
          await wc.debugger.sendCommand("DOM.setFileInputFiles", {
            backendNodeId: chooserNodeId,
            files: [file],
          });
          return;
        }
        const inputs = await this.getFileInputs(wc).catch(() => []);
        const candidates = inputs.filter((input) =>
          imageMode
            ? /image/i.test(input.accept)
            : /video/i.test(input.accept) || !/image/i.test(input.accept),
        );
        const fresh = candidates.filter(
          (input) => !before.includes(input.nodeId),
        );
        const target = fresh.at(-1) || candidates.at(-1);
        if (target && Date.now() - start > 800) {
          await this.setFileInput(wc, target.nodeId, [file]);
          return;
        }
        await sleep(400);
      }
      throw new Error(labels.join("/") + "未产生可用文件控件");
    } finally {
      wc.debugger.removeListener("message", listener);
      await wc.debugger
        .sendCommand("Page.setInterceptFileChooserDialog", { enabled: false })
        .catch(() => undefined);
    }
  }
  private async chooseFileFromInput(
    wc: Electron.WebContents,
    backendNodeId: number,
    file: string,
  ) {
    if (!wc.debugger.isAttached()) wc.debugger.attach("1.3");
    await wc.debugger.sendCommand("Page.enable");
    await wc.debugger.sendCommand("DOM.enable");
    const flattened = await wc.debugger.sendCommand(
      "DOM.getFlattenedDocument",
      { depth: -1, pierce: true },
    );
    const nodes = flattened.nodes as Array<{
      nodeId: number;
      backendNodeId?: number;
      parentId?: number;
      nodeName: string;
    }>;
    const byId = new Map(nodes.map((node) => [node.nodeId, node]));
    let current = nodes.find(
      (node) => (node.backendNodeId || node.nodeId) === backendNodeId,
    );
    const points: Array<{
      nodeId: number;
      x: number;
      y: number;
      width: number;
      height: number;
      depth: number;
    }> = [];
    for (let depth = 0; current && depth < 10; depth++) {
      try {
        const model = await wc.debugger.sendCommand("DOM.getBoxModel", {
          nodeId: current.nodeId,
        });
        const quad = (model.model.border || model.model.content) as number[];
        const xs = [quad[0], quad[2], quad[4], quad[6]],
          ys = [quad[1], quad[3], quad[5], quad[7]],
          width = Math.max(...xs) - Math.min(...xs),
          height = Math.max(...ys) - Math.min(...ys);
        if (width > 20 && height > 20 && width < 1200 && height < 800)
          points.push({
            nodeId: current.nodeId,
            x: xs.reduce((sum, value) => sum + value, 0) / 4,
            y: ys.reduce((sum, value) => sum + value, 0) / 4,
            width,
            height,
            depth,
          });
      } catch {}
      current = current.parentId ? byId.get(current.parentId) : undefined;
    }
    points.sort(
      (a, b) => a.depth - b.depth || a.width * a.height - b.width * b.height,
    );
    const target = points[0];
    if (!target) throw new Error("无法定位视频号上传控件的可点击区域");
    const inputNode = nodes.find(
      (node) => (node.backendNodeId || node.nodeId) === backendNodeId,
    );
    const ancestry: Array<Record<string, unknown>> = [];
    current = inputNode;
    for (let depth = 0; current && depth < 10; depth++) {
      const outerHTML = await wc.debugger
        .sendCommand("DOM.getOuterHTML", { nodeId: current.nodeId })
        .then((result) => String(result.outerHTML || "").slice(0, 4000))
        .catch(() => "");
      const objectId = await wc.debugger
        .sendCommand("DOM.resolveNode", { nodeId: current.nodeId })
        .then((result) => result.object?.objectId as string | undefined)
        .catch(() => undefined);
      const listeners = objectId
        ? await wc.debugger
            .sendCommand("DOMDebugger.getEventListeners", { objectId })
            .then((result) =>
              (result.listeners || []).map((listener: any) => ({
                type: listener.type,
                useCapture: listener.useCapture,
                passive: listener.passive,
                scriptId: listener.scriptId,
                lineNumber: listener.lineNumber,
              })),
            )
            .catch(() => [])
        : [];
      ancestry.push({
        depth,
        nodeId: current.nodeId,
        nodeName: current.nodeName,
        outerHTML,
        listeners,
      });
      current = current.parentId ? byId.get(current.parentId) : undefined;
    }
    let chooserNodeId: number | undefined;
    let chooserOpened = false;
    const listener = (_event: Electron.Event, method: string, params: any) => {
      if (method !== "Page.fileChooserOpened") return;
      chooserOpened = true;
      chooserNodeId = params.backendNodeId || backendNodeId;
      void writeBrowserLog(
        "weixin-file-chooser-opened " + JSON.stringify(params),
      );
    };
    wc.debugger.on("message", listener);
    await wc.debugger.sendCommand("Page.setInterceptFileChooserDialog", {
      enabled: true,
    });
    try {
      await writeBrowserLog(
        "weixin-upload-click " +
          JSON.stringify({ backendNodeId, target, points, ancestry }).slice(
            0,
            30000,
          ),
      );
      await wc.debugger.sendCommand("Input.dispatchMouseEvent", {
        type: "mouseMoved",
        x: target.x,
        y: target.y,
      });
      await wc.debugger.sendCommand("Input.dispatchMouseEvent", {
        type: "mousePressed",
        x: target.x,
        y: target.y,
        button: "left",
        buttons: 1,
        clickCount: 1,
      });
      await sleep(120);
      await wc.debugger.sendCommand("Input.dispatchMouseEvent", {
        type: "mouseReleased",
        x: target.x,
        y: target.y,
        button: "left",
        buttons: 0,
        clickCount: 1,
      });
      const startedAt = Date.now();
      while (!chooserOpened && Date.now() - startedAt < 10000) await sleep(100);
      if (!chooserOpened)
        throw new Error("点击视频号上传区域后未打开文件选择器");
      await wc.debugger.sendCommand("DOM.setFileInputFiles", {
        backendNodeId: chooserNodeId || backendNodeId,
        files: [file],
      });
    } finally {
      wc.debugger.removeListener("message", listener);
      await wc.debugger
        .sendCommand("Page.setInterceptFileChooserDialog", { enabled: false })
        .catch(() => undefined);
    }
  }
  private async waitForBilibiliVideoInput(
    wc: Electron.WebContents,
    timeout: number,
  ) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      try {
        if (!wc.debugger.isAttached()) wc.debugger.attach("1.3");
        await wc.debugger.sendCommand("DOM.enable");
        const flattened = await wc.debugger.sendCommand(
          "DOM.getFlattenedDocument",
          { depth: -1, pierce: true },
        );
        const nodes = flattened.nodes as Array<{
          nodeId: number;
          backendNodeId?: number;
          parentId?: number;
          nodeName: string;
          attributes?: string[];
        }>;
        const byId = new Map(nodes.map((node) => [node.nodeId, node]));
        const candidates: Array<{
          nodeId: number;
          score: number;
          order: number;
        }> = [];
        for (const [order, node] of nodes.entries()) {
          if (node.nodeName !== "INPUT") continue;
          const attrs = node.attributes || [];
          const values = new Map<string, string>();
          for (let index = 0; index < attrs.length; index += 2)
            values.set(attrs[index], attrs[index + 1] || "");
          if ((values.get("type") || "").toLowerCase() !== "file") continue;
          const accept = values.get("accept") || "";
          if (/image/i.test(accept) && !/video/i.test(accept)) continue;
          let score = /video/i.test(accept) ? 0 : 100;
          let current: typeof node | undefined = node;
          for (
            let depth = 0;
            current && depth < 10;
            depth++,
              current = current.parentId
                ? byId.get(current.parentId)
                : undefined
          ) {
            const context = (current.attributes || []).join(" ");
            if (/display\s*:\s*none|visibility\s*:\s*hidden/i.test(context))
              score += 500;
            if (/draft|history|old|stale|草稿|历史|旧稿|已上传/i.test(context))
              score += 10000;
            if (/upload|video|drag|上传|视频|拖拽/i.test(context)) score -= 100;
          }
          candidates.push({
            nodeId: node.backendNodeId || node.nodeId,
            score,
            order,
          });
        }
        candidates.sort((a, b) => a.score - b.score || a.order - b.order);
        if (candidates[0]) return candidates[0];
      } catch {}
      await sleep(500);
    }
    return undefined;
  }
  // After DOM.setFileInputFiles the platform may silently drop the upload and
  // fall back to the video-select landing page. Confirm the upload really
  // started (progress text, editor form, or a rendered video) before trusting
  // the file injection.
  private async waitForBilibiliUploadStart(
    wc: Electron.WebContents,
    timeout: number,
  ) {
    const start = Date.now();
    let evidence = "";
    while (Date.now() - start < timeout) {
      const state = await wc
        .executeJavaScript(
          "(()=>{const text=document.body?.innerText||'';const visible=e=>!!e&&e.offsetParent!==null;return{uploading:/上传中|正在上传|剩余时间|上传速度|上传进度|正在转码|转码中|上传完成|秒传|上传成功|视频预览/.test(text),editor:/稿件标题|立即投稿|投稿类型|添加标签/.test(text)||[...document.querySelectorAll('input,textarea')].some(e=>visible(e)&&/标题|稿件标题|视频标题/.test(e.placeholder||'')),video:[...document.querySelectorAll('video')].some(visible),landing:/点击上传或将视频拖拽到此区域/.test(text)}})()",
        )
        .catch(() => ({
          uploading: false,
          editor: false,
          video: false,
          landing: true,
        }));
      evidence = JSON.stringify(state).slice(0, 2000);
      if (state.uploading || state.editor || state.video)
        return { started: true, evidence };
      await sleep(1500);
    }
    return { started: false, evidence };
  }
  private async uploadBilibiliVideo(wc: Electron.WebContents, file: string) {
    if (!wc.debugger.isAttached()) wc.debugger.attach("1.3");
    await wc.debugger.sendCommand("Page.enable").catch(() => undefined);
    let chooserNodeId: number | undefined;
    const listener = (_event: Electron.Event, method: string, params: any) => {
      if (method === "Page.fileChooserOpened" && params?.backendNodeId)
        chooserNodeId = params.backendNodeId;
    };
    wc.debugger.on("message", listener);
    await wc.debugger.sendCommand("Page.setInterceptFileChooserDialog", {
      enabled: true,
    });
    try {
      // B站上传页是 SPA：publish-loaded 后前端还要渲染几秒。先等上传
      // 元素出现（最多 25 秒），否则 3 次重试会在 2 秒内全部落空
      // （2026-10-28 实证：publish-loaded 后 2 秒即报 upload button not found）
      for (let wait = 0; wait < 25; wait += 2) {
        const appeared = await wc
          .executeJavaScript(
            "(()=>{const visible=e=>!!e&&e.getClientRects?.().length>0;return [...document.querySelectorAll('*')].some(e=>visible(e)&&/上传视频|点击上传|选择视频|拖拽|上传文件/.test((e.textContent||'').trim())&&(e.textContent||'').trim().length<20)})()",
          )
          .catch(() => false);
        if (appeared) break;
        await sleep(2000);
      }
      for (let attempt = 1; attempt <= 3; attempt++) {
        chooserNodeId = undefined;
        const clicked = await this.clickButtonByText(
          wc,
          ["上传视频", "点击上传视频", "选择视频", "点击上传", "上传文件", "选择文件"],
          false,
          true,
        );
        let fallbackClicked = false;
        if (!clicked) {
          fallbackClicked = await wc
            .executeJavaScript(
              "(()=>{const visible=e=>!!e&&e.getClientRects?.().length>0&&getComputedStyle(e).visibility!=='hidden';const all=root=>{const r=[];for(const e of root.querySelectorAll('*')){r.push(e);if(e.shadowRoot)r.push(...all(e.shadowRoot))}return r};const nodes=all(document).filter(visible);const target=nodes.filter(e=>/上传|选择|拖拽/.test((e.textContent||'')+' '+(e.getAttribute('aria-label')||'')+' '+(e.getAttribute('title')||''))&&/视频|文件|video|upload/i.test((e.textContent||'')+' '+(e.getAttribute('aria-label')||'')+' '+(e.getAttribute('title')||'')+' '+String(e.className||''))).sort((a,b)=>{const ar=a.getBoundingClientRect(),br=b.getBoundingClientRect();return ar.width*ar.height-br.width*br.height})[0];if(!target)return false;target.click();return true})()",
            )
            .catch(() => false);
          if (!fallbackClicked)
            throw new Error("Bilibili current upload button not found");
        }
        let inputNodeId = 0;
        const chooserStart = Date.now();
        while (Date.now() - chooserStart < 15000) {
          if (chooserNodeId) {
            inputNodeId = chooserNodeId;
            break;
          }
          await sleep(200);
        }
        if (!inputNodeId) {
          const currentInput = await this.waitForBilibiliVideoInput(wc, 10000);
          if (currentInput) inputNodeId = currentInput.nodeId;
        }
        if (!inputNodeId)
          throw new Error("Bilibili current video upload control not found");
        await this.setFileInput(wc, inputNodeId, [file]);
        const uploadStart = await this.waitForBilibiliUploadStart(wc, 25000);
        await writeBrowserLog(
          "bilibili-upload-attempt " +
            JSON.stringify({
              attempt,
              clicked,
              fallbackClicked,
              usedChooser: chooserNodeId !== undefined,
              ...uploadStart,
            }).slice(0, 4000),
        );
        if (uploadStart.started) return inputNodeId;
      }
      throw new Error("B站视频上传未开始（已重试 3 次），请检查视频格式与大小");
    } finally {
      wc.debugger.removeListener("message", listener);
      await wc.debugger
        .sendCommand("Page.setInterceptFileChooserDialog", { enabled: false })
        .catch(() => undefined);
    }
  }
  private async waitForFileInputNearTexts(
    wc: Electron.WebContents,
    texts: string[],
    timeout: number,
  ) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      for (const text of texts) {
        try {
          const input = await this.findFileInputNearText(wc, text);
          if (input) return input;
        } catch {}
      }
      await sleep(500);
    }
    return undefined;
  }
  /**
   * 挂载抖音发布 API 响应监听。必须在页面加载完成后调用：about:blank 上
   * 的 debugger.attach / Network.enable 会永久挂起（2026-10-26 抖音任务
   * 卡在"等待自动发布"实证）。所有 CDP 调用都带超时护栏。
   */
  private async installDouyinNetworkProbe(
    wc: Electron.WebContents,
  ): Promise<
    ((_event: Electron.Event, method: string, params: any) => void) | undefined
  > {
    return this.installPublishRequestProbe(wc, "douyin");
  }
  /**
   * 挂载发布请求探针：抓取平台**发布接口的请求体**，从中提取原创声明标记。
   * 这是"原创到底有没有随发布请求提交"的权威证据——比看页面控件状态更可靠，
   * 因为服务端只认请求体里的字段。
   */
  private async installPublishRequestProbe(
    wc: Electron.WebContents,
    platform: string,
  ): Promise<
    ((_event: Electron.Event, method: string, params: any) => void) | undefined
  > {
    try {
      if (!wc.debugger.isAttached()) {
        // attach 是同步方法，失败会直接抛错，不能当 Promise 用超时护栏包。
        try {
          wc.debugger.attach("1.3");
        } catch (error) {
          await writeBrowserLog(
            platform + "-debugger-attach-failed " + String(error),
          );
          return undefined;
        }
      }
      await cdpWithTimeout(
        wc.debugger.sendCommand("Network.enable"),
        10000,
        platform + "-network-enable",
      );
      const publishUrl =
        platform === "douyin"
          ? /(aweme\/v1\/(video|post)\/publish|publish\/video|aweme\/v1\/create)/i
          : /(publish|note|create|upload)/i;
      const listener = (_event: Electron.Event, method: string, params: any) => {
        if (method === "Network.requestWillBeSent") {
          const request = (
            params as {
              request?: { url?: string; method?: string; postData?: string };
            }
          ).request;
          if (!request?.url || request.method !== "POST") return;
          if (!publishUrl.test(request.url)) return;
          const body = request.postData || "";
          const urlShort = request.url.slice(0, 200);
          // 从请求体里找原创/声明相关字段（不同平台字段名不同）
          const originalMatch = body.match(
            /"[^"]*(original|declare|declaration|statement|is_original|original_flag)[^"]*"\s*:\s*[^,}&]{1,40}/gi,
          );
          void writeBrowserLog(
            platform +
              "-publish-original-field " +
              JSON.stringify({
                url: urlShort,
                bodyLength: body.length,
                fields: originalMatch ? originalMatch.slice(0, 8) : [],
                // 完整落盘请求体（截断）：字段名匹配不到时也能人工核验，
                // 例如小红书 v2/note 里若平台剥离了原创字段，这里一目了然
                body: body.slice(0, 3500),
              }),
          );
          return;
        }
        if (method !== "Network.responseReceived") return;
        const response = (
          params as { response?: { url?: string; status?: number } }
        ).response;
        if (!response?.url) return;
        if (
          !/(publish|aweme\/v1\/(video|post)|creator\/content)/i.test(
            response.url,
          )
        )
          return;
        void writeBrowserLog(
          platform +
            "-network " +
            JSON.stringify({
              status: response.status,
              url: response.url.slice(0, 300),
            }),
        );
      };
      wc.debugger.on("message", listener);
      return listener;
    } catch (error) {
      await writeBrowserLog(
        platform + "-network-listener-failed " + String(error),
      );
      return undefined;
    }
  }
  /**
   * 在页面上按文本定位一个复选/开关控件并确保其被勾选。
   *
   * 三段式（探测 → 点击 → 复验），2026-10-26 取证驱动：
   * 1) 逐 frame 扫描（主 frame + 子 frame）：抖音/小红书发布页是微前端，
   *    声明控件可能在 iframe 内，只查主 frame 会全部落空。
   * 2) 状态读不到（null）时**照样点击**：小红书的"原创声明"是自定义
   *    switch（标签 class="custom-switch-text-desc"，无 checked/aria-checked），
   *    旧逻辑 `before===false 才点` 导致永远不点（19:11 批次实证：
   *    找到控件 before=null after=null，从未点击）。
   * 3) 点击后复验并记录控件身份（label/HTML/所在 frame/状态变化），
   *    才能证明勾中的是"声明原创"而不是页面上别的复选框。
   */
  private async ensureCheckboxByText(
    wc: Electron.WebContents,
    patterns: RegExp[],
    logTag: string,
    attempts = 3,
  ): Promise<{
    ok: boolean;
    checked?: boolean | null;
    label?: string;
    frame?: string;
  }> {
    const frames = [wc.mainFrame, ...wc.mainFrame.framesInSubtree];
    const attemptsLog: Array<Record<string, unknown>> = [];
    const mark = "data-multipublish-probe";
    for (let round = 0; round < attempts; round++) {
      if (round > 0) {
        // 平台发布表单是异步渲染的：抖音 content/upload 会自动跳到
        // content/post/video（发布设置页），新页面上的声明/同步控件要过
        // 几秒才出现（19:11 批次实证：首扫时新页尚未渲染，四个目标全部落空）。
        await sleep(3000);
      }
      // 等待页面出现"发布"按钮，确保表单主体已渲染完毕
      await wc
        .executeJavaScript(
          "(()=>{const b=[...document.querySelectorAll('button')].find(x=>(x.textContent||'').trim()==='发布');if(b){b.scrollIntoView({block:'center'});return true}return false})()",
        )
        .catch(() => false);
      for (const frame of frames) {
      // 阶段一：探测候选控件（只标记，不点击）
      const probe = `(()=>{
        const visible=el=>!!el&&!!el.getClientRects&&el.getClientRects().length>0;
        const patterns=${JSON.stringify(patterns.map((p) => p.source))}.map(s=>new RegExp(s));
        // 展开折叠区：只点真正的折叠入口。严禁把目标开关自己的文案
        // （声明原创/原创声明）当折叠入口——那会先把开关拨乱
        // （22:53 批次实证：expander 点击与后续点击相互抵消，最终停在未勾选）
        for(const ex of [...document.querySelectorAll('button,div,span,label,a')]
          .filter(e=>visible(e)&&/^(更多设置|更多选项|高级设置|作品声明|同步发布|同步到|全部设置)$/.test((e.textContent||'').trim()))
          .slice(0,5)){try{(ex.closest('button')||ex).click()}catch{}}
        const isControl=el=>{
          if(!el||el.tagName==='INPUT')return false;
          const cls=String(el.className||'');
          if(/text|desc|label|icon|arrow|tip|title/i.test(cls))return false;
          return /switch|checkbox|toggle/i.test(cls)||el.getAttribute('role')==='switch';
        };
        const stateOf=el=>{
          if(!el)return null;
          if(el.checked!==undefined)return !!el.checked;
          const aria=el.getAttribute&&el.getAttribute('aria-checked');
          if(aria==='true'||aria==='false')return aria==='true';
          const cls=String(el.className||'');
          // 注意："unchecked" 包含 "checked" 子串，必须先排除
          // （22:16 批次实证：d-switch-simulator unchecked 被误读为已勾选）
          if(/(^|[\s-])unchecked([\s-]|$)/i.test(cls))return false;
          if(/checked|switched|is-on|is-active|active|selected|opened/i.test(cls))return true;
          const inner=el.querySelector&&el.querySelector('[class*=checked]:not([class*=unchecked])');
          if(inner)return true;
          return null;
        };
        const texts=[...document.querySelectorAll('*')].filter(e=>{
          if(e.children&&e.children.length)return false;
          const t=(e.textContent||'').trim();
          return t&&t.length<=40&&patterns.some(p=>p.test(t));
        });
        for(const t of texts){
          const label=(t.textContent||'').trim();
          const containers=[];
          let scope=t;
          for(let i=0;i<6&&scope;i++){containers.push(scope);scope=scope.parentElement;}
          for(const root of containers){
            const real=root.querySelector&&root.querySelector('input[type=checkbox],input[type=radio],[role=switch],[role=checkbox]');
            if(real){
              const r=real.getBoundingClientRect();
              // 隐藏 input（0 尺寸）是自定义 switch 的数据载体，真实用户点的是
              // 可视开关容器。React 受控组件通常把 onChange 绑在容器上，
              // 直接 click 隐藏 input 可能不触发框架状态更新
              // （2026-10-26 23:07 实证：input checked 变 true 但发布请求体无原创字段）。
              if(r.width>0&&r.height>0&&visible(real)){
                real.setAttribute('${mark}','1');
                return{ok:true,kind:'control',label,tag:real.tagName,cls:String(real.className||'').slice(0,140),html:(real.outerHTML||'').slice(0,320),state:stateOf(real),disabled:!!real.disabled,scopeText:((root.innerText||root.textContent)||'').trim().slice(0,120),rootHtml:(root.outerHTML||'').slice(0,600)};
              }
              // 找隐藏 input 的可视宿主：先向上找带 switch/checkbox 样式的容器，
              // 再退回"包含 input 的最小可见祖先"
              let host=real.parentElement;
              let hostEl=null;
              for(let i=0;i<4&&host;i++){
                if(/switch|checkbox|toggle/i.test(String(host.className||''))&&visible(host)){hostEl=host;break}
                const hr=host.getBoundingClientRect();
                if(hr.width>0&&hr.height>0&&visible(host)&&hr.width<420&&hr.height<90){hostEl=host}
                host=host.parentElement;
              }
              const target=hostEl||real;
              target.setAttribute('${mark}','1');
              return{ok:true,kind:'control-hidden-input',label,tag:target.tagName,cls:String(target.className||'').slice(0,140),html:(target.outerHTML||'').slice(0,320),state:stateOf(target),disabled:!!real.disabled,inputVisible:false,scopeText:((root.innerText||root.textContent)||'').trim().slice(0,120),rootHtml:(root.outerHTML||'').slice(0,600)};
            }
            const cands=[...(root.querySelectorAll?root.querySelectorAll('[class*=switch],[class*=checkbox],[class*=toggle],[role=switch]'):[])].filter(isControl);
            for(const c of cands){
              const rect=c.getBoundingClientRect();
              if(rect.width<=0||rect.width>420||rect.height<=0||rect.height>90||!visible(c))continue;
              c.setAttribute('${mark}','1');
              return{ok:true,kind:'switch',label,tag:c.tagName,cls:String(c.className||'').slice(0,140),html:(c.outerHTML||'').slice(0,320),state:stateOf(c),scopeText:((root.innerText||root.textContent)||'').trim().slice(0,120),rootHtml:(root.outerHTML||'').slice(0,600)};
            }
            // 卡片式控件：抖音"同步发布"的平台项是图标卡片，没有
            // input/switch class，只能按文本命中元素的祖先卡片来点。
            // 命中文本的最近可点击祖先（带 cursor/role 或本身就是可点 div）
            if(root!==t&&root.tagName!=='SPAN'&&root.tagName!=='B'&&root.tagName!=='I'){
              const rect=root.getBoundingClientRect();
              const txt=((root.innerText||root.textContent)||'').trim();
              if(rect.width>0&&rect.width<360&&rect.height>0&&rect.height<220&&visible(root)&&txt.length<=24){
                const clickable=root.getAttribute('role')==='button'||root.tagName==='BUTTON'||root.tagName==='A'||/cursor-pointer|clickable|selectable|platform-item|sync-item|item/i.test(String(root.className||''));
                if(clickable){
                  root.setAttribute('${mark}','1');
                  return{ok:true,kind:'card',label,tag:root.tagName,cls:String(root.className||'').slice(0,140),html:(root.outerHTML||'').slice(0,320),state:stateOf(root),scopeText:txt.slice(0,120),rootHtml:(root.outerHTML||'').slice(0,600)};
                }
              }
            }
          }
        }
        return{ok:false};
      })()`;
      const found = (await frame
        .executeJavaScript(probe)
        .catch(() => undefined)) as
        | ({ ok: boolean } & Record<string, unknown>)
        | undefined;
      if (!found?.ok) {
        if (found) attemptsLog.push({ round, frame: frame.url, ...found });
        continue;
      }
      // 阶段二：点击。优先用真实鼠标事件（Input.dispatchMouseEvent），
      // 平台自绘的 switch/卡片只响应 trusted 事件，el.click() 会被忽略。
      // 必须先 scrollIntoView：声明开关常在视口之外（22:16 批次实证：
      // 开关 y≈1108 超出视口高度，未滚动时 CDP 点击坐标落空，class
      // 点击后依然是 unchecked）。
      await frame
        .executeJavaScript(
          `(()=>{const el=document.querySelector('[${mark}="1"]');if(!el)return false;el.scrollIntoView({block:'center'});return true})()`,
        )
        .catch(() => false);
      await sleep(600);
      // 子 frame 的元素坐标是 frame 内坐标系，CDP 鼠标事件用主视口坐标，
      // 需要加上 iframe 在主页面里的偏移（抖音声明控件在 iframe 内）
      let frameOffset = { ox: 0, oy: 0 };
      if (frame !== wc.mainFrame) {
        const offset = (await wc.mainFrame
          .executeJavaScript(
            `(()=>{const url=${JSON.stringify(frame.url.slice(0, 120))};
              const ifr=[...document.querySelectorAll('iframe')].find(f=>(f.src||'')===url||(f.src||'').split('?')[0]===url.split('?')[0]);
              if(!ifr)return null;const r=ifr.getBoundingClientRect();return{ox:Math.round(r.left),oy:Math.round(r.top)};})()`,
          )
          .catch(() => undefined)) as { ox: number; oy: number } | undefined;
        if (offset) frameOffset = offset;
      }
      const clickInfo = (await frame
        .executeJavaScript(
          `(()=>{const el=document.querySelector('[${mark}="1"]');if(!el)return null;
            const r=el.getBoundingClientRect();
            return{x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2),w:Math.round(r.width),h:Math.round(r.height),tag:el.tagName};})()`,
        )
        .catch(() => undefined)) as
        | { x: number; y: number; w: number; h: number; tag: string }
        | undefined;
      // 阶段二+三：点击与复验的自纠错循环。平台自绘 switch 对点击方式很
      // 挑剔：真实鼠标事件、JS click、原生 setter+change 各有生效场景，
      // 每试一种就读一次真实状态，勾上为止（最多三种策略）。
      const verifyScript = `(()=>{const el=document.querySelector('[${mark}="1"]');if(!el)return null;
            const stateOf=el=>{
              if(el.checked!==undefined)return !!el.checked;
              const aria=el.getAttribute&&el.getAttribute('aria-checked');
              if(aria==='true'||aria==='false')return aria==='true';
              const cls=String(el.className||'');
              if(/(^|[\\s-])unchecked([\\s-]|$)/i.test(cls))return false;
              if(/checked|switched|is-on|is-active|active|selected|opened/i.test(cls))return true;
              const inner=el.querySelector&&el.querySelector('[class*=checked]:not([class*=unchecked])');
              if(inner)return true;
              return null;
            };
            const input=el.matches('input')?el:(el.closest('label')?.querySelector('input[type=checkbox]')||el);
            return{state:stateOf(el),inputState:stateOf(input),html:(el.outerHTML||'').slice(0,320),cls:String(el.className||'').slice(0,140)};})()`;
      const readState = async () => {
        const v = (await frame
          .executeJavaScript(verifyScript)
          .catch(() => undefined)) as Record<string, unknown> | undefined;
        verify = v;
        const state = (v?.state ?? null) as boolean | null;
        const inputState = (v?.inputState ?? null) as boolean | null;
        after = state ?? inputState;
        return after;
      };
      const strategyLog: Array<Record<string, unknown>> = [];
      let clicked = false;
      let after: boolean | null = null;
      let verify: Record<string, unknown> | undefined;
      // 策略1：CDP 真实鼠标事件（trusted 事件，自绘组件的首选）
      if (clickInfo && clickInfo.w > 0 && clickInfo.h > 0) {
        try {
          if (!wc.debugger.isAttached()) wc.debugger.attach("1.3");
          await wc.debugger.sendCommand("Input.dispatchMouseEvent", {
            type: "mouseMoved",
            x: clickInfo.x + frameOffset.ox,
            y: clickInfo.y + frameOffset.oy,
          });
          await wc.debugger.sendCommand("Input.dispatchMouseEvent", {
            type: "mousePressed",
            x: clickInfo.x + frameOffset.ox,
            y: clickInfo.y + frameOffset.oy,
            button: "left",
            buttons: 1,
            clickCount: 1,
          });
          await sleep(120);
          await wc.debugger.sendCommand("Input.dispatchMouseEvent", {
            type: "mouseReleased",
            x: clickInfo.x + frameOffset.ox,
            y: clickInfo.y + frameOffset.oy,
            button: "left",
            buttons: 0,
            clickCount: 1,
          });
          clicked = true;
        } catch {}
      }
      await sleep(700);
      after = await readState();
      strategyLog.push({ strategy: "cdp-click", clicked, after, cls: verify?.cls });
      // 策略2：JS click（点击 label 或 input 本体）
      if (after !== true) {
        clicked = (
          await frame
            .executeJavaScript(
              `(()=>{const el=document.querySelector('[${mark}="1"]');if(!el)return false;
              const input=el.matches('input')?el:(el.closest('label')?.querySelector('input[type=checkbox]')||el);
              try{(input.closest('label')||input).click()}catch{}
              return true;})()`,
            )
            .catch(() => false)
        ) === true;
        await sleep(700);
        after = await readState();
        strategyLog.push({ strategy: "js-click", clicked, after, cls: verify?.cls });
      }
      // 策略3：原生 setter + change 事件——React 受控组件的标准驱动方式，
      // 直接绕过 DOM 点击的事件转发链路
      if (after !== true) {
        clicked = (
          await frame
            .executeJavaScript(
              `(()=>{const el=document.querySelector('[${mark}="1"]');if(!el)return false;
              const input=el.matches('input')?el:(el.querySelector('input[type=checkbox]')||el.closest('label')?.querySelector('input[type=checkbox]'));
              if(!input)return false;
              const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'checked').set;
              setter.call(input,true);
              input.dispatchEvent(new Event('click',{bubbles:true}));
              input.dispatchEvent(new Event('change',{bubbles:true}));
              return true;})()`,
            )
            .catch(() => false)
        ) === true;
        await sleep(700);
        after = await readState();
        strategyLog.push({ strategy: "native-setter", clicked, after, cls: verify?.cls });
      }
      const record = {
        frame: frame.url ? frame.url.slice(0, 160) : "",
        kind: found.kind,
        label: found.label,
        controlTag: found.tag,
        controlCls: found.cls,
        controlHtml: found.html,
        scopeText: found.scopeText,
        before: found.state ?? null,
        after,
        clicked,
        stateReadable: after !== null,
        strategies: strategyLog,
        verifyHtml: verify?.html,
      };
      attemptsLog.push(record);
      await writeBrowserLog(logTag + " " + JSON.stringify(record));
      if (!clicked) continue;
      return {
        ok: true,
        checked: after === true,
        label: typeof found.label === "string" ? found.label : undefined,
        frame: record.frame,
      };
      }
    }
    await writeBrowserLog(
      logTag + " no-visible-control " + JSON.stringify(attemptsLog),
    );
    return { ok: false };
  }


  private async waitAndClickButton(
    wc: Electron.WebContents,
    texts: string[],
    timeout: number,
    preferBottom = true,
  ) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      try {
        if (await this.clickButtonByText(wc, texts, preferBottom)) return true;
      } catch {}
      await sleep(500);
    }
    return false;
  }
  private async waitForMatchingFileInput(
    wc: Electron.WebContents,
    kind: "video" | "image",
    timeout: number,
    excluded: number[] = [],
  ) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      try {
        const inputs = await this.getFileInputs(wc);
        const candidates = inputs.filter(
          (input) =>
            !excluded.includes(input.nodeId) &&
            (kind === "image"
              ? /image/i.test(input.accept)
              : /video/i.test(input.accept) || !/image/i.test(input.accept)),
        );
        if (candidates.length) return candidates[0];
      } catch {}
      await sleep(500);
    }
    return undefined;
  }
  private async uploadFileByActions(
    wc: Electron.WebContents,
    file: string,
    kind: "video" | "image",
    actions: string[],
    excluded: number[] = [],
    timeout = 30000,
  ) {
    const before = (await this.getFileInputs(wc).catch(() => [])).map(
      (input) => input.nodeId,
    );
    const clicked = await this.waitAndClickButton(
      wc,
      actions,
      Math.min(timeout, 15000),
      false,
    );
    if (!clicked) return false;
    const fresh = await this.waitForMatchingFileInput(
      wc,
      kind,
      Math.min(timeout, 15000),
      [...excluded, ...before],
    );
    if (fresh) {
      await this.setFileInput(wc, fresh.nodeId, [file]);
      return true;
    }
    try {
      await this.chooseFileFromButton(wc, actions, file);
      return true;
    } catch {}
    const existing = await this.waitForMatchingFileInput(
      wc,
      kind,
      Math.min(timeout, 5000),
      excluded,
    );
    if (existing) {
      await this.setFileInput(wc, existing.nodeId, [file]);
      return true;
    }
    return false;
  }
  private async waitForFileInputs(wc: Electron.WebContents, timeout: number) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      try {
        const inputs = await this.getFileInputs(wc);
        if (inputs.length) return inputs;
      } catch {}
      await sleep(1500);
    }
    const frames = await Promise.all(
      [wc.mainFrame, ...wc.mainFrame.framesInSubtree].map(async (frame) => {
        const snapshot = await frame
          .executeJavaScript(
            "(()=>({url:location.href,readyState:document.readyState,visibility:document.visibilityState,hidden:document.hidden,inputs:document.querySelectorAll('input[type=file],input[accept]').length,text:(document.body?.innerText||'').slice(0,1200)}))()",
          )
          .catch((error) => ({ error: String(error) }));
        return snapshot;
      }),
    );
    await writeBrowserLog(
      "file-input-timeout " +
        redactWeixinDiagnostic(
          JSON.stringify({ url: wc.getURL(), frames }),
          12000,
        ),
    );
    return [];
  }
  private async getFileInputs(wc: Electron.WebContents) {
    if (!wc.debugger.isAttached()) wc.debugger.attach("1.3");
    await wc.debugger.sendCommand("DOM.enable");
    const flattened = await wc.debugger.sendCommand(
      "DOM.getFlattenedDocument",
      { depth: -1, pierce: true },
    );
    const result: {
      nodeId: number;
      accept: string;
      attributes: Record<string, string>;
    }[] = [];
    for (const node of flattened.nodes as Array<{
      nodeId: number;
      nodeName: string;
      attributes?: string[];
      backendNodeId?: number;
    }>) {
      if (node.nodeName !== "INPUT") continue;
      const attributes = node.attributes || [];
      const values = new Map<string, string>();
      for (let index = 0; index < attributes.length; index += 2)
        values.set(attributes[index], attributes[index + 1] || "");
      const type = (values.get("type") || "").toLowerCase(),
        accept = values.get("accept") || "";
      if (type === "file" || accept)
        result.push({
          nodeId: node.backendNodeId || node.nodeId,
          accept,
          attributes: Object.fromEntries(values),
        });
    }
    return result;
  }
  private async setFileInput(
    wc: Electron.WebContents,
    nodeId: number,
    files: string[],
  ) {
    if (!wc.debugger.isAttached()) wc.debugger.attach("1.3");
    await wc.debugger.sendCommand("DOM.setFileInputFiles", {
      backendNodeId: nodeId,
      files,
    });
  }
  private async fillContent(
    wc: Electron.WebContents,
    draft: PublishDraft,
    platform: Account["platform"],
    options: { toutiaoStrict?: boolean } = {},
  ) {
    if (platform === "bilibili" || platform === "kuaishou") await sleep(3000);
    const titleLimit =
      platform === "xiaohongshu"
        ? 20
        : platform === "douyin" || platform === "toutiao"
          ? 30
          : platform === "weixin"
            ? 20
          : undefined;
    const title = titleLimit
      ? Array.from(draft.title).slice(0, titleLimit).join("")
      : draft.title;
    if (platform === "weixin") {
      if (!wc.debugger.isAttached()) wc.debugger.attach("1.3");
      await wc.debugger.sendCommand("DOM.enable");
      const flattened = await wc.debugger.sendCommand(
        "DOM.getFlattenedDocument",
        { depth: -1, pierce: true },
      );
      const nodes = flattened.nodes as Array<{
        nodeName: string;
        backendNodeId?: number;
        attributes?: string[];
      }>;
      const readAttributes = (node: (typeof nodes)[number]) => {
        const attributes = node.attributes || [];
        const result = new Map<string, string>();
        for (let index = 0; index < attributes.length; index += 2)
          result.set(attributes[index], attributes[index + 1] || "");
        return result;
      };
      const visible = async (node: (typeof nodes)[number]) => {
        if (!node.backendNodeId) return undefined;
        try {
          const model = await wc.debugger.sendCommand("DOM.getBoxModel", {
            backendNodeId: node.backendNodeId,
          });
          const quad = (model.model.border || model.model.content) as number[];
          const width = Math.max(quad[0], quad[2], quad[4], quad[6]) -
            Math.min(quad[0], quad[2], quad[4], quad[6]);
          const height = Math.max(quad[1], quad[3], quad[5], quad[7]) -
            Math.min(quad[1], quad[3], quad[5], quad[7]);
          return width * height > 100 ? width * height : undefined;
        } catch {
          return undefined;
        }
      };
      const candidates = [] as Array<{
        backendNodeId: number;
        area: number;
        kind: "title" | "description";
        score: number;
      }>;
      for (const node of nodes) {
        const attrs = readAttributes(node);
        const placeholder =
          attrs.get("placeholder") || attrs.get("data-placeholder") || "";
        const isDescription = attrs.has("contenteditable");
        const isTitle =
          node.nodeName === "INPUT" &&
          !/file|hidden/i.test(attrs.get("type") || "") &&
          /标题|作品名称|视频名称/.test(placeholder);
        if (!isDescription && !isTitle) continue;
        const area = await visible(node);
        if (!area || !node.backendNodeId) continue;
        candidates.push({
          backendNodeId: node.backendNodeId,
          area,
          kind: isDescription ? "description" : "title",
          score:
            (isDescription ? 0 : 100) +
            (/短标题/.test(placeholder) ? -50 : 0) -
            Math.min(area / 100000, 10),
        });
      }
      const titleCandidate = candidates
        .filter((candidate) => candidate.kind === "title")
        .sort((a, b) => a.score - b.score || b.area - a.area)[0];
      const descriptionCandidate = candidates
        .filter((candidate) => candidate.kind === "description")
        .sort((a, b) => b.area - a.area)[0];
      const typeInto = async (backendNodeId: number, value: string) => {
        await wc.debugger.sendCommand("DOM.focus", { backendNodeId });
        await wc.debugger.sendCommand("Input.dispatchKeyEvent", {
          type: "rawKeyDown",
          key: "a",
          code: "KeyA",
          windowsVirtualKeyCode: 65,
          modifiers: 2,
        });
        await wc.debugger.sendCommand("Input.dispatchKeyEvent", {
          type: "rawKeyDown",
          key: "Backspace",
          code: "Backspace",
          windowsVirtualKeyCode: 8,
        });
        await wc.debugger.sendCommand("Input.dispatchKeyEvent", {
          type: "keyUp",
          key: "Backspace",
          code: "Backspace",
          windowsVirtualKeyCode: 8,
        });
        await wc.debugger.sendCommand("Input.dispatchKeyEvent", {
          type: "keyUp",
          key: "a",
          code: "KeyA",
          windowsVirtualKeyCode: 65,
          modifiers: 2,
        });
        await wc.debugger.sendCommand("Input.insertText", { text: value });
        await wc.debugger.sendCommand("Input.dispatchKeyEvent", {
          type: "keyDown",
          key: "Tab",
          code: "Tab",
          windowsVirtualKeyCode: 9,
        });
        await wc.debugger.sendCommand("Input.dispatchKeyEvent", {
          type: "keyUp",
          key: "Tab",
          code: "Tab",
          windowsVirtualKeyCode: 9,
        });
        await sleep(700);
      };
      if (!titleCandidate || !descriptionCandidate)
        throw new Error(
          "未找到视频号真实短标题或描述控件：" +
            JSON.stringify({
              title: !!titleCandidate,
              description: !!descriptionCandidate,
              candidates: candidates.map(({ kind, area, score }) => ({
                kind,
                area,
                score,
              })),
            }),
        );
      await typeInto(titleCandidate.backendNodeId, title);
      // The title control is an `mp-input` Vue component.  In some Electron
      // builds the native input receives the CDP keystrokes but the component
      // listener does not receive the composed input event, leaving
      // postObjDesc.mpTitle empty even though the textbox visibly contains
      // the title.  Replay the component event as a fallback so the request
      // is built from the same state as a normal user edit.
      let titleComponentResult: unknown = { found: false };
      try {
        const resolved = await wc.debugger.sendCommand("DOM.resolveNode", {
          backendNodeId: titleCandidate.backendNodeId,
        });
        const objectId = resolved.object?.objectId;
        if (!objectId) throw new Error("title input object missing");
        const invoked = await wc.debugger.sendCommand(
          "Runtime.callFunctionOn",
          {
            objectId,
            functionDeclaration:
              "function(value){try{this.focus();const proto=Object.getPrototypeOf(this);const setter=Object.getOwnPropertyDescriptor(proto,'value')?.set;if(!setter)throw new Error('value setter missing');setter.call(this,value);this.dispatchEvent(new Event('input',{bubbles:true,composed:true}));this.dispatchEvent(new Event('change',{bubbles:true,composed:true}));this.blur();return{found:true,value:this.value,placeholder:this.getAttribute('placeholder')||''}}catch(error){return{found:false,error:String(error)}}}",
            arguments: [{ value: title }],
            returnByValue: true,
          },
        );
        titleComponentResult = invoked.result?.value || { found: false };
      } catch (error) {
        titleComponentResult = { found: false, error: String(error) };
      }
      await Promise.resolve(titleComponentResult)
        .then((result) =>
          writeBrowserLog(
            "weixin-title-component-input " + JSON.stringify(result),
          ),
        )
        .catch((error) =>
          writeBrowserLog(
            "weixin-title-component-input-error " + String(error),
          ),
        );
      await sleep(800);
      await typeInto(descriptionCandidate.backendNodeId, draft.description);
      const weixinFilled = await wc.executeJavaScript(
        "(()=>{const all=root=>{const result=[];for(const e of root.querySelectorAll('*')){result.push(e);if(e.shadowRoot)result.push(...all(e.shadowRoot))}return result};const visible=e=>e&&e.getClientRects().length>0&&getComputedStyle(e).visibility!=='hidden';const fields=all(document).filter(e=>visible(e)&&(e.matches?.('input,textarea,[contenteditable]')||e.getAttribute?.('contenteditable')!==null));const title=fields.find(e=>e.tagName==='INPUT'&&/短标题|标题|作品名称|视频名称/.test(e.getAttribute('placeholder')||''));const description=fields.find(e=>e.getAttribute('contenteditable')!==null);return{title:typeof title?.value==='string'?title.value:title?.textContent||'',description:description?.textContent||''}})()",
      );
      if (
        weixinFilled.title !== title ||
        !weixinFilled.description.includes(draft.description)
      )
        throw new Error(
          "视频号真实输入未生效：" +
            JSON.stringify({ ...weixinFilled, expectedTitle: title }),
        );
      await writeBrowserLog(
        "weixin-content-typed " + JSON.stringify(weixinFilled).slice(0, 5000),
      );
      return;
    }
    const payload = JSON.stringify({
      title,
      description: draft.description,
      tags: draft.topics,
      platform,
    });
    const genericFilled = await wc.executeJavaScript(
      "(()=>{const data=" +
        payload +
        ";const visible=e=>e&&e.getClientRects().length>0&&getComputedStyle(e).visibility!=='hidden';const all=root=>{const result=[];for(const e of root.querySelectorAll('*')){result.push(e);if(e.shadowRoot)result.push(...all(e.shadowRoot))}return result};const set=(el,value)=>{if(!el)return false;el.focus();if(el.isContentEditable||el.hasAttribute?.('contenteditable')){el.textContent=value;el.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:value}));el.dispatchEvent(new Event('change',{bubbles:true}))}else{let proto=el;let setter;while(proto&&!setter){setter=Object.getOwnPropertyDescriptor(proto,'value')?.set;proto=Object.getPrototypeOf(proto)}setter?setter.call(el,value):el.value=value;el.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:value}));el.dispatchEvent(new Event('change',{bubbles:true}))}el.blur?.();return true};const fields=all(document).filter(e=>visible(e)&&e.matches?.('input,textarea,[contenteditable]'));const hint=e=>(e.getAttribute('placeholder')||e.getAttribute('data-placeholder')||'');const title=fields.find(e=>/标题|作品名称|视频名称|0～30|0-30/.test(hint(e)))||fields.find(e=>e.tagName==='INPUT'&&e.type==='text');const description=data.platform==='bilibili'?fields.find(e=>e.tagName==='TEXTAREA'&&/更全面|相关信息|视频/.test(hint(e)))||fields.find(e=>e.tagName==='TEXTAREA'):fields.find(e=>/简介|描述|正文|内容/.test(hint(e)))||fields.find(e=>e.tagName==='TEXTAREA')||fields.find(e=>(e.isContentEditable||e.hasAttribute?.('contenteditable'))&&e!==title);const titleSet=set(title,data.title);const descriptionSet=set(description,data.description);const tagField=fields.find(e=>/话题|标签/.test(hint(e)));if(tagField&&data.tags.length)set(tagField,data.tags.map(t=>'#'+t).join(' '));return{titleSet,descriptionSet,title:typeof title?.value==='string'?title.value:title?.textContent||'',description:typeof description?.value==='string'?description.value:description?.textContent||'',fieldCount:fields.length}})()",
    );
    if (platform === "toutiao") {
      if (!wc.debugger.isAttached()) wc.debugger.attach("1.3");
      await wc.debugger.sendCommand("DOM.enable");
      const flat = await wc.debugger.sendCommand("DOM.getFlattenedDocument", {
        depth: -1,
        pierce: true,
      });
      const titleNodes = (flat.nodes as Array<{
        nodeName: string;
        backendNodeId?: number;
        attributes?: string[];
      }>).filter((node) => {
        if (node.nodeName !== "INPUT" || !node.backendNodeId) return false;
        const attrs = node.attributes || [];
        for (let i = 0; i < attrs.length; i += 2)
          if (
            attrs[i] === "placeholder" &&
            /0[～-]30|标题/.test(attrs[i + 1] || "")
          )
            return true;
        return false;
      });
      const titleNode = titleNodes.at(-1);
      if (titleNode?.backendNodeId) {
        const resolved = await wc.debugger.sendCommand("DOM.resolveNode", {
          backendNodeId: titleNode.backendNodeId,
        });
        const objectId = resolved.object?.objectId;
        if (objectId)
          await wc.debugger.sendCommand("Runtime.callFunctionOn", {
            objectId,
            functionDeclaration:
              'function(value){const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value")?.set;setter?setter.call(this,value):this.value=value;this.dispatchEvent(new InputEvent("input",{bubbles:true,inputType:"insertText",data:value}));this.dispatchEvent(new Event("change",{bubbles:true}));this.dispatchEvent(new Event("blur",{bubbles:true}));return this.value}',
            arguments: [{ value: title }],
            returnByValue: true,
          });
        await wc.debugger.sendCommand("Input.dispatchKeyEvent", {
          type: "keyDown",
          key: "Tab",
          code: "Tab",
          windowsVirtualKeyCode: 9,
        });
        await wc.debugger.sendCommand("Input.dispatchKeyEvent", {
          type: "keyUp",
          key: "Tab",
          code: "Tab",
          windowsVirtualKeyCode: 9,
        });
        await sleep(700);
      }
      // The form re-renders while the video uploads, so the verify query can
      // race a remount and momentarily see zero inputs even though the typed
      // title persists. The editor can also live in a child iframe, where the
      // main document query finds nothing, so poll every frame before
      // declaring the input ineffective.
      const titleQuery =
        "((value)=>{const visible=e=>!!e&&e.getClientRects?.().length>0&&getComputedStyle(e).visibility!=='hidden';const all=root=>{const r=[];for(const e of root.querySelectorAll('*')){r.push(e);if(e.shadowRoot)r.push(...all(e.shadowRoot))}return r};const hint=e=>(e.placeholder||'')+(e.getAttribute('data-placeholder')||'');const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')?.set;const inputs=all(document).filter(e=>visible(e)&&e.matches?.('input')&&/[0-9][～-]30|标题/.test(hint(e)));for(const e of inputs){e.focus();setter?setter.call(e,value):e.value=value;e.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:value}));e.dispatchEvent(new Event('change',{bubbles:true}));e.blur?.()}return{values:inputs.map(e=>e.value),placeholders:inputs.map(e=>hint(e)),value:inputs.at(-1)?.value||'',placeholder:inputs.at(-1)?hint(inputs.at(-1))||inputs.at(-1).placeholder||'':''}})(" +
        JSON.stringify(title) +
        ")";
      let titleState: { value: string; placeholder: string } = {
        value: "",
        placeholder: "",
      };
      const frames = [wc.mainFrame, ...wc.mainFrame.framesInSubtree];
      for (let attempt = 0; attempt < 8; attempt++) {
        const frameStates: Array<{
          url: string;
          value: string;
          placeholder: string;
        }> = await Promise.all(
          frames.map((frame) =>
            frame
              .executeJavaScript(titleQuery)
              .then((raw) => {
                const state = raw as { value: string; placeholder: string };
                return {
                  url: frame.url,
                  value: state.value,
                  placeholder: state.placeholder,
                };
              })
              .catch(() => ({ url: frame.url, value: "", placeholder: "" })),
          ),
        );
        const matched = frameStates.find((state) => state.value === title);
        if (matched) {
          titleState = {
            value: matched.value,
            placeholder: matched.placeholder,
          };
          break;
        }
        titleState = {
          value: frameStates.at(-1)?.value || "",
          placeholder: frameStates.at(-1)?.placeholder || "",
        };
        await sleep(1200);
      }
      const inputInventoryQuery =
        "(()=>{const visible=e=>!!e&&e.getClientRects?.().length>0&&getComputedStyle(e).visibility!=='hidden';const all=root=>{const r=[];for(const e of root.querySelectorAll('*')){r.push(e);if(e.shadowRoot)r.push(...all(e.shadowRoot))}return r};return{url:location.href,inputs:all(document).filter(e=>visible(e)&&e.matches?.('input,textarea,[contenteditable=true]')).slice(0,30).map(e=>({tag:e.tagName,type:e.type||'',placeholder:e.placeholder||'',dataPlaceholder:e.getAttribute('data-placeholder')||'',aria:e.getAttribute('aria-label')||'',cls:String(e.className||'').slice(0,80),value:typeof e.value==='string'?e.value.slice(0,60):(e.textContent||'').slice(0,60)}))}})()";
      const frameInventories = await Promise.all(
        frames.map((frame) =>
          frame
            .executeJavaScript(inputInventoryQuery)
            .catch(() => ({ url: frame.url, inputs: [] })),
        ),
      );
      await writeBrowserLog(
        "toutiao-content-typed " +
          JSON.stringify({
            genericFilled,
            titleState,
            expectedTitle: title,
            frameCount: frames.length,
            inventories: frameInventories,
          }).slice(0, 16000),
      );
      if (titleState.value !== title) {
        if (options.toutiaoStrict)
          throw new Error(
            "头条标题输入未生效：" +
              JSON.stringify({ titleState, expectedTitle: title }),
          );
        // The first fill runs while the video is still uploading; Toutiao
        // resets the form (title from filename) once processing completes,
        // so only the strict post-upload re-fill may abort the task here.
        await writeBrowserLog(
          "toutiao-title-lenient-mismatch " +
            JSON.stringify({ titleState, expectedTitle: title }),
        );
      }
    }
  }
  private async waitForBilibiliPublishReady(
    wc: Electron.WebContents,
    timeout: number,
  ) {
    const start = Date.now();
    let lastDiagnosticAt = 0;
    while (Date.now() - start < timeout) {
      const state = await wc
        .executeJavaScript(
          "(()=>{const visible=e=>!!e&&e.getClientRects?.().length>0&&getComputedStyle(e).visibility!=='hidden';const all=root=>{const result=[];for(const e of root.querySelectorAll('*')){result.push(e);if(e.shadowRoot)result.push(...all(e.shadowRoot))}return result};const nodes=all(document).filter(visible);const buttons=nodes.filter(e=>e.matches?.('button,[role=button],a,div,span')&&/^(立即投稿|投稿|发布)$/.test((e.textContent||'').trim()));const publish=buttons.some(e=>!e.disabled&&e.getAttribute('aria-disabled')!=='true'&&!String(e.className||'').includes('disabled'));const title=nodes.find(e=>e.matches?.('input,textarea,[contenteditable=true]')&&/标题|稿件标题|视频标题/.test(e.getAttribute('placeholder')||''));const titleValue=typeof title?.value==='string'?title.value:(title?.textContent||'');const text=(document.body?.innerText||'').slice(-16000);return{publish,title:!!titleValue.trim(),failed:/上传失败|转码失败|无视频流信息/.test(text),url:location.href,text:text.slice(-2500)}})()",
        )
        .catch(() => ({ publish: false, title: false, failed: false, url: wc.getURL(), text: "" }));
      if (state.failed) throw new Error("B站平台返回视频上传失败");
      if (Date.now() - lastDiagnosticAt >= 10000) {
        lastDiagnosticAt = Date.now();
        await writeBrowserLog(
          "bilibili-publish-ready-state " + JSON.stringify(state).slice(0, 5000),
        );
      }
      // Bilibili keeps a static “上传进度” label in the editor after the
      // upload is complete. The actionable submit control is the reliable
      // readiness signal, so do not gate on that stale label.
      if (state.publish && state.title) return true;
      await sleep(1500);
    }
    return false;
  }
  private async waitForPublishReady(
    wc: Electron.WebContents,
    platform: Account["platform"],
    timeout: number,
  ) {
    const start = Date.now();
    let lastDiagnosticAt = 0;
    while (Date.now() - start < timeout) {
      if (wc.isDestroyed()) throw new Error("发布窗口已关闭");
      const uploadFailure = this.weixinUploadFailures.get(wc.id);
      if (platform === "weixin" && uploadFailure) throw new Error(uploadFailure);
      if (platform === "weixin") {
        const remoteUploadAt = this.weixinRemoteUploadAt.get(wc.id) || 0;
        const remoteUploadAge = remoteUploadAt
          ? Date.now() - remoteUploadAt
          : 0;
        if (!remoteUploadAt || remoteUploadAge < 8000) {
          if (Date.now() - lastDiagnosticAt >= 10000) {
            lastDiagnosticAt = Date.now();
            await writeBrowserLog(
              "weixin-upload-wait " + JSON.stringify({
                elapsed: Date.now() - start, remoteUploadAt, remoteUploadAge,
              }),
            );
          }
          await sleep(1000);
          continue;
        }
        try {
          if (!wc.debugger.isAttached()) wc.debugger.attach("1.3");
          await wc.debugger.sendCommand("DOM.enable");
          const tree = await wc.debugger.sendCommand(
            "DOM.getFlattenedDocument",
            {
              depth: -1,
              pierce: true,
            },
          );
          const nodes = (tree.nodes || []) as Array<{
            nodeId: number;
            parentId?: number;
            nodeName?: string;
            nodeValue?: string;
            attributes?: string[];
          }>;
          const byId = new Map(nodes.map((node) => [node.nodeId, node]));
          const readAttributes = (node: (typeof nodes)[number]) => {
            const attributes = node.attributes || [];
            const result = new Map<string, string>();
            for (let index = 0; index < attributes.length; index += 2)
              result.set(attributes[index], attributes[index + 1] || "");
            return result;
          };
          let text = "";
          let publish = false;
          let publishNodeId = 0;
          let publishButton = "";
          for (const textNode of nodes.filter(
            (node) =>
              node.nodeName === "#text" &&
              /^(发布|发表)$/.test((node.nodeValue || "").trim()),
          )) {
            let current: (typeof nodes)[number] | undefined = textNode;
            for (let depth = 0; current && depth < 8; depth++) {
              const attributes = readAttributes(current);
              if (
                current.nodeName === "BUTTON" ||
                attributes.get("role") === "button"
              ) {
                const className = attributes.get("class") || "";
                const enabled =
                  !attributes.has("disabled") &&
                  attributes.get("aria-disabled") !== "true" &&
                  !/disabled/.test(className);
                publishButton = JSON.stringify({
                  text: textNode.nodeValue,
                  enabled,
                  className,
                  ariaDisabled: attributes.get("aria-disabled"),
                });
                if (enabled) {
                  const resolved = await wc.debugger.sendCommand("DOM.resolveNode", {
                    nodeId: current.nodeId,
                  });
                  const objectId = resolved.object?.objectId;
                  if (objectId) {
                    try {
                      const state = await wc.debugger.sendCommand("Runtime.callFunctionOn", {
                        objectId,
                        functionDeclaration: 'function(){return{visible:this.getClientRects().length>0&&getComputedStyle(this).visibility!=="hidden",text:this.ownerDocument.body?.innerText||""}}',
                        returnByValue: true,
                      });
                      if (state.result?.value?.visible) {
                        text = state.result.value.text;
                        publish = true;
                        publishNodeId = current.nodeId;
                      }
                    } finally {
                      await wc.debugger.sendCommand("Runtime.releaseObject", { objectId }).catch(() => undefined);
                    }
                  }
                }
                break;
              }
              current = current.parentId
                ? byId.get(current.parentId)
                : undefined;
            }
            if (publish) break;
          }
          if (publishNodeId) {
            await wc.debugger.sendCommand("DOM.scrollIntoViewIfNeeded", {
              nodeId: publishNodeId,
            });
            const model = await wc.debugger.sendCommand("DOM.getBoxModel", {
              nodeId: publishNodeId,
            });
            const quad = (model.model.border ||
              model.model.content) as number[];
            this.weixinPublishPoints.set(wc.id, {
              x: [quad[0], quad[2], quad[4], quad[6]].reduce(
                (sum, value) => sum + value / 4,
                0,
              ),
              y: [quad[1], quad[3], quad[5], quad[7]].reduce(
                (sum, value) => sum + value / 4,
                0,
              ),
            });
          }
          const uploading = /上传中|正在上传|转码中|上传进度|处理中/.test(text);
          const uploaded = true;
          if (Date.now() - lastDiagnosticAt >= 10000) {
            lastDiagnosticAt = Date.now();
            await writeBrowserLog(
              "weixin-cdp-publish-ready " +
                JSON.stringify({
                  uploading,
                  publish,
                  uploaded,
                  publishButton,
                  remoteUploadAge,
                  text: text.slice(-5000),
                }),
            );
          }
          if (
            !uploading &&
            publish &&
            uploaded &&
            this.weixinPublishPoints.has(wc.id)
          )
            return true;
        } catch (error) {
          await writeBrowserLog("weixin-publish-ready-error " + String(error));
        }
        await sleep(1500);
        continue;
      }
      const state = await wc.executeJavaScript(
        "(()=>{const visible=e=>!!e&&e.getClientRects().length>0&&getComputedStyle(e).visibility!=='hidden';const roots=[document],nodes=[];for(let i=0;i<roots.length;i++){for(const e of roots[i].querySelectorAll('*')){nodes.push(e);if(e.shadowRoot)roots.push(e.shadowRoot)}}const text=roots.map(root=>root===document?(document.body?.innerText||''):(root.textContent||'')).join(' ');const buttons=nodes.filter(e=>e.matches?.('button,[role=button],div,span')&&visible(e));const videos=nodes.filter(e=>e.tagName==='VIDEO');const challenge=/扫码登录|验证码|安全验证|重新登录/.test(text);const uploading=/上传中|正在上传|转码中|上传进度|文件上传中|处理中/.test(text);const publish=buttons.some(b=>/^(发布|立即发布|确认发布|投稿|立即投稿|提交发布|发表)$/.test((b.textContent||'').trim())&&!b.disabled&&b.getAttribute('aria-disabled')!=='true'&&!String(b.className||'').includes('disabled'));const videoReady=videos.some(v=>(v.currentSrc||v.src||'').includes('finder.video.qq.com')||(Number.isFinite(v.duration)&&v.duration>0&&v.readyState>=1));const uploaded=videoReady||/上传成功|上传完成|视频文件|重新上传|更换视频|移除视频|视频上传信息|封面预览/.test(text);return{challenge,uploading,publish,uploaded,videoReady,text:text.slice(-20000),url:location.href}})()",
      );
      if (state.challenge) throw new Error("平台要求登录或安全验证");
      if (
        platform === "xiaohongshu" &&
        state.publish &&
        /视频文件|重新上传|检测为高清视频/.test(state.text)
      )
        return true;
      if (platform === "douyin" && state.publish && state.uploaded) return true;
      if (state.publish && state.uploaded && !state.uploading) return true;
      if (
        platform === "toutiao" &&
        state.publish &&
        !state.uploading &&
        /上传成功/.test(state.text)
      )
        return true;
      await sleep(1500);
    }
    return false;
  }
  private async verifyPublishedTitle(
    wc: Electron.WebContents,
    platform: Account["platform"],
    title: string,
    timeout: number,
  ) {
    const managerUrls: Partial<Record<Account["platform"], string>> = {
      douyin: "https://creator.douyin.com/creator-micro/content/manage",
      kuaishou: "https://cp.kuaishou.com/article/manage/video",
      xiaohongshu: "https://creator.xiaohongshu.com/",
      toutiao: "https://mp.toutiao.com/profile_v4/manage/content/all",
      bilibili: "https://member.bilibili.com/platform/upload-manager/article",
      weixin: "https://channels.weixin.qq.com/platform/post/list",
    };
    const managerUrl =
      platform === "xiaohongshu"
        ? xhsOriginFromUrl(wc.getURL()) + "/"
        : managerUrls[platform];
    if (!managerUrl)
      return {
        ok: false,
        url: wc.getURL(),
        reason: platformMap[platform].name + "尚未配置后台标题验真",
      };
    if (platform === "weixin") {
      try {
        if (!wc.debugger.isAttached()) wc.debugger.attach("1.3");
        await cdpWithTimeout(
          wc.debugger.sendCommand("Page.enable"),
          10000,
          "weixin-page-enable",
        );
        await cdpWithTimeout(
          wc.debugger.sendCommand("Page.addScriptToEvaluateOnNewDocument", {
            source: weixinPostListRecorder,
          }),
          10000,
          "weixin-post-list-recorder",
        );
      } catch (error) {
        await writeBrowserLog(
          "weixin-post-list-recorder-install-failed " + String(error),
        );
      }
    }
    const limit =
      platform === "xiaohongshu"
        ? 20
        : platform === "douyin" || platform === "toutiao"
          ? 30
          : undefined;
    const platformTitle = limit
      ? Array.from(title).slice(0, limit).join("")
      : title;
    const normalize = (value: string) =>
      value
        .normalize("NFKC")
        .toLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, "");
    const normalizedTitle = normalize(platformTitle);
    const rawExpected = backendTitleCandidates(platform, platformTitle);
    const expected = rawExpected.map(normalize).filter((value) => value.length >= 2);
    const start = Date.now();
    let lastUrl = "";
    let lastSnapshot = "";
    while (Date.now() - start < timeout) {
      // 小红书必须直接进入笔记管理页：停留在创作者首页时，页面上的
      // “最新笔记”卡片只是历史作品，会把旧作误判成新发布
      // （2026-10-26 claude-seo 实证：快照 URL 是 /new/home，命中的是
      // 首页里的 microdu 旧笔记）。
      const targetUrl =
        platform === "xiaohongshu"
          ? xhsOriginFromUrl(wc.getURL()) + "/new/note-manager"
          : managerUrl;
      await wc.loadURL(targetUrl).catch((error) => {
        if (!/ERR_ABORTED/.test(String(error))) throw error;
      });
      await sleep(7000);
      if (platform === "xiaohongshu" && !/note-manager/.test(wc.getURL())) {
        const opened = await this.clickSmallestByText(wc, "笔记管理");
        if (!opened) {
          const href = await wc
            .executeJavaScript(
              "(()=>{const link=[...document.querySelectorAll('a')].find(e=>(e.textContent||'').trim()==='笔记管理');return link?.href||''})()",
            )
            .catch(() => "");
          if (href) await wc.loadURL(href);
        }
        await sleep(5000);
      }
      if (platform === "kuaishou" || platform === "douyin") {
        await this.clickSmallestByText(wc, "已发布");
        await sleep(4000);
      }
      const pollUntil = Math.min(start + timeout, Date.now() + 45000);
      while (Date.now() < pollUntil) {
        if (platform === "weixin") {
          const evidence = (await Promise.all(
            [wc.mainFrame, ...wc.mainFrame.framesInSubtree].map((frame) =>
              frame
                .executeJavaScript(
                  "(()=>({url:location.href,entries:Array.isArray(window.__multipublishPostListEvidence)?window.__multipublishPostListEvidence:[]}))()",
                )
                .catch(() => ({ url: "", entries: [] })),
            ),
          )) as Array<{ url: string; entries: any[] }>;
          const exactEvidence = [
            ...(this.weixinPostListTitles.get(wc.id) || []),
            ...evidence
              .flatMap((item) => item.entries || [])
              .flatMap((entry: any) => entry.titles || []),
          ];
          await writeBrowserLog(
            "weixin-post-list-evidence " +
              JSON.stringify({
                entries: exactEvidence.length,
                titles: exactEvidence.slice(0, 80),
              }).slice(0, 12000),
          );
          if (exactEvidence.some((value: unknown) => value === title)) {
            await writeBrowserLog("backend-title-verified " + JSON.stringify({
              platform, title, url: wc.getURL(), source: "post_list",
            }));
            return { ok: true, url: wc.getURL() };
          }
        }
        const snapshot = await wc
          .executeJavaScript(
            "(()=>{const all=root=>{const result=[];for(const e of root.querySelectorAll('*')){result.push(e);if(e.shadowRoot)result.push(...all(e.shadowRoot))}return result};const text=((document.body?.innerText||'')+' '+all(document).map(e=>e.shadowRoot?(e.shadowRoot.innerText||e.shadowRoot.textContent||''):'').join(' ')).slice(0,120000);return{url:location.href,text,login:/扫码登录|手机号登录|验证码登录|短信登录|密码登录|立即登录/.test(text)||location.pathname.includes('/login')||location.pathname.includes('/auth')}})()",
          )
          .catch(() => ({ url: wc.getURL(), text: "", login: false }));
        lastUrl = snapshot.url;
        lastSnapshot = snapshot.text;
        if (snapshot.login)
          return {
            ok: false,
            url: snapshot.url,
            reason: platformMap[platform].name + "作品管理要求重新登录",
          };
        const normalizedText = normalize(snapshot.text);
        const matchedRaw = rawExpected.find((value) =>
          snapshot.text.includes(value),
        );
        const matchedNormalized = matchedRaw
          ? undefined
          : expected.find((value) => normalizedText.includes(value));
        if (matchedRaw || matchedNormalized) {
          await writeBrowserLog("backend-title-verified " + JSON.stringify({
            platform, title: platformTitle, url: snapshot.url,
            source: "manager-dom",
            matched: matchedRaw
              ? { kind: "raw", value: matchedRaw }
              : { kind: "normalized", value: matchedNormalized },
            text: snapshot.text.slice(0, 16000),
          }));
          if (platform === "xiaohongshu" || platform === "douyin") {
            // 原创声明取证：抖音内容管理页/小红书笔记管理页都不展示"原创"
            // 字样（2026-10-26 实测两页"原创"均 0 次命中），靠列表判断无效。
            // 真正的声明状态在作品/笔记编辑页的"声明原创"开关上，因此进
            // 编辑页读取该开关的 checked 状态作为权威证据（只读，不保存）。
            const original = await this.readOriginalDeclaration(
              wc,
              platform,
              platformTitle,
            );
            await writeBrowserLog(
              "original-declaration " + JSON.stringify(original),
            );
          }
          return { ok: true, url: snapshot.url };
        }
        await sleep(3000);
      }
    }
    await writeBrowserLog(
      "backend-title-miss " +
        JSON.stringify({
          platform,
          title: platformTitle,
          url: lastUrl || wc.getURL(),
          text: (lastSnapshot || "").slice(0, 16000),
        }),
    );
    return {
      ok: false,
      url: lastUrl || wc.getURL(),
      reason: platformMap[platform].name + "作品管理未找到目标标题",
    };
  }
  /**
  /**
   * 读取平台作品/笔记编辑页里"声明原创"开关的真实状态。
   * 后台列表页不展示"原创"字样（2026-10-26 实测：抖音内容管理页 4624
   * 字符、小红书笔记管理页 2344 字符，"原创"均 0 次命中），因此判断声明
   * 是否生效只能进编辑页读开关。本方法只读不写：不点保存、不改内容，
   * 读完立即返回原页面。抖音的"编辑作品"是弹窗、小红书是整页，两种
   * 形态都要覆盖。
   */
  private async readOriginalDeclaration(
    wc: Electron.WebContents,
    platform: Account["platform"],
    title: string,
  ): Promise<Record<string, unknown>> {
    const result: Record<string, unknown> = { platform, title };
    const backUrl = wc.getURL();
    // 各平台编辑入口的文案：抖音"编辑作品"、小红书"编辑"、视频号"编辑"
    const entryPattern =
      platform === "douyin"
        ? /^(编辑作品|编辑)$/
        : platform === "weixin"
          ? /^(编辑|编辑作品|编辑动态)$/
          : /^(编辑|编辑笔记|编辑作品)$/;
    try {
      // 在管理页找到目标作品的编辑入口并进入编辑页
      const opened = await wc
        .executeJavaScript(
          `(()=>{const visible=e=>!!e&&e.getClientRects&&e.getClientRects().length>0;
            const title=${JSON.stringify(title)};
            const rows=[...document.querySelectorAll('*')].filter(e=>visible(e)&&(e.textContent||'').trim()===title);
            for(const row of rows){
              let scope=row;
              for(let i=0;i<8&&scope;i++){
                const edit=[...scope.querySelectorAll('a,span,div,button')].find(e=>visible(e)&&${JSON.stringify(entryPattern.source)}.split('|').map(p=>new RegExp('^(?:'+p+')$')).some(re=>re.test((e.textContent||'').trim())));
                if(edit){const href=edit.closest('a')?.href||'';if(href)return href;(edit.closest('button')||edit).click();return 'clicked';}
                scope=scope.parentElement;
              }
            }
            return '';})()`,
        )
        .catch(() => "");
      result.entry = opened;
      if (opened === "clicked") await sleep(8000);
      else if (opened) {
        await wc.loadURL(opened).catch(() => undefined);
        await sleep(8000);
      }
      result.url = wc.getURL();
      // 抖音的"编辑作品"是弹窗、小红书是整页：主 frame + 全部子 frame 一起扫
      const stateScript = `(()=>{const visible=e=>!!e&&e.getClientRects&&e.getClientRects().length>0;
        const labels=[...document.querySelectorAll('*')].filter(e=>visible(e)&&!/ /.test((e.textContent||'').trim())&&/原创/.test((e.textContent||'').trim())&&(e.textContent||'').trim().length<=12);
        const out=labels.slice(0,8).map(l=>{
          let scope=l;
          for(let i=0;i<5&&scope;i++){
            const c=scope.querySelector&&scope.querySelector('input[type=checkbox],[role=switch],[class*=switch],[class*=checkbox]');
            if(c)return{label:(l.textContent||'').trim(),checked:c.checked!==undefined?!!c.checked:(c.getAttribute('aria-checked')==='true'),tag:c.tagName,cls:String(c.className||'').slice(0,100),html:(c.outerHTML||'').slice(0,220)};
            scope=scope.parentElement;
          }
          return{label:(l.textContent||'').trim(),checked:null,html:(l.outerHTML||'').slice(0,220)};
        });
        const body=(document.body?.innerText||'');
        return{url:location.href,labels:out,bodyHasOriginal:/声明原创|原创声明|标记为原创|作品声明/.test(body),snippet:body.split('\\n').filter(line=>/原创|声明/.test(line)).slice(0,12)};})()`;
      const frames = [wc.mainFrame, ...wc.mainFrame.framesInSubtree];
      const states = await Promise.all(
        frames.map((frame) =>
          frame
            .executeJavaScript(stateScript)
            .catch((error) => ({ error: String(error) })),
        ),
      );
      const merged = states.filter(
        (item: any) => item && (item.labels?.length || item.bodyHasOriginal),
      );
      result.state = merged.length
        ? merged
        : { note: "编辑页未发现原创相关控件", frames: states.length };
    } catch (error) {
      result.error = String(error);
    } finally {
      await wc.loadURL(backUrl).catch(() => undefined);
    }
    return result;
  }
  private async waitForResult(
    wc: Electron.WebContents,
    platform: Account["platform"],
    timeout: number,
  ) {
    const patterns: Partial<Record<Account["platform"], RegExp>> = {
      douyin: /creator-micro\/content\/manage/,
      kuaishou: /article\/manage\/video/,
      xiaohongshu: /publish\/success/,
      weixin: /platform\/post\/list|\/post\/list/,
      toutiao: /profile_v4\/manage\/content(?:\/all)?/,
      bilibili: /platform\/upload\/video\/(success|manage)/,
    };
    const start = Date.now();
    let challengeSeen = false,
      challengeEvidence = "",
      lastChallenge = "",
      challengeRequested = false;
    while (Date.now() - start < timeout) {
      const url = wc.getURL();
      if (platform === "weixin") {
        const postCreate = this.weixinPostCreateResults.get(wc.id);
        if (postCreate && !postCreate.ok)
          return {
            success: false,
            challenge: false,
            message:
              "视频号 post_create 返回失败：errCode=" +
              String(postCreate.errCode ?? "unknown") +
              " body=" +
              postCreate.body,
          };
        if (postCreate?.ok && /platform\/post\/create/.test(url)) {
          await wc
            .loadURL("https://channels.weixin.qq.com/platform/post/list")
            .catch((error) => {
              if (!/ERR_ABORTED/.test(String(error))) throw error;
            });
          await sleep(2500);
        }
      }
      if (patterns[platform]?.test(url))
        return {
          success: true,
          challenge: false,
          message: "已跳转到平台作品管理页，正在核验目标标题：" + url,
        };
      if (platform === "weixin") {
        await sleep(2000);
        continue;
      }
      const state = await wc.executeJavaScript(
        "(()=>{const text=(document.body?.innerText||'').slice(-12000);const success=/\u53d1\u5e03\u6210\u529f|\u6295\u7a3f\u6210\u529f|\u7a3f\u4ef6\u6295\u9012\u6210\u529f|\u53d1\u8868\u6210\u529f|\u4f5c\u54c1\u53d1\u5e03\u6210\u529f|\u63d0\u4ea4\u6210\u529f|\u5df2\u53d1\u5e03/.test(text);const visible=e=>!!e&&e.offsetParent!==null;const challengeTexts=[...document.querySelectorAll('div,span,p,h1,h2,h3,button')].filter(visible).map(e=>(e.textContent||'').trim()).filter(value=>value&&value.length<240&&/验证码|安全验证|扫码验证|手机验证/.test(value));const challengeText=challengeTexts.sort((a,b)=>a.length-b.length)[0]||'';const challenge=!!challengeText;const failed=/发布失败|投稿失败|上传失败|提交失败/.test(text);return{success,challenge,challengeText,failed,text:text.slice(-500)}})()",
      );
      if (state.challenge) {
        challengeSeen = true;
        lastChallenge = state.challengeText || "";
        if (!challengeEvidence)
          challengeEvidence = await this.captureFailure(wc, platform).catch(
            () => "",
          );
        if (!challengeRequested) {
          challengeRequested = await wc
            .executeJavaScript(
              "(()=>{const button=[...document.querySelectorAll('button,div,span')].find(e=>e.offsetParent!==null&&(e.textContent||'').trim()==='获取验证码');if(!button)return false;(button.closest('button')||button).click();return true})()",
            )
            .catch(() => false);
        }
        const owner = BrowserWindow.fromWebContents(wc);
        if (owner && !owner.isDestroyed()) {
          owner.setOpacity(1);
          owner.setAlwaysOnTop(true, "screen-saver");
          owner.show();
          owner.focus();
        }
        await sleep(2000);
        continue;
      }
      if (state.failed)
        return {
          success: false,
          challenge: false,
          message: "平台返回发布失败：" + state.text,
        };
      if (
        state.success &&
        (platform === "xiaohongshu" ||
          platform === "bilibili" ||
          platform === "toutiao")
      )
        return {
          success: true,
          challenge: false,
          message: "平台页面已确认发布成功",
        };
      await sleep(2000);
    }
    return {
      success: false,
      challenge: challengeSeen,
      message: challengeSeen
        ? "平台安全验证未在等待时间内完成：" +
          lastChallenge +
          (challengeEvidence ? "；现场截图：" + challengeEvidence : "")
        : "",
    };
  }
  private async getLoginState(account: Account, wc: Electron.WebContents) {
    const url = wc.getURL();
    const host = (() => {
      try {
        return new URL(url).hostname;
      } catch {
        return "";
      }
    })();
    // 记录账号当前所在的小红书店点，后续导航沿用该域名。
    if (account.platform === "xiaohongshu")
      this.xhsOrigins.set(account.id, xhsOriginFromUrl(url));
    try {
      const result = await wc.executeJavaScript(
        "(()=>{const visible=e=>!!e&&e.offsetParent!==null;const bodyText=document.body?.innerText||'';const text=bodyText.slice(0,12000);const selectors=['[class*=user-name]','[class*=username]','[class*=nickname]','[class*=account-name]','[class*=userName]','[class*=nickName]'];let name='';for(const selector of selectors){const node=[...document.querySelectorAll(selector)].find(visible);const value=node?.textContent?.trim();if(value&&value.length>1&&value.length<40){name=value;break}}const loginRoots=[...document.querySelectorAll('main#login-form,.login-box-container,[class*=login-box],[class*=login-container],[class*=qrcode],[class*=qr-code]')].filter(visible);const visibleLogin=loginRoots.length>0||[...document.querySelectorAll('img[alt*=qrcode i],img[src*=qrcode i]')].some(visible);const loginText=/扫码登录|手机号登录|验证码登录|QQ登录|微信登录|APP扫一扫登录/.test(text);return{name,visibleLogin,loginText,text}})()",
      );
      const stableKuaishouName =
        account.platform === "kuaishou"
          ? await wc
              .executeJavaScript(
                "(()=>{const visible=e=>!!e&&e.offsetParent!==null;const invalid=/^(首页|内容管理|互动管理|数据中心|发布作品|创作服务|其他服务|快手|登录|注册|设置|消息|数据|作品|管理)$/;const selectors=['header [class*=name]','header [class*=nickname]','header [class*=user]','aside [class*=name]','[class*=user-info] [class*=name]','[class*=userInfo] [class*=name]','[data-testid*=user]','[data-testid*=nickname]'];for(const selector of selectors){for(const node of document.querySelectorAll(selector)){if(!visible(node))continue;const value=(node.textContent||'').trim().replace(/\\s+/g,' ');if(value.length>1&&value.length<30&&!invalid.test(value)&&!/[|｜]/.test(value)&&!/(发布|内容|数据|作品|管理|设置|登录|平台)/.test(value))return value}}return ''})()",
              )
              .catch(() => "")
          : "";
      let loggedIn = false;
      if (account.platform === "kuaishou")
        loggedIn = host === "cp.kuaishou.com" && !result.visibleLogin;
      if (account.platform === "douyin")
        loggedIn =
          host === "creator.douyin.com" &&
          !result.visibleLogin &&
          !result.loginText;
      if (account.platform === "xiaohongshu")
        loggedIn =
          (host === "creator.xiaohongshu.com" ||
            host === "creator.rednote.com") &&
          !result.visibleLogin;
      if (account.platform === "weixin")
        loggedIn = (() => {
          const pathname = (() => {
            try {
              return new URL(url).pathname;
            } catch {
              return "";
            }
          })();
          const workspaceRoute = /^\/platform(?:\/|$)/.test(pathname);
          const workspaceText =
            /发表视频|内容管理|数据概览|动态管理|视频号助手|创作管理|数据中心/.test(
              result.text,
            );
          return (
            host === "channels.weixin.qq.com" &&
            !result.visibleLogin &&
            !result.loginText &&
            (workspaceRoute || workspaceText)
          );
        })();
      if (account.platform === "toutiao")
        loggedIn =
          /mp.toutiao.com$/.test(host) &&
          !result.visibleLogin &&
          !result.loginText;
      if (account.platform === "bilibili")
        loggedIn =
          host === "member.bilibili.com" &&
          !result.visibleLogin &&
          !result.loginText;
      if (account.platform === "qqmedia")
        loggedIn =
          host === "om.qq.com" &&
          !result.visibleLogin &&
          !result.loginText &&
          /内容管理|发布|数据/.test(result.text);
      return {
        loggedIn,
        pending:
          !loggedIn &&
          (result.visibleLogin ||
            result.loginText ||
            /login|passport|signin|auth/i.test(url) ||
            result.text.trim().length < 20),
        name:
          account.platform === "kuaishou" ? stableKuaishouName : result.name,
      };
    } catch {
      return { loggedIn: false, pending: false, name: "" };
    }
  }
  private async inspectAccount(
    account: Account,
    view: WebContentsView,
    expectedVersion?: number,
  ) {
    if (
      expectedVersion !== undefined &&
      this.inspectVersions.get(account.id) !== expectedVersion
    )
      return;
    if (view.webContents.isLoading()) {
      this.scheduleInspect(account, view);
      return;
    }
    const state = await this.getLoginState(account, view.webContents);
    if (
      expectedVersion !== undefined &&
      this.inspectVersions.get(account.id) !== expectedVersion
    )
      return;
    if (state.pending) {
      void writeBrowserLog(
        `login-pending account=${account.id} url=${view.webContents.getURL()}`,
      );
      await this.updateAccount(account.id, { loginStatus: "checking" });
      const previous = this.inspectTimers.get(account.id);
      if (previous) clearTimeout(previous);
      const version = this.inspectVersions.get(account.id) || 0;
      const timer = setTimeout(() => {
        this.inspectTimers.delete(account.id);
        void this.inspectAccount(account, view, version);
      }, 1800);
      this.inspectTimers.set(account.id, timer);
      return;
    }
    if (!state.loggedIn) {
      void writeBrowserLog(
        `login-failed account=${account.id} url=${view.webContents.getURL()}`,
      );
      await this.updateAccount(account.id, { loginStatus: "logged_out" });
      return;
    }
    // QR-login cookies and Web Storage are written asynchronously. Persist them
    // before marking the account logged in so an upgrade/exit cannot lose them.
    await this.flushAccountSession(account.id, "login-detected");
    await this.updateAccount(account.id, {
      loginStatus: "logged_in",
      ...(state.name ? { name: state.name } : {}),
    });
    void writeBrowserLog(
      `login-success account=${account.id} url=${view.webContents.getURL()} name=${state.name || ""}`,
    );
  }
  hide() {
    if (!this.active) return;
    const v = this.views.get(this.active);
    if (v && this.win.contentView.children.includes(v))
      this.win.contentView.removeChildView(v);
    this.active = undefined;
  }
  async close(id: string) {
    const timer = this.inspectTimers.get(id);
    if (timer) clearTimeout(timer);
    this.inspectTimers.delete(id);
    this.inspectVersions.delete(id);
    const v = this.views.get(id);
    if (!v) return;
    if (this.win.contentView.children.includes(v))
      this.win.contentView.removeChildView(v);
    await this.flushAccountSession(id, "view-close");
    v.webContents.close();
    this.views.delete(id);
    if (this.active === id) this.active = undefined;
  }
  setBounds(b: BrowserBounds) {
    this.bounds = {
      x: Math.max(0, Math.round(b.x)),
      y: Math.max(0, Math.round(b.y)),
      width: Math.max(100, Math.round(b.width)),
      height: Math.max(100, Math.round(b.height)),
    };
    if (this.active) this.views.get(this.active)?.setBounds(this.bounds);
  }
  navigate(action: "back" | "forward" | "reload" | "home", account?: Account) {
    if (!this.active) return;
    const wc = this.views.get(this.active)?.webContents;
    if (!wc) return;
    if (action === "back" && wc.canGoBack()) wc.goBack();
    if (action === "forward" && wc.canGoForward()) wc.goForward();
    if (action === "reload") wc.reload();
    if (action === "home" && account)
      wc.loadURL(
        account.platform === "xiaohongshu"
          ? this.xhsUrl(account, "/")
          : platformMap[account.platform].homeUrl,
      );
  }
  async remove(id: string) {
    await this.close(id);
  }
  async destroy() {
    for (const timer of this.inspectTimers.values()) clearTimeout(timer);
    this.inspectTimers.clear();
    this.inspectVersions.clear();
    await Promise.all(
      Array.from(this.views.keys(), (accountId) =>
        this.flushAccountSession(accountId, "application-shutdown"),
      ),
    );
    for (const v of this.views.values()) v.webContents.close();
    this.views.clear();
  }
}
