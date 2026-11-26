// Every static text of the authorization pages (docs/zh-CN/spec/05-surfaces.md §15 «远程授权»), here
// and nowhere else, in English and in Chinese: a page is in Chinese when the browser's first
// language starts with `zh`, in English otherwise. No text holds a token; what a client says of
// itself, a user's name and a connection's name are passed in and escaped where the page is made.
//
// Words: to a person, "connection instance" (as the CLI says), and "saveslot".

import type { pageLanguage, Scope } from "@fluxvita/saveslot-service";

export type Lang = ReturnType<typeof pageLanguage>;

/** The page's language, as the identity provider's pages choose it. */
export { pageLanguage as langOf } from "@fluxvita/saveslot-service";

export interface OAuthTexts {
  readonly htmlLang: string;
  /** What goes between two sentences: a space in English, nothing in Chinese. */
  readonly gap: string;
  readonly title: string;
  readonly signedInAs: (name: string) => string;
  readonly switchAccount: string;
  /** `client` and `host` are escaped by the caller. */
  readonly asksAccess: (client: string, host: string) => string;
  readonly redirectsTo: (host: string) => string;
  readonly cliAsks: string;
  readonly nameLabel: string;
  readonly nameHint: string;
  readonly scopesLabel: string;
  readonly scope: Readonly<Record<Scope, string>>;
  readonly allSlots: string;
  readonly allow: string;
  readonly allowCli: string;
  readonly deny: string;
  readonly errorTitle: string;
  readonly errors: {
    readonly client: string;
    readonly clientLimited: string;
    readonly clientBusy: string;
    readonly redirect: string;
    readonly tooLong: string;
    readonly form: string;
    readonly user: string;
    readonly tenant: string;
    readonly name: string;
    readonly nameTaken: string;
    readonly scopes: string;
    readonly internal: string;
  };
  /** The device code's verification page (`saveslot login --device`). */
  readonly device: {
    readonly title: string;
    readonly explain: string;
    readonly codeLabel: string;
    readonly codeHint: string;
    readonly approve: string;
    readonly deny: string;
    readonly wrongCode: string;
    readonly limited: string;
    readonly approved: string;
    readonly denied: string;
  };
}

const EN: OAuthTexts = {
  htmlLang: "en",
  gap: " ",
  title: "Authorize access to saveslot",
  signedInAs: (name) => `Signed in as ${name}.`,
  switchAccount: "Not you? Sign in with another account.",
  asksAccess: (client, host) => `${client} (${host}) wants access to your saveslot.`,
  redirectsTo: (host) => `You will return to ${host}.`,
  cliAsks: "The saveslot command line wants to sign in as you.",
  nameLabel: "Connection instance name",
  nameHint: "Shown in history, pending items and the read audit.",
  scopesLabel: "Permissions",
  scope: {
    "saveslot.read": "Read records (required)",
    "saveslot.write": "Write records",
    "saveslot.schema": "Create slots and change their structure",
    "saveslot.delete": "Delete records",
  },
  allSlots: "Applies to every slot, including new ones.",
  allow: "Authorize",
  allowCli: "Sign in",
  deny: "Deny",
  errorTitle: "This request can't be used",
  errors: {
    client: "This app's client ID isn't one saveslot can use.",
    clientLimited: "Too many requests. Try again later.",
    clientBusy: "saveslot is busy. Try again in a moment.",
    redirect: "The app asked to return to an address it didn't register. Nothing was sent.",
    tooLong: "The request is too long.",
    form: "This form expired or was already sent. Start again from the app.",
    user: "This account can't authorize access.",
    tenant: "This account has no saveslot data yet.",
    name: "Use a name of 1 to 100 characters, without line breaks.",
    nameTaken: "That name is taken. Choose another.",
    scopes: "These permissions weren't offered in this request.",
    internal: "Something went wrong. Try again later.",
  },
  device: {
    title: "Sign in the saveslot command line",
    explain:
      "This gives the command line full access to your saveslot. Approve only if you ran saveslot login --device yourself and the code matches your terminal.",
    codeLabel: "Code from your terminal",
    codeHint: "8 letters, e.g. BCDF-GHJK.",
    approve: "Sign in the command line",
    deny: "Deny",
    wrongCode: "Code not found. Check your terminal: codes last 10 minutes.",
    limited: "Too many wrong codes. Try again later.",
    approved: "Signed in. You can close this page and return to your terminal.",
    denied: "Sign-in denied.",
  },
};

const ZH: OAuthTexts = {
  htmlLang: "zh-CN",
  gap: "",
  title: "授权访问 saveslot",
  signedInAs: (name) => `当前登录：${name}。`,
  switchAccount: "不是你？换一个账户登录。",
  asksAccess: (client, host) => `${client}（${host}）请求访问你的 saveslot。`,
  redirectsTo: (host) => `完成后回到 ${host}。`,
  cliAsks: "saveslot 命令行请求以你的身份登录。",
  nameLabel: "连接实例名称",
  nameHint: "会显示在历史、待处理事项和读取审计里。",
  scopesLabel: "权限",
  scope: {
    "saveslot.read": "读取记录（必需）",
    "saveslot.write": "写入记录",
    "saveslot.schema": "新建 slot、修改结构",
    "saveslot.delete": "删除记录",
  },
  allSlots: "适用于全部 slot，含以后新建的。",
  allow: "授权",
  allowCli: "登录",
  deny: "拒绝",
  errorTitle: "这个请求无法使用",
  errors: {
    client: "无法识别这个应用的客户端 ID。",
    clientLimited: "请求太多，请稍后再试。",
    clientBusy: "saveslot 正忙，请稍后再试。",
    redirect: "应用要求回到一个未登记的地址，没有发送任何内容。",
    tooLong: "请求太长。",
    form: "表单已过期或已提交，请回到应用重新开始。",
    user: "这个账户不能授权访问。",
    tenant: "这个账户还没有 saveslot 数据。",
    name: "名字需 1 到 100 个字符，不能换行。",
    nameTaken: "这个名字已被使用，请换一个。",
    scopes: "提交的权限不在这次请求的范围内。",
    internal: "出了点问题，请稍后再试。",
  },
  device: {
    title: "登录 saveslot 命令行",
    explain:
      "这会让命令行完全访问你的 saveslot。只在你自己运行了 saveslot login --device、且代码与终端一致时批准。",
    codeLabel: "终端里的代码",
    codeHint: "8 个字母，如 BCDF-GHJK。",
    approve: "登录命令行",
    deny: "拒绝",
    wrongCode: "代码无效。请核对终端，代码 10 分钟内有效。",
    limited: "错误次数太多，请稍后再试。",
    approved: "已登录。可以关闭此页，回到终端。",
    denied: "已拒绝登录。",
  },
};

/** The texts of the pages in `lang`. */
export function oauthTexts(lang: Lang): OAuthTexts {
  return lang === "zh" ? ZH : EN;
}
