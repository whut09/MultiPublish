import { app, BrowserWindow, WebContentsView, session, shell } from "electron";
import { promises as fs } from "node:fs";
import path from "node:path";
import type {
  Account,
  BrowserBounds,
  LoginStatus,
  PublishDraft,
  TaskStatus,
} from "../shared/types";
import { platformMap } from "../shared/platforms";
type AccountUpdate = { name?: string; loginStatus?: LoginStatus };
type PublishProgress = (status: TaskStatus, message: string) => Promise<void>;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
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
      /((?:cookie|sessionid|token|findertoken|encfilekey)["']?\s*[:=]\s*["']?)[^"'&\s,}]+/gi,
      "$1[redacted]",
    )
    .replace(/([?&](?:token|findertoken|encfilekey)=)[^&\s]+/gi, "$1[redacted]")
    .slice(0, limit);
export const chromeUserAgent =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36";
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
  private weixinPublishPoints = new Map<number, { x: number; y: number }>();
  private weixinPostCreateResults = new Map<
    number,
    { ok: boolean; errCode?: number; body: string }
  >();
  private weixinPostListTitles = new Map<number, string[]>();
  private active?: string;
  private bounds: BrowserBounds = { x: 280, y: 160, width: 900, height: 650 };
  constructor(
    private win: BrowserWindow,
    private updateAccount: (id: string, update: AccountUpdate) => Promise<void>,
  ) {}
  private accountSession(accountId: string) {
    return session.fromPartition("persist:account-" + accountId);
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
        target === "publish" ? p.publishUrl : p.homeUrl,
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
  async autoPublish(
    account: Account,
    draft: PublishDraft,
    progress: PublishProgress,
  ) {
    const videoPath = draft.mediaPaths[0];
    if (!videoPath)
      return { status: "failed" as const, message: "草稿没有选择视频文件" };
    const videoStat = await fs.stat(videoPath).catch(() => undefined);
    if (!videoStat?.isFile() || videoStat.size < 1024)
      return {
        status: "failed" as const,
        message: "视频文件不存在或为空：" + videoPath,
      };
    const requiresVisibleWindow = account.platform === "weixin";
    const automationWindow = new BrowserWindow({
      show: true,
      skipTaskbar: !requiresVisibleWindow,
      autoHideMenuBar: true,
      title: requiresVisibleWindow ? "MultiPublish - 视频号发布" : "MultiPublish",
      ...(requiresVisibleWindow ? {} : { x: -10000, y: -10000 }),
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
    // WeChat's Wujie content app does not reliably bootstrap in a transparent
    // off-screen window. Keep that publisher genuinely visible and focused.
    if (requiresVisibleWindow) {
      automationWindow.center();
      automationWindow.setOpacity(1);
      automationWindow.show();
      automationWindow.focus();
    } else {
      automationWindow.setOpacity(0.01);
    }
    const wc = automationWindow.webContents;
    wc.setUserAgent(chromeUserAgent);
    wc.setAudioMuted(true);
    if (requiresVisibleWindow) wc.focus();
    let weixinDiagnosticListener:
      | ((_event: Electron.Event, method: string, params: any) => void)
      | undefined;
    const weixinDiagnosticRequests = new Map<
      string,
      { method: string; url: string }
    >();
    try {
      await progress(
        "opening",
        "正在进入" + platformMap[account.platform].name + "发布页面",
      );
      await wc
        .loadURL(platformMap[account.platform].publishUrl)
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
        this.weixinPublishPoints.delete(wc.id);
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
            )
              this.weixinRemoteUploadAt.set(wc.id, Date.now());
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
            if (requestMethod && requestMethod !== "GET") {
              const relevant =
                /(?:post|publish|create|finderassistant|mmfinderassistant|cgi-bin)/i.test(
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
                postData: redactWeixinDiagnostic(request.postData),
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
      if (
        account.platform === "weixin" &&
        process.env.MULTIPUBLISH_PUBLISH_SELF_TEST_DRAFT_ID === draft.id
      ) {
        await progress("opening", "正在检查视频号后台，防止重复发布");
        const existing = await this.verifyPublishedTitle(
          wc,
          account.platform,
          draft.title,
          20000,
        );
        if (existing.ok)
          return {
            status: "success" as const,
            message: "视频号后台已存在目标标题，未重复发布",
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
        await this.chooseFileFromInput(
          wc,
          videoInput.nodeId,
          draft.mediaPaths[0],
        );
        videoNodeId = videoInput.nodeId;
      } else {
        const inputs = await this.waitForFileInputs(wc, 60000);
        if (!inputs.length && account.platform === "douyin") {
          await this.chooseFileFromButton(wc, "douyin", draft.mediaPaths[0]);
          videoNodeId = -1;
        } else {
          if (!inputs.length) {
            const login = await this.getLoginState(account, wc);
            return {
              status: "manual_required" as const,
              message: login.loggedIn
                ? "Video upload control not found"
                : "Login required",
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
        const uploadStart = Date.now();
        let uploadFinished = false;
        while (Date.now() - uploadStart < 30000) {
          const uploadState = await wc.executeJavaScript(
            "(()=>{const visible=e=>!!e&&e.offsetParent!==null;const fields=[...document.querySelectorAll('input,textarea,[contenteditable=true]')].filter(visible);const title=fields.find(e=>/标题|稿件标题|视频标题/.test(e.getAttribute('placeholder')||''));const declaration=fields.find(e=>/创建声明|创作声明|自制声明/.test(e.getAttribute('placeholder')||''));const anchors=[title,declaration,fields.find(e=>/立即投稿|投稿类型/.test(e.parentElement?.innerText||''))].filter(Boolean);const root=anchors[0]?.closest('form,[class*=upload],[class*=投稿],[class*=editor]')||anchors[0]?.parentElement;const text=(root?.innerText||anchors.map(e=>e?.parentElement?.innerText||'').join('\\n')||'').slice(0,12000);const failed=/上传失败|转码失败|无视频流信息/.test(text);const editorReady=!!title||!!declaration||/立即投稿|投稿类型|自制声明|视频封面|添加标签/.test(text);const completed=!failed&&(editorReady||/上传完成|已上传|视频预览/.test(text));const uploading=!completed&&/上传中|剩余时间|当前速度|上传进度/.test(text);return{completed,uploading,failed,text}})()",
          );
          if (uploadState.failed) throw new Error("B站平台返回视频上传失败");
          // waitForEditor has already confirmed the editable form. Bilibili
          // often leaves a stale progress label in the DOM after completion.
          if (uploadState.completed || !uploadState.uploading) {
            uploadFinished = true;
            break;
          }
          await sleep(1500);
        }
        if (!uploadFinished)
          throw new Error("B站视频上传未在等待时间内完成，请检查平台处理状态");
      }
      if (account.platform !== "douyin")
        await this.fillContent(wc, draft, account.platform);
      if (account.platform === "bilibili") {
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
        const declarationDom = await wc.debugger.sendCommand(
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
        const declarationInputs = [] as Array<{
          nodeId: number;
          backendNodeId: number;
          x: number;
          y: number;
          area: number;
        }>;
        for (const node of declarationAll.filter(
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
                ? declarationMap.get(current.parentId)
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
              declarationInputs.push({
                nodeId: node.nodeId,
                backendNodeId: node.backendNodeId || node.nodeId,
                x: xs.reduce((sum, value) => sum + value, 0) / 4,
                y: ys.reduce((sum, value) => sum + value, 0) / 4,
                area: width * height,
              });
          } catch {}
        }
        declarationInputs.sort((a, b) => b.area - a.area);
        const declarationInput = declarationInputs[0];
        if (!declarationInput)
          throw new Error("Bilibili visible declaration input not found");
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
        const declarationClick = await this.clickSmallestByText(
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
        if (!declarationClick || !declarationValue)
          throw new Error(
            "Bilibili declaration selection failed: " +
              JSON.stringify({
                declarationClick,
                declarationValue,
                declarationInput: { x: declarationX, y: declarationY },
              }),
          );
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
            throw new Error(
              "Bilibili cover upload control not found after retries",
            );
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
      if (account.platform === "douyin") {
        await sleep(1200);
        if (!wc.debugger.isAttached()) wc.debugger.attach("1.3");
        await wc.debugger.sendCommand("DOM.enable");
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
        await this.fillContent(wc, draft, "toutiao");
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
          if (!localCoverInput) {
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
          const editorConfirmed = await this.clickButtonByText(
            wc,
            ["裁剪完成", "完成", "确定", "保存"],
            true,
            true,
          );
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
            // A custom cover is optional; platform UI changes must not block
            // an otherwise valid video submission.
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
      const publishTimeout =
        account.platform === "douyin" || account.platform === "toutiao"
          ? 600000
          : 180000;
      const ready =
        account.platform === "xiaohongshu"
          ? await this.waitForXhsPublishReady(wc, publishTimeout)
          : await this.waitForPublishReady(
              wc,
              account.platform,
              publishTimeout,
            );
      if (!ready) {
        const douyinDiagnostics =
          account.platform === "douyin"
            ? await wc
                .executeJavaScript(
                  "(()=>JSON.stringify({url:location.href,fields:[...document.querySelectorAll('input,textarea,[contenteditable=true]')].map(e=>{const r=e.getBoundingClientRect();return{tag:e.tagName,type:e.type||'',placeholder:e.getAttribute('placeholder')||'',contenteditable:e.getAttribute('contenteditable'),value:typeof e.value==='string'?e.value:(e.textContent||''),visible:!!e.offsetParent,rect:{x:r.x,y:r.y,width:r.width,height:r.height},html:(e.outerHTML||'').slice(0,800)}}),buttons:[...document.querySelectorAll('button,[role=button]')].map(e=>({text:(e.textContent||'').trim(),disabled:!!e.disabled,ariaDisabled:e.getAttribute('aria-disabled'),visible:!!e.offsetParent})).filter(e=>e.visible).slice(-80),body:(document.body?.innerText||'').slice(0,12000)}))()",
                )
                .catch((error) => "诊断失败：" + String(error))
            : "";
        throw new Error(
          account.platform === "xiaohongshu"
            ? "小红书真实发布按钮持续禁用，请检查视频处理、标题、正文、封面或平台校验提示"
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
      if (account.platform === "weixin") {
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
                ? 30000
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
      if (verified.ok)
        return {
          status: "success" as const,
          message:
            platformMap[account.platform].name +
            "作品管理已找到目标标题，发布成功：" +
            verified.url,
        };
      if (result.success) {
        const evidence = await this.captureFailure(wc, account.platform).catch(
          () => undefined,
        );
        return {
          status: "failed" as const,
          message:
            (verified.reason || "平台后台未找到目标作品") +
            (evidence ? "；现场截图：" + evidence : ""),
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
      this.weixinPublishPoints.delete(wc.id);
      this.weixinPostCreateResults.delete(wc.id);
      this.weixinPostListTitles.delete(wc.id);
      if (weixinDiagnosticListener)
        wc.debugger.removeListener("message", weixinDiagnosticListener);
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
      weixinPoint &&
      texts.some((text) => /发布|发表/.test(text))
    ) {
      await wc.debugger.sendCommand("Input.dispatchMouseEvent", {
        type: "mouseMoved",
        x: weixinPoint.x,
        y: weixinPoint.y,
      });
      await wc.debugger.sendCommand("Input.dispatchMouseEvent", {
        type: "mousePressed",
        x: weixinPoint.x,
        y: weixinPoint.y,
        button: "left",
        buttons: 1,
        clickCount: 1,
      });
      await sleep(120);
      await wc.debugger.sendCommand("Input.dispatchMouseEvent", {
        type: "mouseReleased",
        x: weixinPoint.x,
        y: weixinPoint.y,
        button: "left",
        buttons: 0,
        clickCount: 1,
      });
      await writeBrowserLog(
        "weixin-publish-click " + JSON.stringify(weixinPoint),
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
      const clicked = await this.clickButtonByText(
        wc,
        ["上传视频", "点击上传视频", "选择视频", "点击上传", "上传文件", "选择文件"],
        false,
        true,
      );
      if (!clicked) {
        const fallbackClicked = await wc
          .executeJavaScript(
            "(()=>{const visible=e=>!!e&&e.getClientRects?.().length>0&&getComputedStyle(e).visibility!=='hidden';const all=root=>{const r=[];for(const e of root.querySelectorAll('*')){r.push(e);if(e.shadowRoot)r.push(...all(e.shadowRoot))}return r};const nodes=all(document).filter(visible);const target=nodes.filter(e=>/上传|选择|拖拽/.test((e.textContent||'')+' '+(e.getAttribute('aria-label')||'')+' '+(e.getAttribute('title')||''))&&/视频|文件|video|upload/i.test((e.textContent||'')+' '+(e.getAttribute('aria-label')||'')+' '+(e.getAttribute('title')||'')+' '+String(e.className||''))).sort((a,b)=>{const ar=a.getBoundingClientRect(),br=b.getBoundingClientRect();return ar.width*ar.height-br.width*br.height})[0];if(!target)return false;target.click();return true})()",
          )
          .catch(() => false);
        if (!fallbackClicked)
          throw new Error("Bilibili current upload button not found");
      }
      const chooserStart = Date.now();
      while (Date.now() - chooserStart < 30000) {
        if (chooserNodeId) {
          await this.setFileInput(wc, chooserNodeId, [file]);
          return chooserNodeId;
        }
        await sleep(200);
      }
      const currentInput = await this.waitForBilibiliVideoInput(wc, 15000);
      if (!currentInput)
        throw new Error("Bilibili current video upload control not found");
      await this.setFileInput(wc, currentInput.nodeId, [file]);
      return currentInput.nodeId;
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
        await wc.debugger.sendCommand("DOM.focus", {
          backendNodeId: titleNode.backendNodeId,
        });
        await wc.debugger.sendCommand("Input.dispatchKeyEvent", {
          type: "rawKeyDown",
          key: "a",
          code: "KeyA",
          windowsVirtualKeyCode: 65,
          modifiers: 2,
        });
        await wc.debugger.sendCommand("Input.dispatchKeyEvent", {
          type: "keyDown",
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
        await wc.debugger.sendCommand("Input.insertText", { text: title });
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
      const titleState = await wc
        .executeJavaScript(
          "(()=>{const visible=e=>!!e&&e.getClientRects?.().length>0&&getComputedStyle(e).visibility!=='hidden';const e=[...document.querySelectorAll('input')].find(e=>visible(e)&&/0[～-]30|标题/.test(e.placeholder||''));return{value:e?.value||'',placeholder:e?.placeholder||''}})()",
        )
        .catch(() => ({ value: "", placeholder: "" }));
      await writeBrowserLog(
        "toutiao-content-typed " +
          JSON.stringify({ genericFilled, titleState, expectedTitle: title }),
      );
      if (titleState.value !== title)
        throw new Error(
          "头条标题输入未生效：" +
            JSON.stringify({ titleState, expectedTitle: title }),
        );
    }
  }
  private async waitForPublishReady(
    wc: Electron.WebContents,
    platform: Account["platform"],
    timeout: number,
  ) {
    const start = Date.now();
    let lastDiagnosticAt = 0;
    while (Date.now() - start < timeout) {
      if (platform === "weixin") {
        const remoteUploadAt = this.weixinRemoteUploadAt.get(wc.id) || 0;
        const remoteUploadAge = remoteUploadAt
          ? Date.now() - remoteUploadAt
          : 0;
        if (!remoteUploadAt || remoteUploadAge < 8000) {
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
          const text =
            nodes.map((node) => node.nodeValue || "").join(" ") +
            " " +
            nodes.map((node) => (node.attributes || []).join(" ")).join(" ");
          const uploading = /上传中|正在上传|转码中|上传进度|处理中/.test(text);
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
                  publish = true;
                  publishNodeId = current.nodeId;
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
        } catch {}
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
    const managerUrl = managerUrls[platform];
    if (!managerUrl)
      return {
        ok: false,
        url: wc.getURL(),
        reason: platformMap[platform].name + "尚未配置后台标题验真",
      };
    if (platform === "weixin") {
      try {
        if (!wc.debugger.isAttached()) wc.debugger.attach("1.3");
        await wc.debugger.sendCommand("Page.enable");
        await wc.debugger.sendCommand("Page.addScriptToEvaluateOnNewDocument", {
          source: weixinPostListRecorder,
        });
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
    const expected = [
      normalizedTitle,
      normalizedTitle.slice(0, 24),
      normalizedTitle.slice(0, 20),
      normalizedTitle.slice(0, 16),
      normalizedTitle.slice(0, 12),
    ].filter((value) => value.length >= 2);
    const start = Date.now();
    let lastUrl = "";
    while (Date.now() - start < timeout) {
      await wc.loadURL(managerUrl).catch((error) => {
        if (!/ERR_ABORTED/.test(String(error))) throw error;
      });
      await sleep(7000);
      if (platform === "xiaohongshu") {
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
          if (exactEvidence.some((value: unknown) => value === title))
            return { ok: true, url: wc.getURL() };
        }
        const snapshot = await wc
          .executeJavaScript(
            "(()=>{const all=root=>{const result=[];for(const e of root.querySelectorAll('*')){result.push(e);if(e.shadowRoot)result.push(...all(e.shadowRoot))}return result};const text=((document.body?.innerText||'')+' '+all(document).map(e=>e.shadowRoot?(e.shadowRoot.innerText||e.shadowRoot.textContent||''):'').join(' ')).slice(0,120000);return{url:location.href,text,login:/扫码登录|手机号登录|验证码登录|短信登录|密码登录|立即登录/.test(text)||location.pathname.includes('/login')||location.pathname.includes('/auth')}})()",
          )
          .catch(() => ({ url: wc.getURL(), text: "", login: false }));
        lastUrl = snapshot.url;
        if (snapshot.login)
          return {
            ok: false,
            url: snapshot.url,
            reason: platformMap[platform].name + "作品管理要求重新登录",
          };
        const rawExpected =
          platform === "weixin"
            ? [platformTitle]
            : [
                platformTitle,
                Array.from(platformTitle).slice(0, 24).join(""),
                Array.from(platformTitle).slice(0, 20).join(""),
                Array.from(platformTitle).slice(0, 16).join(""),
                Array.from(platformTitle).slice(0, 12).join(""),
              ].filter((value) => value.length >= 2);
        const normalizedText = normalize(snapshot.text);
        if (
          rawExpected.some((value) => snapshot.text.includes(value)) ||
          (platform === "weixin"
            ? normalizedText.includes(normalizedTitle)
            : expected.some((value) => normalizedText.includes(value)))
        )
          return { ok: true, url: snapshot.url };
        await sleep(3000);
      }
    }
    return {
      ok: false,
      url: lastUrl || wc.getURL(),
      reason: platformMap[platform].name + "作品管理未找到目标标题",
    };
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
        (platform === "xiaohongshu" || platform === "bilibili")
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
        loggedIn = host === "creator.xiaohongshu.com" && !result.visibleLogin;
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
      wc.loadURL(platformMap[account.platform].homeUrl);
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
